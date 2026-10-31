/** Push notification devices (Expo push tokens) of registered players. */
import { and, eq, desc, inArray, notInArray } from 'drizzle-orm';
import { db } from './client.js';
import { pushDevices } from './schema.js';

export const MAX_DEVICES = 10;

/** Register (or move) a token to this user; keeps at most MAX_DEVICES per user, newest first. */
export async function saveDevice(userId, { token, platform, appVersion = null }) {
  const now = new Date();
  await db.insert(pushDevices).values({ token, userId, platform, appVersion, lastSeenAt: now })
    .onConflictDoUpdate({ target: pushDevices.token, set: { userId, platform, appVersion, lastSeenAt: now } });
  const keep = await db.select({ token: pushDevices.token }).from(pushDevices)
    .where(eq(pushDevices.userId, userId)).orderBy(desc(pushDevices.lastSeenAt)).limit(MAX_DEVICES);
  await db.delete(pushDevices).where(and(eq(pushDevices.userId, userId), notInArray(pushDevices.token, keep.map(k => k.token))));
}

/** Only the owner can remove a token (signing out on that phone). */
export async function removeDevice(userId, token) {
  await db.delete(pushDevices).where(and(eq(pushDevices.userId, userId), eq(pushDevices.token, token)));
}

export async function devicesOf(userId) {
  return db.select({ token: pushDevices.token, platform: pushDevices.platform }).from(pushDevices).where(eq(pushDevices.userId, userId)).limit(MAX_DEVICES);
}

/** Tokens Expo says are no longer registered (app uninstalled, notifications revoked). */
export async function forgetTokens(tokens) {
  if (tokens.length) await db.delete(pushDevices).where(inArray(pushDevices.token, tokens));
}

/** Every session was revoked (password change or reset, sign-out everywhere): stop pushing to old phones. */
export async function removeAllDevices(userId) {
  await db.delete(pushDevices).where(eq(pushDevices.userId, userId));
}
