/**
 * Friends, profiles, history and leaderboards. All queries are selective,
 * indexed and limited — nothing scans a player's full history.
 */
import { and, eq, or, desc, inArray, sql as dsql } from 'drizzle-orm';
import { db } from './client.js';
import { users, friendships, playerRatings, matches, matchPlayers, ratingEvents } from './schema.js';
import { BASE_RATING } from '../ratings/elo.js';

export const PAGE = 50;

/* ---------------- users ---------------- */

export async function findUserByHandle(handle) {
  const [u] = await db.select({ id: users.id, name: users.name, handle: users.handle, createdAt: users.createdAt })
    .from(users).where(dsql`lower(${users.handle}) = ${String(handle).toLowerCase()}`).limit(1);
  return u || null;
}

/**
 * Players whose handle starts with, or name contains, the query (for "add a
 * friend"). Small and bounded; never returns emails.
 */
export async function searchPlayers(query, { gameId = 'thulla', limit = 20 } = {}) {
  const q = String(query).toLowerCase().replace(/^@/, '').replace(/[\\%_]/g, m => '\\' + m);
  return db.select({ id: users.id, name: users.name, handle: users.handle, rating: dsql`coalesce(${playerRatings.rating}, ${BASE_RATING})`.mapWith(Number) })
    .from(users).leftJoin(playerRatings, and(eq(playerRatings.userId, users.id), eq(playerRatings.gameId, gameId)))
    .where(or(dsql`lower(${users.handle}) like ${q + '%'}`, dsql`lower(${users.name}) like ${'%' + q + '%'}`))
    .orderBy(dsql`lower(${users.handle}) like ${q + '%'} desc`, dsql`lower(${users.handle})`).limit(limit);
}

export async function getUser(id) {
  const [u] = await db.select({ id: users.id, name: users.name, handle: users.handle, email: users.email, createdAt: users.createdAt, prefs: users.prefs })
    .from(users).where(eq(users.id, id)).limit(1);
  return u || null;
}

/* ---------------- friends ---------------- */

/** Accepted friends of a user, with their rating for one game. */
export async function listFriends(userId, gameId = 'thulla') {
  const rows = await db.select({
    id: users.id, name: users.name, handle: users.handle,
    rating: playerRatings.rating, played: playerRatings.played, firsts: playerRatings.firsts,
  }).from(friendships)
    .innerJoin(users, dsql`${users.id} = case when ${friendships.requesterId} = ${userId} then ${friendships.addresseeId} else ${friendships.requesterId} end`)
    .leftJoin(playerRatings, and(eq(playerRatings.userId, users.id), eq(playerRatings.gameId, gameId)))
    .where(and(eq(friendships.status, 'accepted'), or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))))
    .limit(500);
  return rows.map(r => ({ ...r, rating: r.rating ?? BASE_RATING, played: r.played ?? 0, firsts: r.firsts ?? 0 }));
}

export async function friendIds(userId) {
  const rows = await db.select({ a: friendships.requesterId, b: friendships.addresseeId }).from(friendships)
    .where(and(eq(friendships.status, 'accepted'), or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))))
    .limit(500);
  return rows.map(r => (r.a === userId ? r.b : r.a));
}

export async function areFriends(a, b) {
  const [row] = await db.select({ id: friendships.id }).from(friendships).where(and(
    eq(friendships.status, 'accepted'),
    dsql`least(${friendships.requesterId}, ${friendships.addresseeId}) = least(${a}::text, ${b}::text)`,
    dsql`greatest(${friendships.requesterId}, ${friendships.addresseeId}) = greatest(${a}::text, ${b}::text)`,
  )).limit(1);
  return !!row;
}

export async function pendingRequests(userId) {
  const incoming = await db.select({ id: friendships.id, at: friendships.createdAt, user: { id: users.id, name: users.name, handle: users.handle } })
    .from(friendships).innerJoin(users, eq(users.id, friendships.requesterId))
    .where(and(eq(friendships.addresseeId, userId), eq(friendships.status, 'pending'))).orderBy(desc(friendships.createdAt)).limit(100);
  const outgoing = await db.select({ id: friendships.id, at: friendships.createdAt, user: { id: users.id, name: users.name, handle: users.handle } })
    .from(friendships).innerJoin(users, eq(users.id, friendships.addresseeId))
    .where(and(eq(friendships.requesterId, userId), eq(friendships.status, 'pending'))).orderBy(desc(friendships.createdAt)).limit(100);
  return { incoming, outgoing };
}

