/* The native app's HTTP API (/api/mobile/*) against the real database and
   Socket.IO server: sessions, account security, friends, push, table previews,
   history, wallet and account deletion.
   Needs PostgreSQL (DATABASE_URL, migrated). Run: npm run test:integration */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { io as connect } from 'socket.io-client';
import { attachRealtime } from '../../lib/realtime/socket-server.js';
import { handleMobile } from '../../lib/mobile/router.js';
import { setPushTransport } from '../../lib/push/push.js';
import { db, sql } from '../../lib/db/client.js';
import { users, matches, matchPlayers, wallets, pushDevices } from '../../lib/db/schema.js';
import { ITEMS } from '../../lib/cosmetics/catalog.js';
import { DELETED_NAME } from '../../lib/db/account.js';
import { defaultSettings } from '../../games/thulla/settings.js';

let server, rt, url;
const sockets = [];
const pushed = [];
before(async () => {
  server = createServer();
  rt = attachRealtime(server);
  await new Promise(r => server.listen(0, r));
  url = 'http://localhost:' + server.address().port;
  setPushTransport(async messages => {
    pushed.push(...messages);
    return messages.map(m => (m.to.includes('Gone') ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }));
  });
});
after(async () => {
  setPushTransport(null);
  sockets.forEach(s => s.disconnect());
  rt.manager.shutdown(); rt.io.close(); server.close();
  await sql.end();
});

const suffix = () => randomBytes(4).toString('hex');
const ip = () => '10.' + [0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.');
async function call(method, path, { token, body, headers = {} } = {}) {
  const init = { method, headers: { 'x-forwarded-for': ip(), ...headers } };
  if (token) init.headers.authorization = 'Bearer ' + token;
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const res = await handleMobile(new Request('http://localhost/api/mobile/' + path, init), method, path.split('?')[0].split('/'));
  return { status: res.status, data: await res.json(), headers: res.headers };
}
const get = (path, token) => call('GET', path, { token });
const post = (path, body, token) => call('POST', path, { token, body });

async function account(name = 'Player') {
  const handle = 'm' + suffix();
  const r = await post('auth/register', { name, handle, email: handle + '@example.test', password: 'correct horse', confirm: 'correct horse' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return { ...r.data, handle, email: handle + '@example.test' };
}
function open(token) {
  const s = connect(url, { transports: ['websocket'], auth: { token }, reconnection: false });
  sockets.push(s);
  return new Promise(res => s.once('session', sess => res({ s, sess })));
}
const ask = (s, ev, payload) => new Promise(res => s.timeout(3000).emit(ev, payload, (err, r) => res(err ? { timeout: true } : r)));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 20)); }
  return false;
}

test('public endpoints, unknown routes, wrong methods, origins and bad JSON', async () => {
  const cfg = await get('config');
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(cfg.data.api, 2);
  assert.deepStrictEqual(cfg.data.settings.thulla.defaults, defaultSettings());
  assert.ok(cfg.data.bots.thulla.length >= 1 && cfg.data.bots.thulla[0].id);
  assert.strictEqual(cfg.data.tableOptions.defaults.visibility, 'private');
  for (const p of ['rooms', 'catalog', 'sounds', 'home', 'leaderboard']) assert.strictEqual((await get(p)).status, 200, p);
  assert.strictEqual((await get('nope')).status, 404);
  assert.strictEqual((await get('friends/add')).status, 405);
  assert.strictEqual((await call('GET', 'config', { headers: { origin: 'https://evil.example' } })).status, 403);
  const ok = await call('GET', 'config', { headers: { origin: 'http://localhost:8081' } });
  assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  assert.strictEqual((await post('auth/signin', '{not json')).status, 400);
  assert.strictEqual((await post('auth/signin', '[1,2]')).status, 400);
  assert.strictEqual((await post('auth/signin', 'x'.repeat(20_000))).status, 413);
});

test('guests: stable identity across renames; account-only routes refuse them', async () => {
  const g = await post('auth/guest', { name: 'Hira' });
  assert.strictEqual(g.data.viewer.kind, 'guest');
  assert.ok(Date.parse(g.data.expiresAt) > Date.now() + 29 * 86400_000);
  const renamed = await post('auth/guest', { name: 'Hira B' }, g.data.token);
  assert.strictEqual(renamed.data.viewer.playerId, g.data.viewer.playerId);
  assert.strictEqual((await get('me', renamed.data.token)).data.viewer.name, 'Hira B');
  const denied = await get('friends', g.data.token);
  assert.deepStrictEqual([denied.status, denied.data.code], [403, 'account-required']);
  const anon = await get('me');
  assert.deepStrictEqual([anon.status, anon.data.code], [401, 'auth']);
  assert.strictEqual((await post('auth/guest', { name: '<b>' })).status, 400);
  const refreshed = await post('auth/refresh', {}, g.data.token);
  assert.strictEqual(refreshed.data.viewer.playerId, g.data.viewer.playerId);
});

