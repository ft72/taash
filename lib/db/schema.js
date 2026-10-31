/**
 * Durable data only. Active games live in server memory (see lib/game-engine).
 * Auth.js adapter tables (users, accounts, sessions, verification_tokens)
 * follow the shapes @auth/drizzle-adapter expects, with Taash columns added
 * to `users`.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, text, timestamp, integer, boolean, jsonb, uuid, primaryKey, index, uniqueIndex, check, smallint,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),                    // display name
  email: text('email').notNull(),
  emailVerified: timestamp('email_verified', { mode: 'date' }),
  image: text('image'),
  handle: text('handle').notNull(),
  passwordHash: text('password_hash'),
  sessionVersion: integer('session_version').notNull().default(0),
  prefs: jsonb('prefs').notNull().default({}),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
  uniqueIndex('users_handle_uq').on(sql`lower(${t.handle})`),
]);

export const accounts = pgTable('accounts', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
}, t => [primaryKey({ columns: [t.provider, t.providerAccountId] })]);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable('verification_tokens', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
}, t => [primaryKey({ columns: [t.identifier, t.token] })]);

/** Game catalogue (Thulla playable; future games listed as 'workshop'). */
export const games = pgTable('games', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('workshop'),
});

export const friendships = pgTable('friendships', {
  id: uuid('id').primaryKey().defaultRandom(),
  requesterId: text('requester_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  addresseeId: text('addressee_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),   // 'pending' | 'accepted'
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp('responded_at', { mode: 'date', withTimezone: true }),
}, t => [
  // One relationship per pair, whichever direction it was requested in.
  uniqueIndex('friendships_pair_uq').on(sql`least(${t.requesterId}, ${t.addresseeId})`, sql`greatest(${t.requesterId}, ${t.addresseeId})`),
  index('friendships_addressee_idx').on(t.addresseeId, t.status),
  index('friendships_requester_idx').on(t.requesterId, t.status),
  check('friendships_not_self', sql`${t.requesterId} <> ${t.addresseeId}`),
  check('friendships_status_ck', sql`${t.status} in ('pending','accepted')`),
]);

/** One row per completed game. id is generated when the game starts, so a
 *  retried write of the same result conflicts instead of duplicating. */
export const matches = pgTable('matches', {
  id: uuid('id').primaryKey(),
  gameId: text('game_id').notNull().references(() => games.id),
  tableCode: text('table_code').notNull(),
  gameNo: integer('game_no').notNull(),
  settings: jsonb('settings').notNull(),
  playerCount: smallint('player_count').notNull(),
  summary: jsonb('summary').notNull().default({}),
  startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [index('matches_game_ended_idx').on(t.gameId, t.endedAt)]);

export const matchPlayers = pgTable('match_players', {
  matchId: uuid('match_id').notNull().references(() => matches.id, { onDelete: 'cascade' }),
  seat: smallint('seat').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),   // null = guest
  displayName: text('display_name').notNull(),
  place: smallint('place').notNull(),
  isLoser: boolean('is_loser').notNull().default(false),
  stats: jsonb('stats').notNull().default({}),
}, t => [
  primaryKey({ columns: [t.matchId, t.seat] }),
  index('match_players_user_idx').on(t.userId, t.matchId),
]);

export const playerRatings = pgTable('player_ratings', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  gameId: text('game_id').notNull().references(() => games.id),
  rating: integer('rating').notNull().default(1500),
  peak: integer('peak').notNull().default(1500),
  played: integer('played').notNull().default(0),
  firsts: integer('firsts').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  winStreak: integer('win_streak').notNull().default(0),
  loseStreak: integer('lose_streak').notNull().default(0),
  bestWinStreak: integer('best_win_streak').notNull().default(0),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.userId, t.gameId] }),
  index('player_ratings_board_idx').on(t.gameId, t.rating.desc()),
  index('player_ratings_firsts_idx').on(t.gameId, t.firsts.desc()),
]);

/** Exactly-once guard for rating updates: one row per (match, user). */
export const ratingEvents = pgTable('rating_events', {
  matchId: uuid('match_id').notNull().references(() => matches.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  gameId: text('game_id').notNull().references(() => games.id),
  before: integer('before').notNull(),
  after: integer('after').notNull(),
  delta: integer('delta').notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.matchId, t.userId] }),
  index('rating_events_user_idx').on(t.userId, t.gameId, t.createdAt),
]);

/**
 * "Forgot password" links. Only a SHA-256 of the token is stored, so a leaked
 * database row cannot be used to reset a password. Single use, short-lived.
 */
export const passwordResets = pgTable('password_resets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { mode: 'date', withTimezone: true }),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('password_resets_token_uq').on(t.tokenHash),
  index('password_resets_user_idx').on(t.userId, t.createdAt),
]);

/** Coins: earned in ranked games, spent in the shop. */
export const wallets = pgTable('wallets', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  coins: integer('coins').notNull().default(0),
  earned: integer('earned').notNull().default(0),          // lifetime, for display
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [check('wallets_coins_nonneg', sql`${t.coins} >= 0`)]);

/** Every coin movement. One payout per player per match (the unique index makes retries harmless). */
export const coinEvents = pgTable('coin_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  reason: text('reason').notNull(),                         // 'match' | 'purchase'
  matchId: uuid('match_id'),
  itemId: text('item_id'),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('coin_events_match_user_uq').on(t.matchId, t.userId),
  index('coin_events_user_idx').on(t.userId, t.createdAt),
]);

/** Cosmetics a player owns (bought with coins). Rank rewards are unlocked by rating, not stored here. */
export const ownedItems = pgTable('owned_items', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  acquiredAt: timestamp('acquired_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.itemId] })]);

/**
 * Phones that want push notifications (Expo push tokens). A token belongs to
 * one account at a time: signing in as someone else on the same phone moves it.
 */
export const pushDevices = pgTable('push_devices', {
  token: text('token').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),                    // 'ios' | 'android'
  appVersion: text('app_version'),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('push_devices_user_idx').on(t.userId),
  check('push_devices_platform_ck', sql`${t.platform} in ('ios','android')`),
]);
