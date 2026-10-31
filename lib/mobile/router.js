/**
 * The native app's HTTP API (/api/mobile/*): one table of routes over the
 * same platform functions the web pages and server actions use. Identity comes
 * only from the bearer token; nothing in a body or query says who the caller is.
 *
 * auth: 'any'     — works signed out (a token, if valid, personalises the answer)
 *       'session' — a guest or an account
 *       'user'    — an account
 */
import { viewerFromMobileToken, bearerToken } from '../auth/mobile-token.js';
import { log } from '../log.js';
import { ApiError, allowedOrigin, clientIp, json, readJson } from './http.js';
import * as auth from './auth.js';
import * as account from './account.js';
import * as social from './social.js';
import * as play from './play.js';

export const ROUTES = [
  // Public
  ['GET', 'config', 'any', play.appConfig],
  ['GET', 'home', 'any', social.home],
  ['GET', 'rooms', 'any', play.rooms],
  ['GET', 'tables/:code', 'any', play.table],
  ['GET', 'catalog', 'any', play.catalogue],
  ['GET', 'sounds', 'any', play.sounds],
  ['GET', 'leaderboard', 'any', social.board],
  ['GET', 'players/search', 'any', social.search],
  ['GET', 'players/:handle', 'any', social.player],
  ['GET', 'players/:handle/history', 'any', social.history],
  // Sessions
  ['GET', 'auth/handle', 'any', auth.handleAvailable],
  ['POST', 'auth/guest', 'any', auth.guest],
  ['POST', 'auth/register', 'any', auth.register],
  ['POST', 'auth/signin', 'any', auth.signIn],
  ['POST', 'auth/forgot', 'any', auth.forgot],
  ['POST', 'auth/reset', 'any', auth.reset],
  ['POST', 'auth/refresh', 'session', auth.refresh],
  ['POST', 'auth/signout', 'any', auth.signOut],
  ['GET', 'me', 'session', account.me],
  // Account
  ['POST', 'profile', 'user', account.profile],
  ['POST', 'password', 'user', account.password],
  ['POST', 'logout-everywhere', 'user', account.logoutEverywhere],
  ['POST', 'account/delete', 'user', account.deleteAccount],
  ['GET', 'wallet', 'user', account.wallet],
  ['POST', 'devices', 'user', account.registerDevice],
  ['POST', 'devices/remove', 'user', account.removeDeviceRoute],
  // Friends
  ['GET', 'friends', 'user', social.friends],
  ['POST', 'friends/add', 'user', social.addFriend],
  ['POST', 'friends/respond', 'user', social.respond],
  ['POST', 'friends/cancel', 'user', social.cancel],
  ['POST', 'friends/remove', 'user', social.remove],
  // Shop
  ['GET', 'shop', 'user', play.shop],
  ['POST', 'shop/buy', 'user', play.buy],
  ['POST', 'shop/equip', 'user', play.equip],
].map(([method, path, access, handler]) => ({ method, path, access, handler, parts: path.split('/') }));

/** Static segments win over :params, so players/search never reads as a handle. */
export function match(method, segments) {
  let best = null;
  for (const r of ROUTES) {
    if (r.parts.length !== segments.length) continue;
    const params = {};
    let score = 0, ok = true;
    for (let i = 0; i < r.parts.length && ok; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = segments[i];
      else if (r.parts[i] === segments[i]) score++;
      else ok = false;
    }
    if (ok && (!best || score > best.score || (score === best.score && r.method === method && best.route.method !== method))) best = { route: r, params, score };
  }
  if (!best) return null;
  return best.route.method === method ? best : { wrongMethod: true };
}

const DENIED = {
  session: [401, 'Your session expired. Sign in again.', 'auth'],
  user: [403, 'Sign in with an account to use this feature.', 'account-required'],
};

export async function handleMobile(req, method, segments = []) {
  if (!allowedOrigin(req)) return json(req, { error: 'Origin not allowed.', code: 'origin' }, 403);
  const path = segments.join('/');
  try {
    const found = match(method, segments);
    if (!found) return json(req, { error: 'Not found.', code: 'not-found' }, 404);
    if (found.wrongMethod) return json(req, { error: 'Use ' + (method === 'GET' ? 'POST' : 'GET') + ' for this endpoint.', code: 'method' }, 405);
    const { route, params } = found;
    const body = method === 'POST' ? await readJson(req) : {};
    const me = await viewerFromMobileToken(bearerToken(req));
    if (route.access !== 'any') {
      if (me.kind === 'anon') return json(req, { error: DENIED.session[1], code: DENIED.session[2] }, DENIED.session[0]);
      if (route.access === 'user' && me.kind !== 'user') return json(req, { error: DENIED.user[1], code: DENIED.user[2] }, DENIED.user[0]);
    }
    const data = await route.handler({ req, me, params, body, query: new URL(req.url).searchParams, ip: clientIp(req) });
    return json(req, data ?? { ok: true });
  } catch (e) {
    if (e instanceof ApiError) return json(req, { error: e.message, ...e.extra }, e.status);
    log.error('mobile api failed', { path, method, err: e.message });
    return json(req, { error: method === 'GET' ? 'Could not load this screen. Try again.' : 'Something went wrong. Try again in a moment.' }, 500);
  }
}
