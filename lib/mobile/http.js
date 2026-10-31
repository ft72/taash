/** Request/response plumbing for the native API: origins, JSON bodies, errors, limits. */
import { z } from 'zod';
import { config } from '../env.js';
import { createLimiter } from '../rate-limit.js';

export const MAX_BODY = 16_384;

/** An error the caller should see as-is. `code` is a stable machine-readable reason. */
export class ApiError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status, message, extra) => { throw new ApiError(status, message, extra); };

/** Platform functions answer `{error}` for expected refusals; turn those into 400s. */
export function orFail(res, status = 400) {
  if (res && res.error) fail(status, res.error, res.code ? { code: res.code } : {});
  return res;
}

function webOrigins() {
  const list = [config.appUrl, ...(process.env.MOBILE_WEB_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)];
  if (!config.isProd) list.push('http://localhost:8081', 'http://127.0.0.1:8081');
  return list;
}

/** Native fetch sends no Origin. Browsers (the Expo web preview) must be on the allow-list. */
export function allowedOrigin(req) {
  const origin = req.headers.get('origin');
  return !origin || webOrigins().includes(origin);
}

export function json(req, data, status = 200) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Origin' };
  const origin = req.headers.get('origin');
  if (origin && allowedOrigin(req)) headers['access-control-allow-origin'] = origin;
  return new Response(JSON.stringify(data), { status, headers });
}

export function preflight(req) {
  if (!allowedOrigin(req)) return json(req, { error: 'Origin not allowed.', code: 'origin' }, 403);
  const res = json(req, { ok: true });
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.headers.set('access-control-allow-headers', 'Authorization, Content-Type');
  res.headers.set('access-control-max-age', '600');
  return res;
}

export function clientIp(req) {
  return (req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'local').split(',')[0].trim();
}

export async function readJson(req) {
  if (Number(req.headers.get('content-length')) > MAX_BODY) fail(413, 'Request too large.');
  const raw = await req.text();
  if (raw.length > MAX_BODY) fail(413, 'Request too large.');
  if (!raw) return {};
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* fall through */ }
  return fail(400, 'Send a JSON object.', { code: 'invalid' });
}

/** Zod parse whose failure is a 400 naming the field. */
export function parse(schema, value) {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  return fail(400, issue?.message || 'Check your details.', { code: 'invalid', field: issue?.path?.[0] });
}

/** Per-process token buckets, kept across hot reloads. */
const g = globalThis;
const buckets = g.__taashMobileLimits ||= {
  signin: createLimiter({ capacity: 8, perSecond: 0.05 }),
  guest: createLimiter({ capacity: 10, perSecond: 0.1 }),
  forgot: createLimiter({ capacity: 5, perSecond: 1 / 60 }),
  reset: createLimiter({ capacity: 10, perSecond: 0.1 }),
  lookup: createLimiter({ capacity: 30, perSecond: 2 }),
  write: createLimiter({ capacity: 20, perSecond: 0.5 }),
  friend: createLimiter({ capacity: 10, perSecond: 0.1 }),
  shop: createLimiter({ capacity: 20, perSecond: 1 }),
  password: createLimiter({ capacity: 5, perSecond: 0.02 }),
};
export const LIMIT_MESSAGE = {
  signin: 'Too many attempts. Wait a minute and try again.',
  forgot: 'Too many requests. Wait a few minutes and try again.',
  password: 'Too many attempts. Wait a few minutes and try again.',
};
export function limit(name, key) {
  if (!buckets[name](name + ':' + key)) fail(429, LIMIT_MESSAGE[name] || 'You’re going a little fast. Wait a moment and try again.', { code: 'rate' });
}

/* Shared input shapes, with the same wording as the web forms. */
export const Name = z.string({ error: 'Enter a display name.' }).trim().min(1, 'Enter a display name.').max(24, 'Keep it to 24 characters.')
  .regex(/^[^<>\u0000-\u001F]+$/, 'Use letters, numbers and spaces.');
export const Handle = z.string({ error: 'Enter a username.' }).trim().toLowerCase().transform(v => v.replace(/^@/, ''))
  .pipe(z.string().min(3, 'Usernames need at least 3 characters.').max(20, 'Keep it to 20 characters.').regex(/^[a-z0-9._]+$/, 'Use letters, numbers, dots or underscores.'));
export const Password = z.string({ error: 'Enter a password.' }).min(8, 'Use at least 8 characters.').max(200);
export const Email = z.string({ error: 'Enter your email address.' }).trim().toLowerCase().email('Enter a valid email address.').max(200);
export const Page = v => Math.max(0, Math.min(1000, parseInt(v, 10) || 0));
