/**
 * Platform tables: seats, spectators, host, readiness, settings, chat, game
 * lifecycle, deadlines, disconnection and result persistence. Game rules are
 * delegated to the game module (see interface.js).
 *
 * All state is in memory. One process owns every table, so there is no
 * locking: socket handlers run one at a time on the event loop.
 *
 * Transport (provided by lib/realtime):
 *   broadcast(code, event, data)   → everyone watching the table
 *   send(playerId, event, data)    → every socket of one player
 *   joinRoom(playerId, code) / leaveRoom(playerId, code)
 */
import { randomInt, randomUUID } from 'node:crypto';
import { log } from '../log.js';
import { BY_ID } from '../cosmetics/catalog.js';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-Z]{3}-[A-Z0-9]{3}$/;

export const LIMITS = {
  chatMax: 400,
  chatGapMs: 1500,              // spam protection: at least this long between one person's messages…
  chatBurst: 5,                 // …at most this many…
  chatBurstMs: 10_000,          // …in this long…
  chatRepeatMs: 15_000,         // …and the same message not again within this long
  chatKeep: 100,
  lobbyGraceMs: 60_000,         // a disconnected player keeps a lobby seat this long
  abandonMs: 10 * 60_000,       // nobody connected this long: the game is played out and the table closes
  maxTables: 500,
  publicList: 50,
  spectatorsMax: 20,
  emoteGapMs: 2500,             // one sound-board sound per player every few seconds
};

/**
 * Platform options every table has, whatever the game.
 * ranked:      results change ratings (and earn coins).
 * visibility:  'public' tables are listed for everyone online; 'private' ones are joined by code or invite.
 * allowGuests: whether players without an account may sit or watch (a guest host's table always allows them).
 * spectators:  how many people may watch.
 */
export function normalizeOptions(raw, prev = { ranked: true, visibility: 'private', allowGuests: true, spectators: 4 }) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const spec = Number(o.spectators);
  return {
    ranked: typeof o.ranked === 'boolean' ? o.ranked : prev.ranked,
    visibility: o.visibility === 'public' || o.visibility === 'private' ? o.visibility : prev.visibility,
    allowGuests: typeof o.allowGuests === 'boolean' ? o.allowGuests : prev.allowGuests ?? true,
    spectators: Number.isFinite(spec) ? Math.max(0, Math.min(LIMITS.spectatorsMax, Math.round(spec))) : prev.spectators ?? 4,
  };
}

/** Crypto-backed rng in [0, 1) for shuffles. */
function cryptoRng() { return randomInt(0, 2 ** 47) / 2 ** 47; }

export function normalizeCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 6 ? s.slice(0, 3) + '-' + s.slice(3) : String(raw || '').toUpperCase().trim();
}

/**
 * @typedef {{playerId:string, userId:string|null, name:string, guest:boolean, handle?:string|null, cosmetics?:object|null}} Identity
 */

export class TableManager {
  /**
   * @param {object} o
   * @param {Record<string, import('./interface.js').GameModule>} o.games
   * @param {{broadcast:Function, send:Function, joinRoom:Function, leaveRoom:Function}} o.transport
   * @param {(record:object) => Promise<{ratings:Record<string,object>, coins?:Record<string,number>}>} [o.persistResult]
   * @param {() => number} [o.now]
   * @param {() => number} [o.rng]
   */
  constructor(o) {
    this.games = o.games;
    this.t = o.transport;
    this.persistResult = o.persistResult || (async () => ({ ratings: {} }));
    this.now = o.now || Date.now;
    this.rng = o.rng || cryptoRng;
    /** @type {Map<string, any>} */
    this.tables = new Map();
    /** playerId → table code: a person is at one table at a time (seated or watching). */
    this.where = new Map();
  }

  /* ------------------------------------------------------------ helpers */

  generateCode() {
    for (;;) {
      let id = '';
      for (let i = 0; i < 3; i++) id += ALPHA[randomInt(ALPHA.length)];
      id += '-';
      for (let i = 0; i < 3; i++) id += ALNUM[randomInt(ALNUM.length)];
      if (!this.tables.has(id)) return id;
    }
  }

  get(code) { return this.tables.get(normalizeCode(code)) || null; }
  seatOf(table, playerId) { return table.players.find(p => p.id === playerId) || null; }
  watcherOf(table, playerId) { return table.spectators.find(p => p.id === playerId) || null; }
  memberOf(table, playerId) { return this.seatOf(table, playerId) || this.watcherOf(table, playerId); }
  isHost(table, playerId) { return table.hostId === playerId; }
  gameSeat(table, playerId) { return table.gamePlayers ? table.gamePlayers.findIndex(p => p.id === playerId) : -1; }

  /** The table this person is at, for "you're already at a table" and the home screen. */
  tableOf(playerId) {
    const code = this.where.get(playerId);
    const t = code && this.tables.get(code);
    if (!t || !this.memberOf(t, playerId)) { if (code) this.where.delete(playerId); return null; }
    const seat = this.seatOf(t, playerId);
    return { code: t.code, gameId: t.gameId, status: t.status, role: seat ? 'player' : 'spectator', host: t.hostId === playerId, seated: t.players.length, seats: t.settings.players };
  }

  /** Someone already at another table can't sit or watch here. */
  elsewhere(who, code) {
    const other = this.tableOf(who.playerId);
    if (!other || other.code === code) return null;
    return {
      error: other.status === 'playing'
        ? 'You’re in a game at table ' + other.code + '. Finish it (or forfeit) before joining another table.'
        : 'You’re already at table ' + other.code + '. Leave it first to join a different one.',
      code: 'elsewhere', table: other.code,
    };
  }

