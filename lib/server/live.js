/** Read-only access to live, in-memory state owned by the realtime server. */
import 'server-only';
import { pushIfOffline } from '../push/push.js';

export function isOnline(userId) { return !!globalThis.__taashPresence?.get(userId); }
export function tableManager() { return globalThis.__taashTables || null; }
export function openTablesOf(userIds) { const m = tableManager(); return m ? m.openTablesFor(userIds) : []; }
export function publicTables() { const m = tableManager(); return m ? m.publicTables() : []; }
/** Push an event to every open tab of a signed-in user (friend requests and the like), or to their phone if none is open. */
export function notifyUser(userId, event, data) {
  globalThis.__taashNotify?.(userId, event, data);
  pushIfOffline(userId, event, data);
}
/** Live connections keep the identity they opened with; refresh the display name after a profile edit. */
export function renameUser(userId, name, handle) { return globalThis.__taashRename?.(userId, name, handle); }
/** Close every live connection of a user (account deleted). */
export function disconnectUser(userId) { globalThis.__taashIo?.in('p:u:' + userId).disconnectSockets(true); }
export function tableOf(playerId) { const m = tableManager(); return m && playerId ? m.tableOf(playerId) : null; }
