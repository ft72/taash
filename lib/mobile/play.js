/** Public game data: app configuration, open rooms, table previews, cosmetics catalogue, sounds, shop. */
import { ITEMS, TIERS, KINDS, DEFAULTS } from '../cosmetics/catalog.js';
import { cosmeticsState, buyItem, equipItem } from '../db/cosmetics.js';
import { LIMITS as TABLE_LIMITS, normalizeOptions } from '../game-engine/table-manager.js';
import { publicTables, tableManager } from '../server/live.js';
import { soundBoard } from '../sound-files.js';
import { config } from '../env.js';
import { catalog } from '../../games/catalog.js';
import { defaultSettings, LIMITS as THULLA_LIMITS } from '../../games/thulla/settings.js';
import { BOTS } from '../../games/thulla/bots.js';
import { z } from 'zod';
import { fail, orFail, parse, limit } from './http.js';

export const API_VERSION = 2;

/** Everything the app would otherwise hard-code: defaults, limits, bots, tiers. Safe to cache for a session. */
export function appConfig() {
  return {
    api: API_VERSION, minAppVersion: config.mobileMinVersion, serverTime: Date.now(), appUrl: config.appUrl,
    games: catalog,
    settings: { thulla: { defaults: defaultSettings(), limits: THULLA_LIMITS } },
    tableOptions: { defaults: normalizeOptions(null), spectatorsMax: TABLE_LIMITS.spectatorsMax, chatMax: TABLE_LIMITS.chatMax },
    bots: { thulla: BOTS.map(b => ({ id: b.id, name: b.name, persona: b.persona })) },
    cosmetics: { kinds: KINDS, defaults: DEFAULTS, tiers: TIERS },
    sounds: soundBoard(),
    features: { push: config.push.enabled, accountDeletion: true },
  };
}

export const rooms = () => ({ rooms: publicTables() });
export const catalogue = () => ({ items: ITEMS, tiers: TIERS });
export const sounds = () => ({ sounds: soundBoard() });

/** A table by code, before joining: who's there and whether the caller may sit or watch. */
export function table({ me, params, ip }) {
  limit('lookup', me.userId || ip);
  const t = tableManager()?.preview(decodeURIComponent(params.code || ''), me.kind === 'anon' ? null : me);
  return t ? { table: t } : fail(404, 'No open table uses that code. Tables close when everyone leaves.', { code: 'not-found' });
}

export async function shop({ me }) {
  return { items: ITEMS, tiers: TIERS, ...await cosmeticsState(me.userId) };
}

const ItemId = z.string({ error: 'That item doesn’t exist.' }).min(3, 'That item doesn’t exist.').max(60);
export async function buy({ me, body }) {
  limit('shop', me.userId);
  return orFail(await buyItem(me.userId, parse(ItemId, body.itemId)));
}
export async function equip({ me, body }) {
  limit('shop', me.userId);
  orFail(await equipItem(me.userId, parse(ItemId, body.itemId)));
  return { ok: true, ...await cosmeticsState(me.userId) };
}
