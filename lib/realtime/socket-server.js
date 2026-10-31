/**
 * Socket.IO, attached to the same HTTP server as Next.js (one process, one
 * port, one Coolify service). Every handler:
 *   1. identifies the caller from the handshake cookies (never from payloads),
 *   2. validates the payload with zod,
 *   3. applies a rate limit,
 *   4. calls the TableManager, which enforces table membership, host rights
 *      and game rules, and replies through the ack callback.
 */
import { Server } from 'socket.io';
import { z } from 'zod';
import { TableManager } from '../game-engine/table-manager.js';
import { serverGames } from '../../games/server-registry.js';
import { viewerFromCookieHeader } from '../auth/identity.js';
import { viewerFromMobileToken } from '../auth/mobile-token.js';
import { createLimiter } from '../rate-limit.js';
import { recordMatch } from '../db/results.js';
import { areFriends } from '../db/social.js';
import { tableCosmetics } from '../db/cosmetics.js';
import { SOUND_ID } from '../sounds.js';
import { isSound } from '../sound-files.js';
import { pushIfOffline } from '../push/push.js';
import { config } from '../env.js';
import { log } from '../log.js';

const Code = z.string().trim().min(6).max(12);
const Options = z.object({
  ranked: z.boolean().optional(), visibility: z.enum(['public', 'private']).optional(),
  allowGuests: z.boolean().optional(), spectators: z.number().int().min(0).max(20).optional(),
}).optional();
const S = {
  create: z.object({ gameId: z.string().max(40), settings: z.record(z.string(), z.any()), options: Options }),
  code: z.object({ code: Code }),
  join: z.object({ code: Code, as: z.enum(['player', 'spectator']).optional() }),
  move: z.object({ code: Code, playerId: z.string().max(80), to: z.enum(['player', 'spectator']) }),
  emote: z.object({ code: Code, sound: z.string().regex(SOUND_ID) }),
  start: z.object({ code: Code, testCardsEach: z.number().int().min(1).max(13).optional() }),
  ready: z.object({ code: Code, ready: z.boolean() }),
  settings: z.object({ code: Code, settings: z.record(z.string(), z.any()).nullable().optional(), options: Options }),
  kick: z.object({ code: Code, playerId: z.string().max(80) }),
  addBot: z.object({ code: Code, botId: z.string().max(40).optional() }),
  chat: z.object({ code: Code, text: z.string().max(1000) }),
  invite: z.object({ code: Code, userIds: z.array(z.string().max(80)).min(1).max(20) }),
  action: z.object({
    code: Code,
    actionId: z.string().min(4).max(64),
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('play'), card: z.string().regex(/^(10|[2-9JQKA])[CDSH]$/) }),
      z.object({ type: z.literal('request') }),
      z.object({ type: z.literal('answer'), accept: z.boolean() }),
      z.object({ type: z.literal('back') }),
      z.object({ type: z.literal('away') }),
    ]),
  }),
};

