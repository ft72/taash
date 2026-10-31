/** Sign-up, sign-in, guests, sessions and password recovery for the native app. */
import { sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword, dummyVerify } from '../auth/password.js';
import { newGuestId } from '../auth/guest.js';
import { userViewer, guestViewer } from '../auth/identity.js';
import { mobileSession, viewerFromMobileToken, bearerToken } from '../auth/mobile-token.js';
import { getUserAuthInfo, invalidateUser } from '../auth/user-cache.js';
import { findAccount, createReset, redeemReset, RESET_MINUTES } from '../auth/password-reset.js';
import { passwordResetEmail } from '../mail/templates.js';
import { sendMail } from '../mail/mailer.js';
import { removeDevice, removeAllDevices } from '../db/devices.js';
import { findUserByHandle } from '../db/social.js';
import { config } from '../env.js';
import { log } from '../log.js';
import { fail, parse, limit, Name, Handle, Password, Email } from './http.js';

/** A fresh session for a registered user row ({id, name, handle, sessionVersion}). */
export function userSession(u) {
  return { ...mobileSession({ kind: 'user', id: u.id, sv: u.sessionVersion }), viewer: userViewer(u.id, u.name, u.handle) };
}
function guestSession(id, name) {
  return { ...mobileSession({ kind: 'guest', id, name }), viewer: guestViewer({ id, name }) };
}
const isUnique = e => e.code === '23505' || e.cause?.code === '23505';

const Register = z.object({ name: Name, handle: Handle, email: Email, password: Password, confirm: z.string().optional() })
  .refine(v => v.confirm == null || v.confirm === v.password, { message: 'Passwords don’t match.', path: ['confirm'] });
const SignIn = z.object({ login: z.string({ error: 'Enter your email or username.' }).trim().toLowerCase().min(1, 'Enter your email or username.').max(200), password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.').max(200) });
const Reset = z.object({ token: z.string().min(10).max(200), password: Password, confirm: z.string() })
  .refine(v => v.password === v.confirm, { message: 'Passwords don’t match.', path: ['confirm'] });

/** Name-only play. A guest who renames keeps the same identity (and their seat). */
export async function guest({ req, body, ip }) {
  limit('guest', ip);
  const name = parse(Name, body.name);
  const previous = await viewerFromMobileToken(bearerToken(req));
  return guestSession(previous.kind === 'guest' ? previous.playerId.slice(2) : newGuestId(), name);
}

export async function register({ body, ip }) {
  limit('signin', ip);
  const v = parse(Register, body);
  const [taken] = await db.select({ email: users.email }).from(users)
    .where(dsql`lower(${users.email}) = ${v.email} or lower(${users.handle}) = ${v.handle}`).limit(1);
  if (taken) {
    if (taken.email.toLowerCase() === v.email) fail(409, 'An account already uses that email. Sign in instead.', { code: 'taken', field: 'email' });
    fail(409, 'That username is taken. Try another.', { code: 'taken', field: 'handle' });
  }
  let u;
  try { [u] = await db.insert(users).values({ name: v.name, email: v.email, handle: v.handle, passwordHash: await hashPassword(v.password) }).returning(); }
  catch (e) { if (isUnique(e)) fail(409, 'That email or username was just taken. Try another.', { code: 'taken' }); throw e; }
  return userSession(u);
}

/** Email or username (with or without @). The same answer whether the account exists or not. */
export async function signIn({ body, ip }) {
  limit('signin', ip);
  const { login, password } = parse(SignIn, body);
  const byEmail = login.includes('@') && !login.startsWith('@');
  const key = byEmail ? login : login.replace(/^@/, '');
  const [u] = await db.select().from(users).where(byEmail ? dsql`lower(${users.email}) = ${key}` : dsql`lower(${users.handle}) = ${key}`).limit(1);
  if (!u?.passwordHash) { await dummyVerify(); fail(401, 'Those sign-in details do not match an account.', { code: 'credentials' }); }
  if (!(await verifyPassword(u.passwordHash, password))) fail(401, 'Those sign-in details do not match an account.', { code: 'credentials' });
  return userSession(u);
}

/** Swap a still-valid token for a new 30-day one. Revoked sessions can't be refreshed. */
export async function refresh({ me }) {
  if (me.kind === 'guest') return guestSession(me.playerId.slice(2), me.name);
  const info = await getUserAuthInfo(me.userId);
  if (!info) fail(401, 'Your session expired. Sign in again.', { code: 'auth' });
  return userSession({ id: me.userId, name: info.name, handle: info.handle, sessionVersion: info.sv });
}

/** Tokens are stateless; signing out on a phone only stops its push notifications. */
export async function signOut({ me, body }) {
  if (me.kind === 'user' && typeof body.pushToken === 'string' && body.pushToken.length <= 200) await removeDevice(me.userId, body.pushToken);
  return { ok: true };
}

export async function forgot({ body, ip }) {
  limit('forgot', ip);
  const login = parse(z.string({ error: 'Enter your email or username.' }).trim().min(1, 'Enter your email or username.').max(200), body.login);
  try {
    const u = await findAccount(login), token = u && await createReset(u.id);
    if (token) {
      const sent = await sendMail({ to: u.email, ...passwordResetEmail({ name: u.name, handle: u.handle, link: config.appUrl + '/reset?token=' + encodeURIComponent(token), minutes: RESET_MINUTES }) });
      if (!sent.ok) log.error('password reset email not sent', { userId: u.id });
    }
  } catch (e) {
    log.error('password reset request failed', { err: e.message });   // same answer either way: no account discovery
  }
  return { ok: true, message: 'If that account exists, a reset link has been sent to its email.' };
}

export async function reset({ body, ip }) {
  limit('reset', ip);
  const v = parse(Reset, body);
  const userId = await redeemReset(v.token, await hashPassword(v.password));
  if (!userId) fail(400, 'This reset link has expired or was already used. Ask for a new one.', { code: 'expired' });
  invalidateUser(userId);
  await removeAllDevices(userId);
  return { ok: true };
}

/** Is this username free? The signed-in user's own handle counts as free. */
export async function handleAvailable({ me, query, ip }) {
  limit('lookup', ip);
  const handle = parse(Handle, query.get('handle') ?? '');
  const found = await findUserByHandle(handle);
  return { available: !found || found.id === me.userId, handle };
}
