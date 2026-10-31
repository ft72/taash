/** Players, friends and leaderboards. Callers act only as themselves; ids in bodies are only targets. */
import { z } from 'zod';
import {
  getRating, ratingChange30d, matchHistory, leaderboard, listFriends, pendingRequests, sendFriendRequest, respondFriendRequest,
  cancelFriendRequest, removeFriendship, findUserByHandle, relationsOf, recentMatches, searchPlayers, PAGE,
} from '../db/social.js';
import { ratingTrend } from '../db/rating-trend.js';
import { TIERS } from '../cosmetics/catalog.js';
import { isOnline, openTablesOf, notifyUser, publicTables, tableOf } from '../server/live.js';
import { catalog } from '../../games/catalog.js';
import { fail, orFail, parse, limit, Handle, Page } from './http.js';

const HISTORY_PAGE = 20;
const RequestId = z.string().uuid('That request is no longer waiting for you.');

/** 'self' | 'friend' | 'sent' | 'received' | 'none' from the caller's point of view. */
function relationTo(rel, me, userId) {
  if (me.userId === userId) return 'self';
  if (!rel) return 'none';
  return rel.friends.includes(userId) ? 'friend' : rel.sent.includes(userId) ? 'sent' : rel.received.includes(userId) ? 'received' : 'none';
}
const relationsFor = me => (me.kind === 'user' ? relationsOf(me.userId) : null);

async function playerByHandle(raw) {
  const handle = Handle.safeParse(decodeURIComponent(raw || ''));
  const user = handle.success && await findUserByHandle(handle.data);
  return user || fail(404, 'Player not found.', { code: 'not-found' });
}

export async function player({ me, params }) {
  const user = await playerByHandle(params.handle);
  const [rating, history, change, trend, rel] = await Promise.all([getRating(user.id), matchHistory(user.id, { limit: HISTORY_PAGE }), ratingChange30d(user.id), ratingTrend(user.id), relationsFor(me)]);
  return { user: { ...user, online: isOnline(user.id) }, rating, history, change, trend, relation: relationTo(rel, me, user.id), hasMoreHistory: history.length === HISTORY_PAGE };
}

/** Older games, a page at a time (page 0 is what players/:handle already returned). */
export async function history({ params, query }) {
  const user = await playerByHandle(params.handle);
  const page = Page(query.get('page'));
  const rows = await matchHistory(user.id, { limit: HISTORY_PAGE, offset: page * HISTORY_PAGE });
  return { history: rows, page, pageSize: HISTORY_PAGE, hasMore: rows.length === HISTORY_PAGE };
}

export async function search({ me, query, ip }) {
  limit('lookup', me.userId || ip);
  const q = String(query.get('q') || '').trim().replace(/^@/, '');
  if (q.length < 2) return { players: [] };
  if (q.length > 24) fail(400, 'Search for a name or username.', { code: 'invalid' });
  const [rows, rel] = await Promise.all([searchPlayers(q, { limit: 21 }), relationsFor(me)]);
  return { players: rows.filter(r => r.id !== me.userId).slice(0, 20).map(r => ({ ...r, online: isOnline(r.id), relation: relationTo(rel, me, r.id) })) };
}

export async function board({ me, query }) {
  const scope = query.get('scope') === 'friends' ? 'friends' : 'all';
  const page = Page(query.get('page'));
  const [rows, rel] = await Promise.all([leaderboard({ scope, userId: me.userId, sort: query.get('sort') === 'firsts' ? 'firsts' : 'rating', page }), relationsFor(me)]);
  return {
    rows: rows.map(r => ({ ...r, online: isOnline(r.id), relation: relationTo(rel, me, r.id) })),
    page, pageSize: PAGE, hasMore: scope === 'all' && rows.length === PAGE, tiers: TIERS,
  };
}

/** The home tab: leaderboard preview, recent games, games, and (signed in) friends who are online. */
export async function home({ me }) {
  const user = me.kind === 'user';
  const [board, recent, friends, rating, change] = await Promise.all([
    leaderboard({ scope: user ? 'friends' : 'all', userId: me.userId }),
    recentMatches({ userId: user ? me.userId : null }),
    user ? listFriends(me.userId) : [],
    user ? getRating(me.userId) : null,
    user ? ratingChange30d(me.userId) : 0,
  ]);
  const online = friends.filter(f => isOnline(f.id));
  return {
    board: board.slice(0, 4), recent, games: catalog, rooms: publicTables(),
    activeTable: tableOf(me.playerId)?.code || null, rating, change,
    friendsOnline: online.map(f => ({ id: f.id, name: f.name, handle: f.handle, rating: f.rating })),
    friendTables: user ? openTablesOf(friends.map(f => f.id)) : [],
  };
}

export async function friends({ me }) {
  const [list, requests] = await Promise.all([listFriends(me.userId), pendingRequests(me.userId)]);
  return { friends: list.map(f => ({ ...f, online: isOnline(f.id) })), ...requests, tables: openTablesOf(list.map(f => f.id)) };
}

/** Tell the other person straight away (every tab and phone). Same events as the web. */
function announce(me, res) {
  const from = { name: me.name, handle: me.handle };
  if (res.status === 'accepted') notifyUser(res.toId, 'friend:accepted', { by: from });
  else notifyUser(res.toId, 'friend:request', { id: res.requestId, from });
}

export async function addFriend({ me, body }) {
  limit('friend', me.userId);
  const handle = parse(Handle, String(body.handle ?? ''));
  const res = orFail(await sendFriendRequest(me.userId, handle));
  announce(me, res);
  return { ok: true, status: res.status, name: res.name, requestId: res.requestId || null, message: res.status === 'accepted' ? 'You and ' + res.name + ' are now friends.' : 'Friend request sent to ' + res.name + '.' };
}

export async function respond({ me, body }) {
  limit('write', me.userId);
  const v = parse(z.object({ id: RequestId, accept: z.boolean({ error: 'Choose accept or decline.' }) }), body);
  const res = orFail(await respondFriendRequest(me.userId, v.id, v.accept));
  if (v.accept) notifyUser(res.requesterId, 'friend:accepted', { by: { name: me.name, handle: me.handle } });
  return { ok: true };
}

export async function cancel({ me, body }) {
  limit('write', me.userId);
  return cancelFriendRequest(me.userId, parse(RequestId, body.id));
}

export async function remove({ me, body }) {
  limit('write', me.userId);
  return removeFriendship(me.userId, parse(z.string().min(1).max(80), body.userId));
}