/** A short but real deal for end-to-end tests: k cards each, A♠ always in play. */
function shortDeal(n, k) {
  const ids = [];
  for (const s of 'CDSH') for (const r of ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']) if (r + s !== 'AS') ids.push(r + s);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const pool = ['AS', ...ids.slice(0, n * k - 1)];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return Array.from({ length: n }, (_, i) => pool.slice(i * k, (i + 1) * k));
}

/** Presence: registered user id → number of open sockets. */
export const presence = new Map();

export function attachRealtime(httpServer) {
  const mobileOrigins = (process.env.MOBILE_WEB_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!config.isProd) mobileOrigins.push('http://localhost:8081', 'http://127.0.0.1:8081');
  const io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    // Same-origin by default; only APP_URL may open sockets from a browser.
    cors: { origin: [config.appUrl, ...mobileOrigins], credentials: true },
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 16_384,               // our messages are tiny
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, skipMiddlewares: false },
    destroyUpgrade: false,                   // let Next handle its own dev HMR upgrades
    perMessageDeflate: false,                // saves CPU; payloads are small
    // Refuse cross-site connections (another website opening a socket with a visitor's cookies).
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin) return cb(null, true);                       // non-browser clients
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      let ok = origin === config.appUrl || mobileOrigins.includes(origin);
      try { ok = ok || new URL(origin).host === host; } catch { ok = false; }
      cb(ok ? null : 'origin not allowed', ok);
    },
  });

  const transport = {
    broadcast: (code, ev, data) => io.to('t:' + code).emit(ev, data),
    send: (playerId, ev, data) => io.to('p:' + playerId).emit(ev, data),
    joinRoom: (playerId, code) => io.in('p:' + playerId).socketsJoin('t:' + code),
    leaveRoom: (playerId, code) => io.in('p:' + playerId).socketsLeave('t:' + code),
  };
  const manager = new TableManager({ games: serverGames, transport, persistResult: recordMatch });
  globalThis.__taashTables = manager;                 // read-only access for server components
  globalThis.__taashPresence = presence;
  globalThis.__taashNotify = (userId, ev, data) => io.to('p:u:' + userId).emit(ev, data);
  globalThis.__taashIo = io;
  globalThis.__taashRename = async (userId, name, handle) => {
    for (const s of await io.in('p:u:' + userId).fetchSockets()) Object.assign(s.data.viewer, { name, handle });
  };

  const limits = {
    action: createLimiter({ capacity: 12, perSecond: 6 }),
    chat: createLimiter({ capacity: 12, perSecond: 1 }),     // backstop; chat spam rules live in the table manager
    lobby: createLimiter({ capacity: 15, perSecond: 2 }),
    create: createLimiter({ capacity: 5, perSecond: 0.05 }),
    invite: createLimiter({ capacity: 10, perSecond: 0.2 }),
  };

  io.use(async (socket, next) => {
    try {
      socket.data.viewer = socket.handshake.auth?.token
        ? await viewerFromMobileToken(socket.handshake.auth.token)
        : await viewerFromCookieHeader(socket.handshake.headers.cookie);
      next();
    } catch (e) {
      log.warn('socket auth failed', { err: e.message });
      next(new Error('auth'));
    }
  });

  io.on('connection', socket => {
    const viewer = socket.data.viewer;
    if (viewer.kind === 'anon') {
      socket.emit('session', { kind: 'anon' });
      socket.onAny((...args) => {
        const ack = args[args.length - 1];
        if (typeof ack === 'function') ack({ error: 'Choose a display name (or sign in) first, then try again.', code: 'anon' });
      });
      return;
    }
    socket.join('p:' + viewer.playerId);
    if (viewer.userId) presence.set(viewer.userId, (presence.get(viewer.userId) || 0) + 1);
    /** Tables this socket is watching. */
    const watching = new Set();
    socket.emit('session', { kind: viewer.kind, playerId: viewer.playerId, name: viewer.name });

    /** Wrap a handler: validation, rate limiting, uniform acks, no crashes. */
    const on = (event, schema, limiter, fn) => socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (limiter && !limiter(viewer.playerId)) return reply({ error: 'You’re going a little fast. Wait a moment and try again.', code: 'rate' });
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return reply({ error: 'Something about that request didn’t look right. Refresh the page and try again.', code: 'invalid' });
      try { reply((await fn(parsed.data)) || { ok: true }); }
      catch (e) { log.error('socket handler failed', { event, err: e.message }); reply({ error: 'Something went wrong on our side. Try again in a moment.' }); }
    });

    const withLooks = async () => (viewer.userId ? { ...viewer, cosmetics: await tableCosmetics(viewer.userId).catch(() => null) } : viewer);

    on('table:create', S.create, limits.create, async ({ gameId, settings, options }) => manager.createTable(await withLooks(), gameId, settings, options));
    on('me:table', z.object({}).optional(), null, () => ({ ok: true, table: manager.tableOf(viewer.playerId) }));

    on('table:join', S.join, limits.lobby, async ({ code, as }) => {
      const res = manager.join(await withLooks(), code, as);
      if (res.error) return res;
      if (!watching.has(res.code)) {
        const at = manager.attach(viewer, res.code);
        if (at.error) return at;
        watching.add(res.code);
        return { ok: true, snapshot: at.snapshot };
      }
      return { ok: true, snapshot: manager.snapshot(manager.get(res.code), viewer.playerId) };
    });

    on('table:sync', S.code, limits.lobby, ({ code }) => {
      const t = manager.get(code);
      if (!t || !manager.memberOf(t, viewer.playerId)) return { error: 'This table has closed.', code: 'not-found' };
      if (!watching.has(t.code)) { const at = manager.attach(viewer, t.code); if (at.error) return at; watching.add(t.code); return { ok: true, snapshot: at.snapshot }; }
      return { ok: true, snapshot: manager.snapshot(t, viewer.playerId) };
    });

    on('table:unwatch', S.code, null, ({ code }) => {
      const t = manager.get(code);
      if (t && watching.delete(t.code)) { manager.detach(viewer, t.code); socket.leave('t:' + t.code); }
      return { ok: true };
    });

    on('table:leave', S.code, limits.lobby, ({ code }) => {
      const t = manager.get(code);
      if (t && watching.delete(t.code)) manager.detach(viewer, t.code);
      return manager.leave(viewer, code);
    });
    on('table:ready', S.ready, limits.lobby, ({ code, ready }) => manager.setReady(viewer, code, ready));
    on('table:settings', S.settings, limits.lobby, ({ code, settings, options }) => manager.updateSettings(viewer, code, settings, options));
    on('table:addBot', S.addBot, limits.lobby, ({ code, botId }) => manager.addBot(viewer, code, botId));
    on('table:kick', S.kick, limits.lobby, ({ code, playerId }) => manager.kick(viewer, code, playerId));
    on('table:move', S.move, limits.lobby, ({ code, playerId, to }) => manager.move(viewer, code, playerId, to));
    on('table:lobby', S.code, limits.lobby, ({ code }) => manager.backToLobby(viewer, code));
    on('table:forfeit', S.code, limits.lobby, ({ code }) => manager.forfeit(viewer, code));
    on('table:emote', S.emote, limits.chat, ({ code, sound }) => !isSound(sound) ? { error: 'That sound isn’t on the sound board any more.' } : manager.emote(viewer, code, sound));
    on('table:start', S.start, limits.lobby, ({ code, testCardsEach }) => {
      // End-to-end tests only (TAASH_E2E=1, never set in production): deal k cards each for short games.
      if (testCardsEach && process.env.TAASH_E2E === '1') {
        const t = manager.get(code);
        return manager.start(viewer, code, t ? { hands: shortDeal(t.players.length, testCardsEach) } : {});
      }
      return manager.start(viewer, code);
    });
    on('game:action', S.action, limits.action, ({ code, actionId, action }) => manager.action(viewer, code, actionId, action));
    on('chat:send', S.chat, limits.chat, ({ code, text }) => manager.chat(viewer, code, text));

    on('table:invite', S.invite, limits.invite, async ({ code, userIds }) => {
      if (viewer.kind !== 'user') return { error: 'Sign in to invite friends.' };
      const t = manager.get(code);
      if (!t || !manager.seatOf(t, viewer.playerId)) return { error: 'You are not seated at this table.' };
      const sent = [];
      for (const uid of userIds) {
        if (uid === viewer.userId || !(await areFriends(viewer.userId, uid))) continue;
        t.invited.add(uid);
        const invite = { code: t.code, gameId: t.gameId, from: { name: viewer.name, handle: viewer.handle } };
        transport.send('u:' + uid, 'invite', invite);
        pushIfOffline(uid, 'invite', invite);
        sent.push(uid);
      }
      if (sent.length) manager.system(t, viewer.name + ' sent ' + sent.length + (sent.length === 1 ? ' invite.' : ' invites.'));
      return { ok: true, sent: sent.length };
    });

    socket.on('disconnect', () => {
      for (const code of watching) manager.detach(viewer, code);
      watching.clear();
      if (viewer.userId) {
        const n = (presence.get(viewer.userId) || 1) - 1;
        if (n <= 0) presence.delete(viewer.userId); else presence.set(viewer.userId, n);
      }
    });
  });

  return { io, manager };
}