  /** Tables a set of users are hosting/sitting at, for "friends' open tables". */
  openTablesFor(userIds) {
    const set = new Set(userIds);
    const out = [];
    for (const t of this.tables.values()) {
      if (t.status === 'playing') continue;
      const host = this.seatOf(t, t.hostId);
      if (!host || !host.userId || !set.has(host.userId)) continue;
      out.push({ code: t.code, gameId: t.gameId, host: { name: host.name, handle: host.handle }, seated: t.players.length, seats: t.settings.players });
    }
    return out;
  }

  /**
   * What someone holding a table code would see before joining (shared links,
   * the join screen). Mirrors join()'s rules without changing anything.
   * @param {Identity|null} who null when not signed in or a guest yet
   */
  preview(rawCode, who) {
    const code = normalizeCode(rawCode);
    const t = CODE_RE.test(code) && this.tables.get(code);
    if (!t) return null;
    const host = this.seatOf(t, t.hostId);
    const mine = who && this.memberOf(t, who.playerId);
    const watchRoom = t.spectators.length < t.options.spectators;
    let reason = null;
    if (!mine) {
      if (who?.guest && !t.options.allowGuests) reason = 'no-guests';
      else if (who && this.elsewhere(who, code)) reason = 'elsewhere';
    }
    const seatFree = t.status !== 'playing' && t.players.length < t.settings.players;
    return {
      code: t.code, gameId: t.gameId, status: t.status, settings: t.settings, options: t.options, gamesPlayed: t.gamesPlayed,
      host: host ? { name: host.name, handle: host.handle, guest: host.guest } : null,
      players: t.players.map(p => ({ name: p.name, handle: p.handle, guest: p.guest, bot: p.bot || null, isHost: p.id === t.hostId })),
      seated: t.players.length, seats: t.settings.players, watching: t.spectators.length,
      you: mine ? (this.seatOf(t, who.playerId) ? 'player' : 'spectator') : null,
      canSit: !!mine || (!reason && seatFree), canWatch: !!mine || (!reason && watchRoom),
      reason: mine ? null : reason || (!seatFree && !watchRoom ? (t.status === 'playing' ? 'in-progress' : 'full') : null),
    };
  }

  /** Public tables with a free seat or room to watch, newest first, for the "Open rooms" list. */
  publicTables() {
    const out = [];
    for (const t of this.tables.values()) {
      if (t.options.visibility !== 'public') continue;
      const seatFree = t.status !== 'playing' && t.players.length < t.settings.players;
      const watchFree = t.spectators.length < t.options.spectators;
      if (!seatFree && !watchFree) continue;
      const host = this.seatOf(t, t.hostId);
      out.push({
        code: t.code, gameId: t.gameId, ranked: t.options.ranked, allowGuests: t.options.allowGuests, seated: t.players.length, seats: t.settings.players,
        playing: t.status === 'playing', watchOnly: !seatFree, watching: t.spectators.length,
        turnSeconds: t.settings.turnSeconds, host: host ? { name: host.name, guest: host.guest } : null,
        players: t.players.map(p => ({ name: p.name, guest: p.guest })), createdAt: t.createdAt,
      });
    }
    return out.sort((a, b) => (a.watchOnly - b.watchOnly) || b.createdAt - a.createdAt).slice(0, LIMITS.publicList);
  }

  stats() {
    let playing = 0, players = 0;
    for (const t of this.tables.values()) { if (t.status === 'playing') playing++; players += t.players.length; }
    return { tables: this.tables.size, playing, players };
  }

  /* ------------------------------------------------------------ views */

  /**
   * The table everyone plays on: of the designs the seated players own, the most
   * prestigious wins (rank rewards by rank, then shop tables by price); ties go to the host.
   */
  tableDesign(table) {
    let best = null;
    for (const p of table.players) {
      const key = !p.bot && p.cosmetics && p.cosmetics.table;
      const item = key && BY_ID['table-' + key];
      if (!item) continue;
      const score = (item.minPeak ? 100000 + item.minPeak : item.price || 0) + (p.id === table.hostId ? .5 : 0);
      if (!best || score > best.score) best = { score, key, name: item.name, by: p.name, byId: p.id };
    }
    return best && { key: best.key, name: best.name, by: best.by, byId: best.byId };
  }

  lobbyView(table) {
    return {
      code: table.code, gameId: table.gameId, hostId: table.hostId, status: table.status,
      settings: table.settings, gamesPlayed: table.gamesPlayed, options: table.options,
      cosmetics: { table: this.tableDesign(table) },                   // {key, name, by} or null (classic)
      players: table.players.map(p => ({ id: p.id, name: p.name, guest: p.guest, bot: p.bot || null, handle: p.handle || null, userId: p.userId || null, ready: p.ready, connected: p.bot ? true : p.connections > 0, isHost: p.id === table.hostId, cosmetics: p.cosmetics || null })),
      spectators: table.spectators.map(p => ({ id: p.id, name: p.name, guest: p.guest, handle: p.handle || null, userId: p.userId || null, connected: p.connections > 0 })),
    };
  }

  snapshot(table, playerId) {
    const now = this.now();
    const game = this.games[table.gameId];
    const snap = { ...this.lobbyView(table), you: playerId, seq: table.seq, now, chat: table.chat.slice(-50), game: null, result: table.lastResult };
    if (table.match) {
      const seat = this.gameSeat(table, playerId);       // -1 for spectators: they never get a hand
      snap.game = {
        matchId: table.matchId,
        seats: table.gamePlayers.map(p => ({ id: p.id, name: p.name, guest: p.guest, bot: p.bot || null, handle: p.handle || null, userId: p.userId || null, isHost: p.id === table.hostId, cosmetics: p.cosmetics || null })),
        you: seat,
        spectating: seat < 0,
        view: game.publicView(table.match, now),
        hand: seat >= 0 ? game.privateView(table.match, seat).hand : [],
      };
    }
    return snap;
  }