/** @returns {Promise<{ok:true, status:'pending'|'accepted'} | {error:string}>} */
export async function sendFriendRequest(fromId, handle) {
  const to = await findUserByHandle(handle);
  if (!to) return { error: 'No player uses the handle @' + handle + '.' };
  if (to.id === fromId) return { error: 'You cannot add yourself.' };
  const [existing] = await db.select().from(friendships).where(and(
    dsql`least(${friendships.requesterId}, ${friendships.addresseeId}) = least(${fromId}::text, ${to.id}::text)`,
    dsql`greatest(${friendships.requesterId}, ${friendships.addresseeId}) = greatest(${fromId}::text, ${to.id}::text)`,
  )).limit(1);
  if (existing) {
    if (existing.status === 'accepted') return { error: 'You are already friends with ' + to.name + '.' };
    if (existing.requesterId === fromId) return { error: 'You already sent ' + to.name + ' a request.' };
    // They had already asked us: accepting is the natural outcome.
    await db.update(friendships).set({ status: 'accepted', respondedAt: new Date() }).where(eq(friendships.id, existing.id));
    return { ok: true, status: 'accepted', name: to.name, toId: to.id };
  }
  let row;
  try {
    [row] = await db.insert(friendships).values({ requesterId: fromId, addresseeId: to.id }).returning({ id: friendships.id });
  } catch {
    return { error: 'That request already exists.' };
  }
  return { ok: true, status: 'pending', name: to.name, toId: to.id, requestId: row?.id };
}

/** Only the addressee may accept/decline; either side may cancel/remove. */
export async function respondFriendRequest(userId, requestId, accept) {
  const [row] = await db.select().from(friendships).where(eq(friendships.id, requestId)).limit(1);
  if (!row || row.status !== 'pending' || row.addresseeId !== userId) return { error: 'That request is no longer waiting for you.' };
  if (accept) await db.update(friendships).set({ status: 'accepted', respondedAt: new Date() }).where(eq(friendships.id, requestId));
  else await db.delete(friendships).where(eq(friendships.id, requestId));
  return { ok: true, requesterId: row.requesterId };
}

export async function removeFriendship(userId, otherId) {
  await db.delete(friendships).where(and(
    or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)),
    or(eq(friendships.requesterId, otherId), eq(friendships.addresseeId, otherId)),
  ));
  return { ok: true };
}

export async function cancelFriendRequest(userId, requestId) {
  await db.delete(friendships).where(and(eq(friendships.id, requestId), eq(friendships.requesterId, userId), eq(friendships.status, 'pending')));
  return { ok: true };
}

/* ---------------- ratings, history ---------------- */

export async function getRating(userId, gameId = 'thulla') {
  const [r] = await db.select().from(playerRatings).where(and(eq(playerRatings.userId, userId), eq(playerRatings.gameId, gameId))).limit(1);
  return r || { rating: BASE_RATING, peak: BASE_RATING, played: 0, firsts: 0, losses: 0, winStreak: 0, loseStreak: 0, bestWinStreak: 0 };
}

/** Rating change over the last 30 days (sum of deltas). */
export async function ratingChange30d(userId, gameId = 'thulla') {
  const [r] = await db.select({ s: dsql`coalesce(sum(${ratingEvents.delta}), 0)::int` }).from(ratingEvents)
    .where(and(eq(ratingEvents.userId, userId), eq(ratingEvents.gameId, gameId), dsql`${ratingEvents.createdAt} > now() - interval '30 days'`));
  return r ? r.s : 0;
}

/** Most recent games for a user, with the other players and the rating change. */
export async function matchHistory(userId, { gameId = 'thulla', limit = 20, offset = 0 } = {}) {
  const mine = await db.select({
    matchId: matchPlayers.matchId, place: matchPlayers.place, isLoser: matchPlayers.isLoser, seat: matchPlayers.seat,
    endedAt: matches.endedAt, tableCode: matches.tableCode, playerCount: matches.playerCount, summary: matches.summary,
    delta: ratingEvents.delta,
  }).from(matchPlayers)
    .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
    .leftJoin(ratingEvents, and(eq(ratingEvents.matchId, matchPlayers.matchId), eq(ratingEvents.userId, userId)))
    .where(and(eq(matchPlayers.userId, userId), eq(matches.gameId, gameId)))
    .orderBy(desc(matches.endedAt)).limit(limit).offset(offset);
  if (!mine.length) return [];
  const others = await db.select({ matchId: matchPlayers.matchId, name: matchPlayers.displayName, userId: matchPlayers.userId, place: matchPlayers.place })
    .from(matchPlayers).where(inArray(matchPlayers.matchId, mine.map(m => m.matchId)));
  return mine.map(m => ({
    ...m,
    baaris: m.summary?.baaris ?? null, thullas: m.summary?.thullas ?? null,
    with: others.filter(o => o.matchId === m.matchId && o.userId !== userId).sort((a, b) => a.place - b.place).map(o => ({ name: o.name, guest: !o.userId })),
  }));
}

