/**
 * Coins, owned cosmetics and what each player has equipped. Equipped items
 * live in users.prefs.cosmetics; they are re-checked whenever they are read,
 * so a design can't be shown by someone who no longer qualifies for it.
 */
import { and, eq, desc, sql as dsql } from 'drizzle-orm';
import { db } from './client.js';
import { users, wallets, coinEvents, ownedItems, playerRatings } from './schema.js';
import { BY_ID, DEFAULTS, KINDS, canUse, designKey } from '../cosmetics/catalog.js';
import { BASE_RATING } from '../ratings/elo.js';

async function peakOf(userId, gameId = 'thulla', tx = db) {
  const [r] = await tx.select({ peak: playerRatings.peak }).from(playerRatings).where(and(eq(playerRatings.userId, userId), eq(playerRatings.gameId, gameId))).limit(1);
  return r ? r.peak : BASE_RATING;
}

async function ownedSet(userId, tx = db) {
  const rows = await tx.select({ id: ownedItems.itemId }).from(ownedItems).where(eq(ownedItems.userId, userId));
  return new Set(rows.map(r => r.id));
}

/** Everything the shop page needs about one player. */
export async function cosmeticsState(userId) {
  const [[w], owned, peak, [u]] = await Promise.all([
    db.select({ coins: wallets.coins, earned: wallets.earned }).from(wallets).where(eq(wallets.userId, userId)).limit(1),
    ownedSet(userId), peakOf(userId),
    db.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  return { coins: w?.coins ?? 0, earned: w?.earned ?? 0, owned: [...owned], peak, equipped: equippedFrom(u?.prefs, owned, peak) };
}

function equippedFrom(prefs, owned, peak) {
  const c = (prefs && prefs.cosmetics) || {};
  const out = {};
  for (const kind of Object.keys(KINDS)) {
    const item = BY_ID[c[kind]];
    out[kind] = item && item.kind === kind && canUse(item, owned, peak) ? item.id : DEFAULTS[kind];
  }
  return out;
}

/** What a player shows at a table: short design keys (null = default look). */
export async function tableCosmetics(userId) {
  const [[u], owned, peak] = await Promise.all([
    db.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).limit(1), ownedSet(userId), peakOf(userId),
  ]);
  const e = equippedFrom(u?.prefs, owned, peak);
  return { table: designKey(e.table), cards: designKey(e.cards) };
}

export async function coinBalance(userId) {
  const [w] = await db.select({ coins: wallets.coins }).from(wallets).where(eq(wallets.userId, userId)).limit(1);
  return w?.coins ?? 0;
}

/** @returns {Promise<{ok:true, coins:number} | {error:string}>} */
export async function buyItem(userId, itemId) {
  const item = BY_ID[itemId];
  if (!item || item.free) return { error: 'That item isn’t for sale.' };
  if (item.minPeak) return { error: 'Rank rewards can’t be bought. Reach a peak rating of ' + item.minPeak + ' to unlock it.' };
  return db.transaction(async tx => {
    const [have] = await tx.select({ id: ownedItems.itemId }).from(ownedItems).where(and(eq(ownedItems.userId, userId), eq(ownedItems.itemId, itemId))).limit(1);
    if (have) return { error: 'You already own ' + item.name + '.' };
    const [w] = await tx.select({ coins: wallets.coins }).from(wallets).where(eq(wallets.userId, userId)).for('update').limit(1);
    const coins = w?.coins ?? 0;
    if (coins < item.price) return { error: 'You need ' + (item.price - coins) + ' more coins for ' + item.name + '. Win ranked games to earn coins.' };
    await tx.update(wallets).set({ coins: dsql`${wallets.coins} - ${item.price}`, updatedAt: new Date() }).where(eq(wallets.userId, userId));
    await tx.insert(ownedItems).values({ userId, itemId });
    await tx.insert(coinEvents).values({ userId, amount: -item.price, reason: 'purchase', itemId });
    return { ok: true, coins: coins - item.price };
  });
}

/** Equip an item (or the default for that kind). */
export async function equipItem(userId, itemId) {
  const item = BY_ID[itemId];
  if (!item) return { error: 'That item doesn’t exist.' };
  const [owned, peak] = await Promise.all([ownedSet(userId), peakOf(userId)]);
  if (!canUse(item, owned, peak)) return { error: item.minPeak ? 'Reach a peak rating of ' + item.minPeak + ' to use ' + item.name + '.' : 'Buy ' + item.name + ' in the shop first.' };
  // prefs.cosmetics[kind] = id, creating prefs.cosmetics when it doesn't exist yet.
  await db.update(users).set({
    prefs: dsql`coalesce(${users.prefs}, '{}'::jsonb) || jsonb_build_object('cosmetics', coalesce(${users.prefs}->'cosmetics', '{}'::jsonb) || jsonb_build_object(${item.kind}::text, ${item.id}::text))`,
  }).where(eq(users.id, userId));
  return { ok: true };
}

/** Pay coins for a finished ranked game, once per player per match (inside the result transaction). */
export async function payMatchCoins(tx, matchId, payouts) {
  const out = {};
  for (const { userId, amount } of payouts) {
    if (!amount) continue;
    const ins = await tx.insert(coinEvents).values({ userId, amount, reason: 'match', matchId }).onConflictDoNothing().returning({ id: coinEvents.id });
    if (!ins.length) continue;
    await tx.insert(wallets).values({ userId, coins: amount, earned: amount })
      .onConflictDoUpdate({ target: wallets.userId, set: { coins: dsql`${wallets.coins} + ${amount}`, earned: dsql`${wallets.earned} + ${amount}`, updatedAt: new Date() } });
    out[userId] = amount;
  }
  return out;
}

/** Recent coin movements (wins and purchases), newest first. */
export async function coinHistory(userId, limit = 50) {
  const rows = await db.select({ id: coinEvents.id, amount: coinEvents.amount, reason: coinEvents.reason, matchId: coinEvents.matchId, itemId: coinEvents.itemId, at: coinEvents.createdAt })
    .from(coinEvents).where(eq(coinEvents.userId, userId)).orderBy(desc(coinEvents.createdAt)).limit(limit);
  return rows.map(r => ({ ...r, itemName: r.itemId ? BY_ID[r.itemId]?.name || null : null }));
}