  pushLobby(table) { this.t.broadcast(table.code, 'table:state', { code: table.code, ...this.lobbyView(table) }); }

  system(table, text) {
    const msg = { id: table.code + ':' + (++table.chatSeq), kind: 'system', text, at: this.now() };
    table.chat.push(msg);
    if (table.chat.length > LIMITS.chatKeep) table.chat.splice(0, table.chat.length - LIMITS.chatKeep);
    this.t.broadcast(table.code, 'chat:msg', { code: table.code, msg });
  }

  /* ------------------------------------------------------------ lifecycle */

  /** @param {Identity} who */
  createTable(who, gameId, rawSettings, rawOptions) {
    const game = this.games[gameId];
    if (!game) return { error: 'That game isn’t available yet.' };
    const busy = this.elsewhere(who, null);
    if (busy) return busy;
    if (this.tables.size >= LIMITS.maxTables) return { error: 'The card room is full right now. Try again in a few minutes.' };
    const norm = game.normalizeSettings(rawSettings);
    if (!norm.ok) return { error: Object.values(norm.errors)[0], errors: norm.errors };
    const code = this.generateCode();
    const options = normalizeOptions(rawOptions);
    if (who.guest) options.allowGuests = true;           // a guest host can't shut guests out
    const table = {
      code, gameId, hostId: who.playerId, settings: norm.settings, options, status: 'lobby',
      players: [], spectators: [], chat: [], chatSeq: 0, seq: 0, gamesPlayed: 0,
      match: null, matchId: null, gamePlayers: null, lastResult: null, startedAt: null,
      timer: null, abandonTimer: null, paused: false, recentActions: new Map(), invited: new Set(),
      gone: new Set(), botTimers: new Set(), botSaidAt: new Map(), emotedAt: new Map(), chatLog: new Map(),
      createdAt: this.now(),
    };
    this.tables.set(code, table);
    this.addSeat(table, who, true);
    this.system(table, who.name + ' opened the table.');
    log.info('table created', { code, gameId });
    return { code };
  }

  addSeat(table, who, ready) {
    const seat = { id: who.playerId, userId: who.userId, name: who.name, guest: who.guest, handle: who.handle || null, cosmetics: who.cosmetics || null, ready: !!ready, connections: 0, joinedAt: this.now(), graceTimer: null };
    table.players.push(seat);
    this.where.set(who.playerId, table.code);
    return seat;
  }

  addWatcher(table, who) {
    const w = { id: who.playerId, userId: who.userId, name: who.name, guest: who.guest, handle: who.handle || null, cosmetics: who.cosmetics || null, connections: 0, joinedAt: this.now(), graceTimer: null };
    table.spectators.push(w);
    this.where.set(who.playerId, table.code);
    return w;
  }

  /**
   * Take a seat or a place to watch (or come back to your own). `as`:
   * 'player' (default) or 'spectator'.
   * @param {Identity} who
   */
  join(who, rawCode, as = 'player') {
    const code = normalizeCode(rawCode);
    if (!code) return { error: 'Enter the table code your host shared.' };
    if (!CODE_RE.test(code)) return { error: 'Table codes look like ABC-123: three letters, a dash, then three letters or numbers.' };
    const table = this.tables.get(code);
    if (!table) return { error: 'No open table uses the code ' + code + '. Check the code with your host. Tables close when everyone leaves.', code: 'not-found' };
    const mine = this.memberOf(table, who.playerId);
    if (mine) {
      if (mine.name !== who.name && !table.match) { mine.name = who.name; this.pushLobby(table); }   // display name changed since they sat down
      if (who.cosmetics !== undefined) mine.cosmetics = who.cosmetics;
      return { ok: true, code, role: this.seatOf(table, who.playerId) ? 'player' : 'spectator' };
    }
    const busy = this.elsewhere(who, code);
    if (busy) return busy;
    if (who.guest && !table.options.allowGuests) return { error: 'This table is for players with an account. Sign in or create a free account to join.', code: 'no-guests' };
    const canWatch = table.spectators.length < table.options.spectators;
    const wantSeat = as !== 'spectator';
    if (wantSeat) {
      if (table.status === 'playing') return { error: 'A game is in progress at table ' + code + '.' + (canWatch ? ' You can watch it until it ends.' : ' Try again when it ends.'), code: 'in-progress', canWatch };
      if (table.players.length >= table.settings.players) return { error: 'Table ' + code + ' is full (' + table.settings.players + ' of ' + table.settings.players + ' seats taken).' + (canWatch ? ' You can watch instead.' : ''), code: 'full', canWatch };
    } else if (!canWatch) {
      return { error: table.options.spectators ? 'There’s no room to watch at table ' + code + ' right now.' : 'The host isn’t allowing spectators at table ' + code + '.', code: 'no-watch' };
    }
    const clash = [...table.players, ...table.spectators].find(p => p.name.trim().toLowerCase() === who.name.trim().toLowerCase());
    if (clash && who.guest) return { error: 'Someone at this table is already called ' + clash.name + '. Pick a different display name.', code: 'name-taken' };
    if (wantSeat) {
      this.addSeat(table, who, false);
      this.system(table, who.name + (who.guest ? ' joined as a guest.' : ' joined the table.'));
    } else {
      this.addWatcher(table, who);
      this.system(table, who.name + ' is watching.');
    }
    this.pushLobby(table);
    return { ok: true, code, role: wantSeat ? 'player' : 'spectator' };
  }

