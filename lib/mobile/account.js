/** The signed-in player's own account: profile, security, wallet, push devices, deletion. */
import { eq, sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { userViewer } from '../auth/identity.js';
import { invalidateUser } from '../auth/user-cache.js';
import { getUser, getRating, ratingChange30d, matchHistory, relationsOf } from '../db/social.js';
import { cosmeticsState, coinHistory } from '../db/cosmetics.js';
import { ratingTrend } from '../db/rating-trend.js';
import { saveDevice, removeDevice, removeAllDevices } from '../db/devices.js';
import { deleteAccount as deleteUserRow } from '../db/account.js';
import { publicTables, tableOf, tableManager, renameUser, disconnectUser } from '../server/live.js';
import { PUSH_TOKEN } from '../push/push.js';
import { log } from '../log.js';
import { fail, parse, limit, Name, Handle, Password } from './http.js';
import { userSession } from './auth.js';

const isUnique = e => e.code === '23505' || e.cause?.code === '23505';

/** Everything the app's profile tab and home header need in one call. */
export async function me({ me }) {
  const activeTable = tableOf(me.playerId);
  if (me.kind !== 'user') return { viewer: me, rooms: publicTables(), activeTable: activeTable?.code || null, table: activeTable, rating: null, history: [], cosmetics: null, change: 0 };
  const [user, rating, history, cosmetics, change, trend, relations] = await Promise.all([
    getUser(me.userId), getRating(me.userId), matchHistory(me.userId), cosmeticsState(me.userId), ratingChange30d(me.userId), ratingTrend(me.userId), relationsOf(me.userId),
  ]);
  return { viewer: me, user, rating, history, cosmetics, change, trend, relations, friendsCount: relations.friends.length, activeTable: activeTable?.code || null, table: activeTable, rooms: publicTables() };
}

/** Change display name and/or username. Only ever the caller's own row. */
export async function profile({ me, body }) {
  limit('write', me.userId);
  const v = parse(z.object({ name: Name.optional(), handle: Handle.optional() }).refine(v => v.name != null || v.handle != null, { message: 'Nothing to change.' }), body);
  const patch = {};
  if (v.name != null) patch.name = v.name;
  if (v.handle != null && v.handle !== String(me.handle || '').toLowerCase()) {
    const [taken] = await db.select({ id: users.id }).from(users).where(dsql`lower(${users.handle}) = ${v.handle} and ${users.id} <> ${me.userId}`).limit(1);
    if (taken) fail(409, 'That username is taken. Try another.', { code: 'taken', field: 'handle' });
    patch.handle = v.handle;
  }
  if (Object.keys(patch).length) {
    try { await db.update(users).set(patch).where(eq(users.id, me.userId)); }
    catch (e) { if (isUnique(e)) fail(409, 'That username was just taken. Try another.', { code: 'taken', field: 'handle' }); throw e; }
    invalidateUser(me.userId);
  }
  const name = patch.name ?? me.name, handle = patch.handle ?? me.handle;
  await renameUser(me.userId, name, handle);
  return { ok: true, viewer: userViewer(me.userId, name, handle) };
}

/** Changing the password signs out every other device; this one gets a fresh session back. */
export async function password({ me, body }) {
  limit('password', me.userId);
  const v = parse(z.object({ current: z.string({ error: 'Enter your current password.' }).min(1, 'Enter your current password.').max(200), next: Password }), body);
  const [u] = await db.select().from(users).where(eq(users.id, me.userId)).limit(1);
  if (!u?.passwordHash || !(await verifyPassword(u.passwordHash, v.current))) fail(400, 'Your current password is not right.', { code: 'credentials', field: 'current' });
  const [next] = await db.update(users).set({ passwordHash: await hashPassword(v.next), sessionVersion: dsql`${users.sessionVersion} + 1` })
    .where(eq(users.id, me.userId)).returning();
  invalidateUser(me.userId);
  await removeAllDevices(me.userId);   // this phone registers again with its new session
  return { ok: true, ...userSession(next) };
}

/** Revoke every session (browser and phones). With keepThisDevice, this phone gets a fresh one. */
export async function logoutEverywhere({ me, body }) {
  limit('write', me.userId);
  const [u] = await db.update(users).set({ sessionVersion: dsql`${users.sessionVersion} + 1` }).where(eq(users.id, me.userId)).returning();
  invalidateUser(me.userId);
  await removeAllDevices(me.userId);
  return body.keepThisDevice === true && u ? { ok: true, ...userSession(u) } : { ok: true };
}

/** Permanently delete the account. Needs the password, and can't happen mid-game. */
export async function deleteAccount({ me, body }) {
  limit('password', me.userId);
  const v = parse(z.object({ password: z.string({ error: 'Enter your password to confirm.' }).min(1, 'Enter your password to confirm.').max(200) }), body);
  const [u] = await db.select().from(users).where(eq(users.id, me.userId)).limit(1);
  if (!u?.passwordHash || !(await verifyPassword(u.passwordHash, v.password))) fail(400, 'Your password is not right.', { code: 'credentials', field: 'password' });
  const at = tableOf(me.playerId), manager = tableManager();
  if (at?.status === 'playing' && at.role === 'player') fail(409, 'Finish or forfeit your game at table ' + at.code + ' before deleting your account.', { code: 'in-game', table: at.code });
  if (at && manager) manager.leave(me, at.code);
  await deleteUserRow(me.userId);
  invalidateUser(me.userId);
  disconnectUser(me.userId);
  log.info('account deleted', { userId: me.userId });
  return { ok: true };
}

export async function wallet({ me }) {
  const [state, events] = await Promise.all([cosmeticsState(me.userId), coinHistory(me.userId)]);
  return { coins: state.coins, earned: state.earned, events };
}

const Device = z.object({
  token: z.string().max(200).regex(PUSH_TOKEN, 'That isn’t an Expo push token.'),
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().max(40).optional(),
});
export async function registerDevice({ me, body }) {
  limit('write', me.userId);
  await saveDevice(me.userId, parse(Device, body));
  return { ok: true };
}
export async function removeDeviceRoute({ me, body }) {
  await removeDevice(me.userId, parse(Device.shape.token, body.token));
  return { ok: true };
}
