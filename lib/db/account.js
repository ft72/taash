/**
 * Deleting an account (required of apps that let people sign up). Everything
 * personal goes with the user row through ON DELETE CASCADE: friendships,
 * ratings, wallet, purchases, reset links and push devices. Finished games stay
 * in other players' histories, but under a neutral name and without the link
 * back to the account.
 */
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { users, matchPlayers } from './schema.js';

export const DELETED_NAME = 'Former player';

export async function deleteAccount(userId) {
  return db.transaction(async tx => {
    await tx.update(matchPlayers).set({ displayName: DELETED_NAME }).where(eq(matchPlayers.userId, userId));
    const gone = await tx.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
    return gone.length > 0;
  });
}