  /** A socket of `playerId` is now watching `code`. */
  attach(who, code) {
    const table = this.get(code);
    if (!table) return { error: 'This table has closed.', code: 'not-found' };
    const m = this.memberOf(table, who.playerId);
    if (!m) return { error: 'You’re not at this table any more.', code: 'not-seated' };
    this.t.joinRoom(who.playerId, table.code);
    const wasOff = m.connections === 0;
    m.connections++;
    if (m.graceTimer) { clearTimeout(m.graceTimer); m.graceTimer = null; }
    table.gone.delete(who.playerId);
    if (table.abandonTimer) { clearTimeout(table.abandonTimer); table.abandonTimer = null; }
    if (table.paused) this.resume(table);
    if (wasOff) this.pushLobby(table);
    return { snapshot: this.snapshot(table, who.playerId) };
  }

  /** A socket stopped watching (navigated away or disconnected). */
  detach(who, code) {
    const table = this.get(code);
    if (!table) return;
    const m = this.memberOf(table, who.playerId);
    if (!m || m.connections === 0) return;
    m.connections--;
    if (m.connections > 0) return;
    this.pushLobby(table);
    // Outside a game (and spectators, always) only keep the place for a short grace period.
    if (table.status !== 'playing' || !this.seatOf(table, who.playerId)) this.startGrace(table, m);
    if (this.nobodyHere(table)) this.startAbandon(table);
  }

  startGrace(table, m) {
    if (m.graceTimer) return;
    m.graceTimer = setTimeout(() => {
      m.graceTimer = null;
      if (m.connections !== 0 || this.tables.get(table.code) !== table) return;
      if (this.watcherOf(table, m.id)) this.removeWatcher(table, m.id, 'timeout');
      else if (table.status !== 'playing') this.removeSeat(table, m.id, 'timeout');
    }, LIMITS.lobbyGraceMs);
    m.graceTimer.unref?.();
  }

  /** Nobody is here: pause; if nobody comes back, play the game out (results count as usual) and close. */
  startAbandon(table) {
    if (table.abandonTimer) return;
    if (table.match && table.status === 'playing') this.pause(table);
    table.abandonTimer = setTimeout(() => {
      table.abandonTimer = null;
      if (table.status === 'playing' && table.match) this.playOut(table);
      this.close(table, 'abandoned');
    }, LIMITS.abandonMs);
    table.abandonTimer.unref?.();
  }

  /** Auto-play every remaining turn right now, so the game ends the normal way. */
  playOut(table) {
    const game = this.games[table.gameId];
    table.paused = false;
    table.gamePlayers.forEach((p, i) => { if (!p.bot) game.act(table.match, i, { type: 'away' }, this.now()); });
    for (let i = 0; i < 20000 && table.status === 'playing' && table.match; i++) {
      this.applyOutcome(table, game.onDeadline(table.match, this.now()));
    }
  }

  close(table, reason) {
    if (this.tables.get(table.code) !== table) return;
    clearTimeout(table.timer); clearTimeout(table.abandonTimer);
    for (const p of [...table.players, ...table.spectators]) { if (p.graceTimer) clearTimeout(p.graceTimer); if (this.where.get(p.id) === table.code) this.where.delete(p.id); }
    for (const t of table.botTimers) clearTimeout(t);
    table.match = null; table.timer = null; table.abandonTimer = null;
    this.tables.delete(table.code);
    this.t.broadcast(table.code, 'table:closed', { code: table.code, reason });
    log.info('table closed', { code: table.code, reason });
  }

  removeSeat(table, playerId, reason) {
    const i = table.players.findIndex(p => p.id === playerId);
    if (i < 0) return;
    const [p] = table.players.splice(i, 1);
    if (p.graceTimer) clearTimeout(p.graceTimer);
    if (this.where.get(playerId) === table.code) this.where.delete(playerId);
    this.t.leaveRoom(playerId, table.code);
    if (reason === 'kick') this.t.send(playerId, 'table:kicked', { code: table.code });
    if (!table.players.some(x => !x.bot)) { this.close(table, 'empty'); return; }   // bots alone don't keep a table open
    this.system(table, reason === 'kick' ? p.name + ' was removed from the table by the host.' : p.name + ' left the table.');
    if (table.hostId === playerId) {
      const next = table.players.filter(x => !x.bot).sort((a, b) => (b.connections > 0) - (a.connections > 0) || a.joinedAt - b.joinedAt)[0];
      table.hostId = next.id;
      next.ready = true;
      this.system(table, next.name + ' is now the host.');
    }
    this.pushLobby(table);
  }

  removeWatcher(table, playerId, reason) {
    const i = table.spectators.findIndex(p => p.id === playerId);
    if (i < 0) return;
    const [p] = table.spectators.splice(i, 1);
    if (p.graceTimer) clearTimeout(p.graceTimer);
    if (this.where.get(playerId) === table.code) this.where.delete(playerId);
    this.t.leaveRoom(playerId, table.code);
    if (reason === 'kick') this.t.send(playerId, 'table:kicked', { code: table.code });
    this.system(table, p.name + (reason === 'kick' ? ' was removed by the host.' : ' stopped watching.'));
    this.pushLobby(table);
  }

  /**
   * Leave voluntarily. Spectators just go. Mid-game a player's seat stays and
   * the server plays for them; the result counts like anyone else's (only the
   * Forfeit button ends a game).
   */
  leave(who, code) {
    const table = this.get(code);
    if (!table) return { ok: true };
    if (this.watcherOf(table, who.playerId)) { this.removeWatcher(table, who.playerId, 'leave'); return { ok: true }; }
    const seat = this.seatOf(table, who.playerId);
    if (!seat) return { ok: true };
    if (table.status === 'playing' && table.match) {
      const gs = this.gameSeat(table, who.playerId);
      this.t.leaveRoom(who.playerId, table.code);
      seat.connections = 0;
      if (gs >= 0) {
        table.gone.add(who.playerId);
        this.system(table, seat.name + ' left the game. Their turns will be played automatically.');
        this.applyOutcome(table, this.games[table.gameId].act(table.match, gs, { type: 'away' }, this.now()));
      }
      this.pushLobby(table);
      if (this.nobodyHere(table)) this.startAbandon(table);
      return { ok: true };
    }
    this.removeSeat(table, who.playerId, 'leave');
    return { ok: true };
  }

