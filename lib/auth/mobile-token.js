import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../env.js';
import { getUserAuthInfo } from './user-cache.js';
import { guestViewer, userViewer } from './identity.js';

export const MOBILE_MAX_AGE = 30 * 24 * 60 * 60;
const signature = data => createHmac('sha256', config.authSecret).update('taash:mobile:v1:' + data).digest('base64url');

/** Separate audience from browser cookies. Never accept unsigned identity data. */
export function issueMobileToken(identity, now = Date.now()) {
  const data = Buffer.from(JSON.stringify({ ...identity, exp: Math.floor(now / 1000) + MOBILE_MAX_AGE, aud: 'taash-mobile', v: 1 })).toString('base64url');
  return data + '.' + signature(data);
}

/** A token plus when it stops working, so the app knows when to call auth/refresh. */
export function mobileSession(identity, now = Date.now()) {
  return { token: issueMobileToken(identity, now), expiresAt: new Date((Math.floor(now / 1000) + MOBILE_MAX_AGE) * 1000).toISOString() };
}

export async function viewerFromMobileToken(token, { now = Date.now(), lookup = getUserAuthInfo } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return { kind: 'anon' };
  const parts = token.split('.');
  if (parts.length !== 2) return { kind: 'anon' };
  const [data, sig] = parts;
  const expected = Buffer.from(signature(data)), received = Buffer.from(sig);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { kind: 'anon' };
  try {
    const value = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (value.aud !== 'taash-mobile' || value.v !== 1 || !Number.isFinite(value.exp) || value.exp <= Math.floor(now / 1000)) return { kind: 'anon' };
    if (value.kind === 'guest' && /^g_[\w-]{10,32}$/.test(value.id) && typeof value.name === 'string' && value.name.length <= 24) return guestViewer(value);
    if (value.kind === 'user' && typeof value.id === 'string' && Number.isInteger(value.sv)) {
      const info = await lookup(value.id);
      if (info && info.sv === value.sv) return userViewer(value.id, info.name, info.handle);
    }
  } catch { /* malformed token, or identity no longer available */ }
  return { kind: 'anon' };
}

export function bearerToken(req) {
  const header = req.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}