/** Latest finished games across the platform (for the home page). */
export async function recentMatches({ gameId = 'thulla', limit = 3, userId = null } = {}) {
  const q = db.select({ id: matches.id, tableCode: matches.tableCode, endedAt: matches.endedAt, playerCount: matches.playerCount, summary: matches.summary })
    .from(matches);
  const rows = userId
    ? await q.innerJoin(matchPlayers, and(eq(matchPlayers.matchId, matches.id), eq(matchPlayers.userId, userId))).where(eq(matches.gameId, gameId)).orderBy(desc(matches.endedAt)).limit(limit)
    : await q.where(eq(matches.gameId, gameId)).orderBy(desc(matches.endedAt)).limit(limit);
  if (!rows.length) return [];
  const ps = await db.select({ matchId: matchPlayers.matchId, name: matchPlayers.displayName, userId: matchPlayers.userId, place: matchPlayers.place, isLoser: matchPlayers.isLoser })
    .from(matchPlayers).where(inArray(matchPlayers.matchId, rows.map(r => r.id)));
  return rows.map(r => {
    const list = ps.filter(p => p.matchId === r.id);
    return { ...r, baaris: r.summary?.baaris ?? 0, winner: list.find(p => p.place === 1) || null, loser: list.find(p => p.isLoser) || null };
  });
}

/* ---------------- leaderboards ---------------- */

/**
 * @param {{gameId?:string, scope:'all'|'friends', userId?:string, sort?:'rating'|'firsts', page?:number}} o
 */
export async function leaderboard({ gameId = 'thulla', scope = 'all', userId = null, sort = 'rating', page = 0 }) {
  const order = sort === 'firsts' ? [desc(playerRatings.firsts), desc(playerRatings.rating)] : [desc(playerRatings.rating), desc(playerRatings.firsts)];
  let where = and(eq(playerRatings.gameId, gameId), dsql`${playerRatings.played} > 0`);
  if (scope === 'friends') {
    const ids = userId ? [userId, ...(await friendIds(userId))] : [];
    if (!ids.length) return [];
    where = and(eq(playerRatings.gameId, gameId), inArray(playerRatings.userId, ids));
  }
  const rows = await db.select({
    id: users.id, name: users.name, handle: users.handle,
    rating: playerRatings.rating, firsts: playerRatings.firsts, played: playerRatings.played, losses: playerRatings.losses,
  }).from(playerRatings).innerJoin(users, eq(users.id, playerRatings.userId))
    .where(where).orderBy(...order).limit(PAGE).offset(page * PAGE);
  let rows2 = rows;
  // A friends board should include friends who haven't played yet (at the base rating).
  if (scope === 'friends' && page === 0) {
    const ids = [userId, ...(await friendIds(userId))];
    const missing = ids.filter(id => !rows.some(r => r.id === id));
    if (missing.length) {
      const extra = await db.select({ id: users.id, name: users.name, handle: users.handle }).from(users).where(inArray(users.id, missing));
      rows2 = rows.concat(extra.map(u => ({ ...u, rating: BASE_RATING, firsts: 0, played: 0, losses: 0 })));
      rows2.sort((a, b) => sort === 'firsts' ? b.firsts - a.firsts || b.rating - a.rating : b.rating - a.rating || b.firsts - a.firsts);
    }
  }
  return rows2.map((r, i) => ({ ...r, rank: page * PAGE + i + 1 }));
}

/** Who a user is already connected to, for "Add friend" buttons: friends and requests either way. */
export async function relationsOf(userId) {
  const rows = await db.select({ a: friendships.requesterId, b: friendships.addresseeId, status: friendships.status }).from(friendships)
    .where(or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))).limit(1000);
  const out = { friends: [], sent: [], received: [] };
  for (const r of rows) {
    const other = r.a === userId ? r.b : r.a;
    if (r.status === 'accepted') out.friends.push(other);
    else if (r.status === 'pending') (r.a === userId ? out.sent : out.received).push(other);
  }
  return out;
}