  /** Give up the game: it ends at once, the forfeiter is last and everyone else shares the win. */
  forfeit(who, code) {
    const table = this.get(code);
    if (!table) return { error: 'This table has closed.' };
    if (table.status !== 'playing' || !table.match) return { error: 'There’s no game in progress to forfeit.' };
    const gs = this.gameSeat(table, who.playerId);
    if (gs < 0) return { error: 'Only players in the game can forfeit.' };
    const view = this.games[table.gameId].publicView(table.match, this.now());
    if (view.seats[gs]?.finished) return { error: 'You’ve already gone out, so there’s nothing to forfeit.' };
    this.system(table, '🏳️ ' + table.gamePlayers[gs].name + ' forfeited the game.');
    this.t.broadcast(table.code, 'table:forfeit', { code: table.code, seat: gs, playerId: who.playerId, name: table.gamePlayers[gs].name });
    this.finish(table, { forfeitSeat: gs });
    return { ok: true };
  }

  /** No person is connected (bots don't count). */
  nobodyHere(table) { return [...table.players, ...table.spectators].every(p => p.bot || p.connections === 0); }

  /** Host seats a bot (unranked tables only, in the lobby). */
  addBot(who, code, botId) {
    const table = this.get(code);
    if (!table || !this.seatOf(table, who.playerId)) return { error: 'You’re not seated at this table.' };
    if (!this.isHost(table, who.playerId)) return { error: 'Only the host can add bots.' };
    if (table.status === 'playing') return { error: 'Add bots between games.' };
    if (table.options.ranked) return { error: 'Bots only play at unranked tables. Make the table unranked first.' };
    const roster = this.games[table.gameId].bots?.roster || [];
    if (!roster.length) return { error: 'This game has no bots yet.' };
    if (table.players.length >= table.settings.players) return { error: 'The table is full. Add a seat first.' };
    const seated = new Set(table.players.filter(p => p.bot).map(p => p.bot));
    const bot = botId ? roster.find(b => b.id === botId) : roster.find(b => !seated.has(b.id));
    if (!bot) return { error: botId ? 'That bot doesn’t exist.' : 'Every bot is already at the table.' };
    if (seated.has(bot.id)) return { error: bot.name + ' is already at the table.' };
    const seat = this.addSeat(table, { playerId: 'b:' + bot.id + ':' + table.code, userId: null, name: bot.name, guest: true }, true);
    seat.bot = bot.id;
    this.where.delete(seat.id);                               // bots aren't people: no one-table rule
    this.system(table, bot.name + ' (bot) sat down.');
    this.pushLobby(table);
    return { ok: true, playerId: seat.id };
  }

  /** A bot's chat line, shortly after what prompted it; at most one line per bot every few seconds. */
  botSay(table, playerId, text) {
    const last = table.botSaidAt.get(playerId);
    if (last != null && this.now() - last < 4000) return;
    table.botSaidAt.set(playerId, this.now());
    const t = setTimeout(() => {
      table.botTimers.delete(t);
      const seat = this.seatOf(table, playerId);
      if (!seat || this.tables.get(table.code) !== table) return;
      const msg = { id: table.code + ':' + (++table.chatSeq), kind: 'msg', from: playerId, name: seat.name, bot: true, text, at: this.now() };
      table.chat.push(msg);
      if (table.chat.length > LIMITS.chatKeep) table.chat.splice(0, table.chat.length - LIMITS.chatKeep);
      this.t.broadcast(table.code, 'chat:msg', { code: table.code, msg });
    }, 700 + Math.floor(this.rng() * 900));
    t.unref?.();
    table.botTimers.add(t);
  }

  setReady(who, code, ready) {
    const table = this.get(code);
    const seat = table && this.seatOf(table, who.playerId);
    if (!seat) return { error: 'You’re not seated at this table.' };
    if (table.status === 'playing') return { error: 'The game has already started.' };
    if (seat.ready === !!ready) return { ok: true };
    seat.ready = !!ready;
    this.system(table, seat.name + (seat.ready ? ' is ready.' : ' is not ready.'));
    this.pushLobby(table);
    return { ok: true };
  }

  updateSettings(who, code, raw, rawOptions) {
    const table = this.get(code);
    if (!table || !this.seatOf(table, who.playerId)) return { error: 'You’re not seated at this table.' };
    if (!this.isHost(table, who.playerId)) return { error: 'Only the host can change the table settings.' };
    if (table.status === 'playing') return { error: 'Settings are locked while a game is in progress. Change them after this game.' };
    const norm = this.games[table.gameId].normalizeSettings(raw ?? table.settings, { minPlayers: table.players.length });
    if (!norm.ok) return { error: Object.values(norm.errors)[0], errors: norm.errors };
    const before = table.options;
    const next = normalizeOptions(rawOptions, table.options);
    const host = this.seatOf(table, table.hostId);
    if (host.guest) next.allowGuests = true;
    if (next.ranked && table.players.some(p => p.bot)) return { error: 'Bots only play at unranked tables. Remove the bots to make this table ranked.' };
    if (next.spectators < table.spectators.length) return { error: plural(table.spectators.length, 'person is', 'people are') + ' already watching. Remove spectators before lowering the limit.' };
    if (!next.allowGuests && [...table.players, ...table.spectators].some(p => p.guest && !p.bot)) return { error: 'There are guests at the table. Remove them before making it accounts-only.' };
    table.settings = norm.settings;
    table.options = next;
    this.system(table, 'The host updated the table settings.');
    if (before.ranked !== next.ranked) this.system(table, next.ranked ? 'Games here are now ranked: results change ratings.' : 'Games here are now unranked: ratings won’t change.');
    if (before.visibility !== next.visibility) this.system(table, next.visibility === 'public' ? 'The table is now public: anyone online can see it and join.' : 'The table is now private: join by code or invite only.');
    if (before.allowGuests !== next.allowGuests) this.system(table, next.allowGuests ? 'Guests can now join this table.' : 'This table is now for players with an account.');
    this.pushLobby(table);
    return { ok: true };
  }

