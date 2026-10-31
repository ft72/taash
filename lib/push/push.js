/**
 * Push notifications through Expo's push service, for players whose app is
 * closed. Only sent when the player has no live connection: an open app or
 * browser tab already shows the event in-app. Fire-and-forget — a failed push
 * never fails the action that caused it.
 */
import { config } from '../env.js';
import { log } from '../log.js';
import { devicesOf, forgetTokens } from '../db/devices.js';
import { gameMeta } from '../../games/catalog.js';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
export const PUSH_TOKEN = /^Expo(nent)?PushToken\[[\w-]{10,120}\]$/;

/** @param {object[]} messages @returns {Promise<{status:string, details?:{error?:string}}[]>} */
async function expoTransport(messages) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (config.push.expoAccessToken) headers.authorization = 'Bearer ' + config.push.expoAccessToken;
  const res = await fetch(EXPO_URL, { method: 'POST', headers, body: JSON.stringify(messages), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('Expo push answered ' + res.status);
  return (await res.json()).data || [];
}

let transport = expoTransport;
/** Tests replace the network call. Pass nothing to restore it. */
export function setPushTransport(fn) { transport = fn || expoTransport; }

/** What each realtime event looks like as a notification. `data` is what the app gets when it is tapped. */
const TEMPLATES = {
  'friend:request': d => ({
    title: 'Friend request', body: d.from.name + ' (@' + d.from.handle + ') wants to be friends.',
    data: { type: 'friend:request', id: d.id, handle: d.from.handle },
  }),
  'friend:accepted': d => ({
    title: 'New friend', body: d.by.name + ' accepted your friend request.',
    data: { type: 'friend:accepted', handle: d.by.handle },
  }),
  invite: d => ({
    title: 'Table invite', body: d.from.name + ' invited you to play ' + (gameMeta(d.gameId)?.name || 'cards') + ' at table ' + d.code + '.',
    data: { type: 'invite', code: d.code, gameId: d.gameId, url: config.appUrl + '/t/' + d.code }, ttl: 15 * 60,
  }),
};

export async function pushToUser(userId, { title, body, data, ttl }) {
  const devices = await devicesOf(userId);
  if (!devices.length) return 0;
  const tickets = await transport(devices.map(d => ({ to: d.token, title, body, data, sound: 'default', priority: 'high', ...(ttl ? { ttl } : {}) })));
  const dead = devices.filter((d, i) => tickets[i]?.details?.error === 'DeviceNotRegistered').map(d => d.token);
  await forgetTokens(dead);
  return devices.length - dead.length;
}

/** Push a realtime event to a registered user's phones if they aren't connected anywhere. */
export function pushIfOffline(userId, event, data) {
  const make = TEMPLATES[event];
  if (!make || !userId || !config.push.enabled || globalThis.__taashPresence?.get(userId)) return;
  pushToUser(userId, make(data)).catch(e => log.warn('push failed', { event, err: e.message }));
}