test('registration names the clashing field; sign-in by email, handle or @handle', async () => {
  const a = await account('Asad');
  const dupEmail = await post('auth/register', { name: 'X', handle: 'x' + suffix(), email: a.email.toUpperCase(), password: 'abcdefgh' });
  assert.deepStrictEqual([dupEmail.status, dupEmail.data.field], [409, 'email']);
  const dupHandle = await post('auth/register', { name: 'X', handle: a.handle.toUpperCase(), email: suffix() + '@example.test', password: 'abcdefgh' });
  assert.deepStrictEqual([dupHandle.status, dupHandle.data.field], [409, 'handle']);
  const mismatch = await post('auth/register', { name: 'X', handle: 'x' + suffix(), email: suffix() + '@example.test', password: 'abcdefgh', confirm: 'abcdefgX' });
  assert.deepStrictEqual([mismatch.status, mismatch.data.field], [400, 'confirm']);
  for (const login of [a.email, a.handle, '@' + a.handle.toUpperCase()]) {
    const r = await post('auth/signin', { login, password: 'correct horse' });
    assert.strictEqual(r.data.viewer.userId, a.viewer.userId, login);
  }
  const wrong = await post('auth/signin', { login: a.handle, password: 'nope nope' });
  assert.deepStrictEqual([wrong.status, wrong.data.code], [401, 'credentials']);
  const forgot = await post('auth/forgot', { login: 'nobody-' + suffix() });
  assert.strictEqual(forgot.data.ok, true);
  assert.strictEqual((await post('auth/reset', { token: 'x'.repeat(40), password: 'abcdefgh', confirm: 'abcdefgh' })).data.code, 'expired');
});

test('profile edits are partial, keep ownership and update live sockets', async () => {
  const a = await account('Asad'), b = await account('Bilal');
  const { s } = await open(a.token);
  const nameOnly = await post('profile', { name: 'Asad K' }, a.token);
  assert.deepStrictEqual([nameOnly.data.viewer.name, nameOnly.data.viewer.handle], ['Asad K', a.handle]);
  const taken = await post('profile', { handle: '@' + b.handle }, a.token);
  assert.deepStrictEqual([taken.status, taken.data.field], [409, 'handle']);
  assert.strictEqual((await post('profile', {}, a.token)).status, 400);
  const avail = await get('auth/handle?handle=' + a.handle, a.token);
  assert.strictEqual(avail.data.available, true);                     // your own handle
  assert.strictEqual((await get('auth/handle?handle=' + b.handle, a.token)).data.available, false);
  const { code } = await ask(s, 'table:create', { gameId: 'thulla', settings: defaultSettings() });
  assert.strictEqual(rt.manager.get(code).players[0].name, 'Asad K'); // the socket picked up the new name
  await ask(s, 'table:leave', { code });
});

test('password change revokes old sessions but hands this phone a new one; sign-out-everywhere can keep this device', async () => {
  const a = await account();
  const other = (await post('auth/signin', { login: a.handle, password: 'correct horse' })).data.token;
  const bad = await post('password', { current: 'wrong', next: 'new password 1' }, a.token);
  assert.deepStrictEqual([bad.status, bad.data.field], [400, 'current']);
  const changed = await post('password', { current: 'correct horse', next: 'new password 1' }, a.token);
  assert.ok(changed.data.token);
  assert.strictEqual((await get('me', a.token)).status, 401);
  assert.strictEqual((await get('me', other)).status, 401);
  assert.strictEqual((await get('me', changed.data.token)).data.viewer.userId, a.viewer.userId);
  await post('devices', { token: 'ExponentPushToken[' + suffix() + suffix() + ']', platform: 'ios' }, changed.data.token);
  const kept = await post('logout-everywhere', { keepThisDevice: true }, changed.data.token);
  assert.strictEqual((await db.select().from(pushDevices).where(eq(pushDevices.userId, a.viewer.userId))).length, 0, 'revoking sessions stops pushes to old phones');
  assert.strictEqual((await get('me', changed.data.token)).status, 401);
  assert.strictEqual((await get('me', kept.data.token)).status, 200);
  const plain = await post('logout-everywhere', {}, kept.data.token);
  assert.strictEqual(plain.data.token, undefined);
  assert.strictEqual((await post('auth/refresh', {}, kept.data.token)).status, 401);
});