  kick(who, code, playerId) {
    const table = this.get(code);
    if (!table || !this.isHost(table, who.playerId)) return { error: 'Only the host can remove people.' };
    if (playerId === who.playerId) return { error: 'The host can’t remove themselves. Leave the table instead.' };
    if (this.watcherOf(table, playerId)) { this.removeWatcher(table, playerId, 'kick'); return { ok: true }; }
    if (table.status === 'playing') return { error: 'Players can be removed after the game ends.' };
    if (!this.seatOf(table, playerId)) return { error: 'That person isn’t at this table any more.' };
    this.removeSeat(table, playerId, 'kick');
    return { ok: true };
  }

  /** Move between playing and watching (between games): the host moves anyone; anyone can move themselves. */
  move(who, code, playerId, to) {
    const table = this.get(code);
    if (!table || !this.memberOf(table, who.playerId)) return { error: 'You’re not at this table.' };
    const self = playerId === who.playerId;
    if (!self && !this.isHost(table, who.playerId)) return { error: 'Only the host can move other people.' };
    if (table.status === 'playing') return { error: self ? 'You can switch between playing and watching after this game.' : 'Move people between games.' };
    if (to === 'spectator') {
      const seat = this.seatOf(table, playerId);
      if (!seat) return { error: 'That person isn’t playing at this table.' };
      if (seat.bot) return { error: 'Bots can’t watch. Remove the bot instead.' };
      if (playerId === table.hostId) return { error: 'The host plays. Hand over hosting by leaving, or keep your seat.' };
      if (table.spectators.length >= table.options.spectators) return { error: 'There’s no spectator space left. Raise the spectator limit in the table settings.' };
      table.players.splice(table.players.indexOf(seat), 1);
      table.spectators.push({ ...seat, ready: undefined });
      this.system(table, seat.name + (self ? ' is watching now.' : ' moved to spectators.'));
    } else {
      const w = this.watcherOf(table, playerId);
      if (!w) return { error: 'That person isn’t watching this table.' };
      if (table.players.length >= table.settings.players) return { error: 'Every seat is taken. Add a seat or move a player out first.' };
      table.spectators.splice(table.spectators.indexOf(w), 1);
      table.players.push({ ...w, ready: false });
      this.system(table, w.name + ' took a seat.');
    }
    this.pushLobby(table);
    if (!self) this.t.send(playerId, 'table:moved', { code: table.code, to });   // tell them the host moved them
    return { ok: true };
  }

  /** After a game, the host takes everyone back to the lobby. */
  backToLobby(who, code) {
    const table = this.get(code);
    if (!table || !this.memberOf(table, who.playerId)) return { error: 'You’re not at this table.' };
    if (!this.isHost(table, who.playerId)) return { error: 'Only the host can take the table back to the lobby.' };
    if (table.status === 'playing') return { error: 'The game is still going.' };
    if (table.status !== 'lobby') {
      table.status = 'lobby';
      this.pushLobby(table);
      this.t.broadcast(table.code, 'table:lobby', { code: table.code });
    }
    return { ok: true };
  }

  /** Sound-board: a short sound everyone at the table hears. */
  emote(who, code, sound) {
    const table = this.get(code);
    const seat = table && this.seatOf(table, who.playerId);
    if (!seat) return { error: 'Only players can use the sound board.' };
    const last = table.emotedAt.get(who.playerId) || 0;
    if (this.now() - last < LIMITS.emoteGapMs) return { error: 'Give it a second before the next sound.', code: 'rate' };
    table.emotedAt.set(who.playerId, this.now());
    this.t.broadcast(table.code, 'table:emote', { code: table.code, from: who.playerId, name: seat.name, sound });
    return { ok: true };
  }

  /** Host starts a game (or a rematch after results). */
  start(who, code, opts = {}) {
    const table = this.get(code);
    if (!table || !this.seatOf(table, who.playerId)) return { error: 'You’re not seated at this table.' };
    if (!this.isHost(table, who.playerId)) return { error: 'Only the host can start the game.' };
    if (table.status === 'playing') return { error: 'A game is already in progress.' };
    const game = this.games[table.gameId];
    const n = table.players.length;
    if (n < game.playerRange.min) return { error: `At least ${game.playerRange.min} players are needed to start. Invite someone${table.options.ranked ? '' : ' or add a bot'}.` };
    if (table.status === 'lobby') {
      const notReady = table.players.filter(p => p.id !== table.hostId && !p.ready);
      if (notReady.length) return { error: 'Waiting for ' + notReady.map(p => p.name.split(' ')[0]).join(', ') + ' to get ready.' };
    }
    const now = this.now();
    table.gamePlayers = table.players.map(p => ({ id: p.id, userId: p.userId, handle: p.handle || null, name: p.name, guest: p.guest, bot: p.bot || null, cosmetics: p.cosmetics || null }));
    const dealer = (table.gamesPlayed + n - 1) % n;
    const { match, outcome } = game.createMatch({ players: table.gamePlayers.map(p => ({ id: p.id, name: p.name, bot: p.bot })), settings: table.settings, rng: this.rng, dealer, now, hands: opts.hands });
    table.match = match;
    table.matchId = randomUUID();
    table.startedAt = new Date(now);
    table.status = 'playing';
    table.lastResult = null;
    table.recentActions.clear();
    table.gone.clear();
    this.system(table, 'Game ' + (table.gamesPlayed + 1) + ' is starting. Shuffling…');
    this.pushLobby(table);
    // Everyone gets their own starting snapshot (players: only their own hand;
    // spectators: no hand), then the deal events follow on the same connection.
    for (const p of [...table.gamePlayers, ...table.spectators]) this.t.send(p.id, 'game:snapshot', { code: table.code, snapshot: this.snapshot(table, p.id) });
    this.applyOutcome(table, outcome);
    log.info('game started', { code: table.code, players: n, spectators: table.spectators.length });
    return { ok: true };
  }

  /* ------------------------------------------------------------ gameplay */

  action(who, code, actionId, action) {
    const table = this.get(code);
    if (!table) return { error: 'This table has closed.' };
    if (table.status !== 'playing' || !table.match) return { error: 'There’s no game in progress.' };
    const seat = this.gameSeat(table, who.playerId);
    if (seat < 0) return { error: this.watcherOf(table, who.playerId) ? 'You’re watching this game, so you can’t play in it.' : 'You’re not playing in this game.' };
    // Idempotency: a retried action (same id) is acknowledged but not applied twice.
    let seen = table.recentActions.get(who.playerId);
    if (!seen) { seen = []; table.recentActions.set(who.playerId, seen); }
    if (actionId && seen.includes(actionId)) return { ok: true, duplicate: true };
    const res = this.games[table.gameId].act(table.match, seat, action, this.now());
    if (res.error) return { error: res.error };
    if (actionId) { seen.push(actionId); if (seen.length > 32) seen.shift(); }
    this.applyOutcome(table, res);
    return { ok: true };
  }

  applyOutcome(table, outcome) {
    if (!outcome || this.tables.get(table.code) !== table || !table.match) return;
    const game = this.games[table.gameId];
    if (outcome.events && outcome.events.length) {
      table.seq++;
      this.t.broadcast(table.code, 'game:events', { code: table.code, seq: table.seq, now: this.now(), events: outcome.events });
      if (game.bots && table.gamePlayers.some(p => p.bot)) {
        for (const line of game.bots.chatterFor(outcome.events, seat => table.gamePlayers[seat]?.bot || null, this.rng)) this.botSay(table, table.gamePlayers[line.seat].id, line.text);
      }
      for (const seat of new Set(outcome.handsChanged || [])) {
        const p = table.gamePlayers[seat];
        if (p) this.t.send(p.id, 'game:hand', { code: table.code, seq: table.seq, hand: game.privateView(table.match, seat).hand });
      }
    }
    if (outcome.over) { this.finish(table); return; }
    this.schedule(table);
  }

  schedule(table) {
    clearTimeout(table.timer);
    table.timer = null;
    const dl = table.match && table.match.deadline;
    if (!dl || table.paused) return;
    const id = dl.id;
    table.timer = setTimeout(() => {
      table.timer = null;
      if (!table.match || !table.match.deadline || table.match.deadline.id !== id) return;  // superseded
      try {
        this.applyOutcome(table, this.games[table.gameId].onDeadline(table.match, this.now()));
      } catch (e) {
        log.error('deadline handler failed', { code: table.code, err: e.message });
      }
    }, Math.max(0, dl.at - this.now()));
  }

  /** Nobody is connected: stop the clock instead of auto-playing to an empty room. */
  pause(table) {
    if (table.paused || !table.match || !table.match.deadline) return;
    table.paused = { remaining: Math.max(1000, table.match.deadline.at - this.now()) };
    clearTimeout(table.timer); table.timer = null;
  }

  resume(table) {
    if (!table.paused) return;
    const { remaining } = table.paused;
    table.paused = false;
    if (table.match && table.match.deadline) {
      table.match.deadline.at = this.now() + remaining;
      this.t.broadcast(table.code, 'game:deadline', { code: table.code, now: this.now(), deadline: { ...table.match.deadline } });
    }
    this.schedule(table);
  }