test('friends: requests, relations on profiles/search/leaderboard, and push only when offline', async () => {
  const a = await account('Asad'), b = await account('Bilal');
  assert.strictEqual((await post('devices', { token: 'not-a-token', platform: 'ios' }, b.token)).status, 400);
  const device = 'ExponentPushToken[' + suffix() + suffix() + ']';
  assert.strictEqual((await post('devices', { token: device, platform: 'ios', appVersion: '1.0.0' }, b.token)).data.ok, true);

  pushed.length = 0;
  const sent = await post('friends/add', { handle: '@' + b.handle }, a.token);
  assert.deepStrictEqual([sent.data.status, typeof sent.data.requestId], ['pending', 'string']);
  assert.ok(await until(() => pushed.some(m => m.to === device && m.data.type === 'friend:request')), 'offline friend gets a push');
  assert.strictEqual((await post('friends/add', { handle: b.handle }, a.token)).status, 400);   // already sent

  assert.strictEqual((await get('players/' + b.handle, a.token)).data.relation, 'sent');
  assert.strictEqual((await get('players/' + a.handle, b.token)).data.relation, 'received');
  assert.strictEqual((await get('players/' + a.handle, a.token)).data.relation, 'self');
  const found = await get('players/search?q=' + b.handle.slice(0, 5), a.token);
  assert.ok(found.data.players.some(p => p.handle === b.handle && p.relation === 'sent'));
  assert.ok(!found.data.players.some(p => p.id === a.viewer.userId), 'search leaves out the caller');
  assert.ok(!('email' in found.data.players[0]));

  const { s: bSocket } = await open(b.token);                          // B comes online: no more pushes
  const incoming = (await get('friends', b.token)).data.incoming;
  assert.strictEqual(incoming[0].user.handle, a.handle);
  pushed.length = 0;
  const { s: aSocket } = await open(a.token);
  const accepted = new Promise(res => aSocket.once('friend:accepted', res));
  assert.strictEqual((await post('friends/respond', { id: incoming[0].id, accept: true }, b.token)).data.ok, true);
  await accepted;
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(pushed.length, 0, 'online users are not pushed');
  const board = await get('leaderboard?scope=friends', a.token);
  assert.ok(board.data.rows.some(r => r.handle === b.handle && r.relation === 'friend' && r.online === true));
  const home = await get('home', a.token);
  assert.ok(home.data.friendsOnline.some(f => f.handle === b.handle));

  // An invite to an offline friend is pushed; dead tokens are forgotten.
  bSocket.disconnect();
  await until(() => !globalThis.__taashPresence.get(b.viewer.userId));
  const dead = 'ExponentPushToken[Gone' + suffix() + suffix() + ']';
  await post('devices', { token: dead, platform: 'android' }, b.token);
  const host = aSocket;
  const { code } = await ask(host, 'table:create', { gameId: 'thulla', settings: defaultSettings() });
  await ask(host, 'table:join', { code });
  pushed.length = 0;
  assert.strictEqual((await ask(host, 'table:invite', { code, userIds: [b.viewer.userId] })).sent, 1);
  assert.ok(await until(() => pushed.filter(m => m.data.type === 'invite' && m.data.code === code).length === 2));
  assert.ok(await until(async () => !(await db.select().from(pushDevices).where(eq(pushDevices.token, dead))).length), 'dead token removed');
  await ask(host, 'table:leave', { code });

  assert.strictEqual((await post('friends/remove', { userId: b.viewer.userId }, a.token)).data.ok, true);
  assert.strictEqual((await get('players/' + b.handle, a.token)).data.relation, 'none');
  await post('auth/signout', { pushToken: device }, b.token);
  assert.strictEqual((await db.select().from(pushDevices).where(eq(pushDevices.userId, b.viewer.userId))).length, 0);
});

test('table preview by code: seats, guests and who may sit or watch', async () => {
  const host = await account('Host');
  const { s } = await open(host.token);
  const { code } = await ask(s, 'table:create', { gameId: 'thulla', settings: { ...defaultSettings(), players: 2 }, options: { allowGuests: false, spectators: 0 } });
  await ask(s, 'table:join', { code });
  const anon = await get('tables/' + code.replace('-', '').toLowerCase());
  assert.strictEqual(anon.data.table.code, code);
  assert.deepStrictEqual([anon.data.table.canSit, anon.data.table.canWatch, anon.data.table.host.handle], [true, false, host.handle]);
  const guest = (await post('auth/guest', { name: 'Guesty' })).data.token;
  const asGuest = (await get('tables/' + code, guest)).data.table;
  assert.deepStrictEqual([asGuest.canSit, asGuest.reason], [false, 'no-guests']);
  const mine = (await get('tables/' + code, host.token)).data.table;
  assert.deepStrictEqual([mine.you, mine.canSit], ['player', true]);
  assert.strictEqual((await get('tables/ZZZ-999')).status, 404);
  assert.strictEqual((await get('tables/nonsense')).status, 404);
  await ask(s, 'table:leave', { code });
});