  /** @param {{forfeitSeat?: number}} [opts] forfeitSeat: the game ended because that seat forfeited */
  finish(table, opts = {}) {
    clearTimeout(table.timer); table.timer = null;
    table.paused = false;
    const game = this.games[table.gameId];
    const res = game.results(table.match);
    const now = this.now();
    const forfeitSeat = opts.forfeitSeat ?? null;
    table.status = 'finished';
    table.gamesPlayed++;
    for (const p of table.players) if (p.id !== table.hostId && !p.bot) p.ready = false;   // bots are always ready
    // If the host left during the game, hand the table to someone who is still here.
    const host = this.seatOf(table, table.hostId);
    if (host && host.connections === 0) {
      const next = table.players.filter(p => !p.bot && p.connections > 0).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) { table.hostId = next.id; next.ready = true; this.system(table, next.name + ' is now the host.'); }
    }
    let players = table.gamePlayers.map((p, seat) => {
      const o = res.order.find(x => x.seat === seat);
      return { seat, id: p.id, userId: p.userId, name: p.name, guest: p.guest, bot: p.bot || null, place: o.place, isLoser: forfeitSeat == null && res.loser === seat, forfeit: seat === forfeitSeat, stats: res.stats[seat] };
    });
    if (forfeitSeat != null) {
      // Players who already went out keep their places; everyone else still in shares the next one; the forfeiter is last.
      const seatsNow = game.publicView(table.match, now).seats;
      const out = new Set(seatsNow.filter(s => s.finished).map(s => s.seat));
      const shared = players.filter(p => out.has(p.seat)).length + 1;
      players.forEach(p => { if (p.forfeit) p.place = players.length; else if (!out.has(p.seat)) p.place = shared; });
    }
    const ranked = table.options.ranked;
    const result = {
      matchId: table.matchId, gameId: table.gameId, gameNo: table.gamesPlayed,
      players: players.map(({ userId, ...rest }) => rest), loser: forfeitSeat == null ? res.loser : null, ranked,
      forfeit: forfeitSeat != null ? { seat: forfeitSeat, id: table.gamePlayers[forfeitSeat].id, name: table.gamePlayers[forfeitSeat].name } : null,
      summary: res.summary, ratings: null, coins: null, endedAt: now,
    };
    table.lastResult = result;
    const loser = result.loser != null ? table.gamePlayers[result.loser] : null;
    this.system(table, forfeitSeat != null ? 'Game over — ' + table.gamePlayers[forfeitSeat].name + ' forfeited.' : loser ? 'Game over — ' + loser.name + ' was left holding the cards.' : 'Game over.');
    // People who walked out mid-game free their seats now; others who dropped off get the usual grace.
    for (const id of table.gone) { const s = this.seatOf(table, id); if (s && s.connections === 0) this.removeSeat(table, id, 'leave'); }
    if (!this.tables.has(table.code)) return;
    for (const p of table.players) if (!p.bot && p.connections === 0) this.startGrace(table, p);
    this.pushLobby(table);
    this.t.broadcast(table.code, 'table:result', { code: table.code, result });
    // Durable record (+ ratings and coins for registered players), exactly once per matchId.
    this.persistResult({
      matchId: table.matchId, gameId: table.gameId, tableCode: table.code, gameNo: table.gamesPlayed,
      settings: table.settings, ranked, forfeitEnded: forfeitSeat != null, startedAt: table.startedAt, summary: res.summary,
      players: players.map(p => ({ seat: p.seat, userId: p.userId, name: p.name, place: p.place, isLoser: p.isLoser, forfeit: p.forfeit, stats: p.stats })),
    }).then(stored => {
      if (table.lastResult !== result) return;
      result.ratings = Object.fromEntries(players.filter(p => p.userId && stored.ratings[p.userId]).map(p => [p.id, stored.ratings[p.userId]]));
      result.coins = stored.coins ? Object.fromEntries(players.filter(p => p.userId && stored.coins[p.userId]).map(p => [p.id, stored.coins[p.userId]])) : null;
      this.t.broadcast(table.code, 'table:result', { code: table.code, result });
    }).catch(e => log.error('saving result failed', { code: table.code, err: e.message }));
    log.info('game finished', { code: table.code, players: players.length, forfeit: forfeitSeat != null });
  }

  /* ------------------------------------------------------------ chat */

  chat(who, code, rawText) {
    const table = this.get(code);
    const m = table && this.memberOf(table, who.playerId);
    if (!m) return { error: 'Only people at this table can chat here.' };
    const text = String(rawText ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, LIMITS.chatMax);
    if (!text) return { error: 'Type a message first.' };
    const slow = this.chatTooFast(table, who.playerId, text);
    if (slow) return slow;
    const msg = { id: table.code + ':' + (++table.chatSeq), kind: 'msg', from: who.playerId, name: m.name, spectator: !this.seatOf(table, who.playerId) || undefined, text, at: this.now() };
    table.chat.push(msg);
    if (table.chat.length > LIMITS.chatKeep) table.chat.splice(0, table.chat.length - LIMITS.chatKeep);
    this.t.broadcast(table.code, 'chat:msg', { code: table.code, msg });
    // Someone said hello: a bot at the table answers.
    const bots = table.players.filter(p => p.bot);
    const game = this.games[table.gameId];
    if (game.bots && bots.length) {
      const reply = game.bots.greetingReply(text, bots.map((_, i) => i), i => bots[i].bot, this.rng);
      if (reply) this.botSay(table, bots[reply.seat].id, reply.text);
    }
    return { ok: true, id: msg.id };
  }

  /**
   * Spam protection. Returns an error with `wait` (seconds) when someone posts
   * too quickly or repeats themselves, otherwise records the message and returns null.
   */
  chatTooFast(table, playerId, text) {
    const now = this.now();
    const h = table.chatLog.get(playerId) || { times: [], last: '', lastAt: 0 };
    h.times = h.times.filter(t => now - t < LIMITS.chatBurstMs);
    const secs = ms => Math.max(1, Math.ceil(ms / 1000));
    const lastAt = h.times[h.times.length - 1];
    if (lastAt != null && now - lastAt < LIMITS.chatGapMs) {
      const wait = secs(LIMITS.chatGapMs - (now - lastAt));
      return { error: 'Slow down: wait ' + wait + 's before sending another message.', code: 'slow', wait };
    }
    if (h.times.length >= LIMITS.chatBurst) {
      const wait = secs(LIMITS.chatBurstMs - (now - h.times[0]));
      return { error: 'You’re sending a lot of messages. Wait ' + wait + 's before the next one.', code: 'slow', wait };
    }
    const norm = text.toLowerCase().replace(/\s+/g, ' ');
    if (norm === h.last && now - h.lastAt < LIMITS.chatRepeatMs) {
      return { error: 'You just sent that. Try saying something new.', code: 'repeat' };
    }
    h.times.push(now); h.last = norm; h.lastAt = now;
    table.chatLog.set(playerId, h);
    return null;
  }

  /** Clean shutdown: stop every timer. In-memory games end with the process. */
  shutdown() {
    for (const t of this.tables.values()) {
      clearTimeout(t.timer); clearTimeout(t.abandonTimer);
      for (const p of [...t.players, ...t.spectators]) if (p.graceTimer) clearTimeout(p.graceTimer);
      this.t.broadcast(t.code, 'table:closed', { code: t.code, reason: 'restart' });
    }
    this.tables.clear();
    this.where.clear();
  }
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