test('match history pages; wallet shows coins earned and spent; equip returns the new look', async () => {
  const a = await account('Asad');
  for (let i = 0; i < 25; i++) {
    const id = randomUUID();
    await db.insert(matches).values({ id, gameId: 'thulla', tableCode: 'HIS-' + String(i).padStart(3, '0'), gameNo: 1, settings: defaultSettings(), playerCount: 2, startedAt: new Date(Date.now() - (i + 1) * 60_000), endedAt: new Date(Date.now() - i * 60_000) });
    await db.insert(matchPlayers).values([{ matchId: id, seat: 0, userId: a.viewer.userId, displayName: 'Asad', place: 1 }, { matchId: id, seat: 1, userId: null, displayName: 'Guest', place: 2, isLoser: true }]);
  }
  const profile = await get('players/' + a.handle);
  assert.deepStrictEqual([profile.data.history.length, profile.data.hasMoreHistory], [20, true]);
  const page1 = await get('players/' + a.handle + '/history?page=1');
  assert.deepStrictEqual([page1.data.history.length, page1.data.hasMore], [5, false]);
  assert.strictEqual(page1.data.history[0].tableCode, 'HIS-020');

  const item = ITEMS.find(i => i.price && !i.minPeak);
  await db.insert(wallets).values({ userId: a.viewer.userId, coins: item.price + 5, earned: item.price + 5 });
  assert.strictEqual((await post('shop/equip', { itemId: item.id }, a.token)).status, 400);   // not owned yet
  const bought = await post('shop/buy', { itemId: item.id }, a.token);
  assert.strictEqual(bought.data.coins, 5);
  assert.strictEqual((await post('shop/buy', { itemId: item.id }, a.token)).status, 400);    // already owned
  const equipped = await post('shop/equip', { itemId: item.id }, a.token);
  assert.strictEqual(equipped.data.equipped[item.kind], item.id);
  const w = await get('wallet', a.token);
  assert.strictEqual(w.data.coins, 5);
  assert.deepStrictEqual([w.data.events[0].amount, w.data.events[0].itemName], [-item.price, item.name]);
});

test('account deletion: password required, blocked mid-game, then everything personal is gone', async () => {
  const a = await account('Asad'), b = await account('Bilal');
  await post('friends/add', { handle: b.handle }, a.token);
  await post('devices', { token: 'ExpoPushToken[' + suffix() + suffix() + ']', platform: 'android' }, a.token);
  const id = randomUUID();
  await db.insert(matches).values({ id, gameId: 'thulla', tableCode: 'DEL-001', gameNo: 1, settings: defaultSettings(), playerCount: 2, startedAt: new Date() });
  await db.insert(matchPlayers).values([{ matchId: id, seat: 0, userId: a.viewer.userId, displayName: 'Asad', place: 1 }, { matchId: id, seat: 1, userId: b.viewer.userId, displayName: 'Bilal', place: 2, isLoser: true }]);

  const { s: sa } = await open(a.token), { s: sb } = await open(b.token);
  const { code } = await ask(sa, 'table:create', { gameId: 'thulla', settings: { ...defaultSettings(), players: 2 } });
  await ask(sa, 'table:join', { code });
  await ask(sb, 'table:join', { code });
  await ask(sb, 'table:ready', { code, ready: true });
  assert.ok((await ask(sa, 'table:start', { code })).ok);

  assert.strictEqual((await post('account/delete', { password: 'wrong' }, a.token)).data.field, 'password');
  const busy = await post('account/delete', { password: 'correct horse' }, a.token);
  assert.deepStrictEqual([busy.status, busy.data.code, busy.data.table], [409, 'in-game', code]);
  await ask(sa, 'table:forfeit', { code });
  await until(() => rt.manager.get(code)?.status !== 'playing');

  const disconnected = new Promise(res => sa.once('disconnect', res));
  assert.strictEqual((await post('account/delete', { password: 'correct horse' }, a.token)).data.ok, true);
  await disconnected;
  assert.strictEqual((await get('me', a.token)).status, 401);
  assert.strictEqual((await db.select().from(users).where(eq(users.id, a.viewer.userId))).length, 0);
  assert.strictEqual((await db.select().from(pushDevices).where(eq(pushDevices.userId, a.viewer.userId))).length, 0);
  const left = await db.select().from(matchPlayers).where(eq(matchPlayers.matchId, id));
  assert.deepStrictEqual(left.map(p => [p.seat, p.userId, p.displayName]).sort(), [[0, null, DELETED_NAME], [1, b.viewer.userId, 'Bilal']]);
  assert.strictEqual((await get('friends', b.token)).data.incoming.length, 0);
  assert.strictEqual((await post('auth/signin', { login: a.handle, password: 'correct horse' })).status, 401);
});
