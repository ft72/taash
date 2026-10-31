'use server';
/**
 * Registration, sign-in, sign-out and account security as server actions.
 * Inputs are validated with zod; identity always comes from the session.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { eq, sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { signIn, signOut } from '@/lib/auth/auth';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { invalidateUser } from '@/lib/auth/user-cache';
import { requireUser } from '@/lib/auth/viewer';
import { createLimiter } from '@/lib/rate-limit';
import { renameUser } from '@/lib/server/live';

const g = globalThis;
const limitAuth = g.__taashAuthLimiter || (g.__taashAuthLimiter = createLimiter({ capacity: 8, perSecond: 0.05 }));
async function clientKey() {
  const h = await headers();
  return (h.get('x-forwarded-for') || '').split(',')[0].trim() || h.get('x-real-ip') || 'local';
}

const nameSchema = z.string().trim().min(1, 'Enter a display name.').max(24, 'Keep it to 24 characters.')
  .regex(/^[^<>\u0000-\u001F]+$/, 'Use letters, numbers and spaces.');
const handleSchema = z.string().trim().toLowerCase().min(3, 'Usernames need at least 3 characters.').max(20, 'Keep it to 20 characters.')
  .regex(/^[a-z0-9._]+$/, 'Use letters, numbers, dots or underscores.');
const registerSchema = z.object({
  name: nameSchema,
  handle: handleSchema,
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(200),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
  confirm: z.string(),
}).refine(d => d.password === d.confirm, { message: 'Passwords don’t match.', path: ['confirm'] });

function safeNext(v) { return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/'; }

export async function registerAction(_prev, formData) {
  if (!limitAuth('reg:' + await clientKey())) return { error: 'Too many attempts. Wait a minute and try again.' };
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message, field: parsed.error.issues[0].path[0], values: { name: formData.get('name'), handle: formData.get('handle'), email: formData.get('email') } };
  const { name, handle, email, password } = parsed.data;
  const values = { name, handle, email };
  const [taken] = await db.select({ email: users.email, handle: users.handle }).from(users)
    .where(dsql`lower(${users.email}) = ${email} or lower(${users.handle}) = ${handle}`).limit(1);
  if (taken) return taken.email.toLowerCase() === email ? { error: 'An account already uses that email. Sign in instead.', field: 'email', values } : { error: 'That handle is taken. Try another.', field: 'handle', values };
  try {
    await db.insert(users).values({ name, handle, email, passwordHash: await hashPassword(password) });
  } catch {
    return { error: 'That email or handle was just taken. Try another.', values };
  }
  try {
    await signIn('credentials', { login: email, password, redirectTo: safeNext(formData.get('next')) });
  } catch (e) {
    if (e instanceof AuthError) return { error: 'Account created, but signing in failed. Try signing in.', values };
    throw e;   // redirect
  }
}

export async function signInAction(_prev, formData) {
  if (!limitAuth('in:' + await clientKey())) return { error: 'Too many attempts. Wait a minute and try again.' };
  const login = String(formData.get('login') || '');
  try {
    await signIn('credentials', { login, password: String(formData.get('password') || ''), redirectTo: safeNext(formData.get('next')) });
  } catch (e) {
    if (e instanceof AuthError) return { error: 'Those sign-in details do not match an account.', values: { login } };
    throw e;
  }
}

export async function signOutAction() {
  await signOut({ redirectTo: '/' });
}

/** Invalidate every session for this account (all devices), then sign out here. */
export async function signOutEverywhereAction() {
  const me = await requireUser();
  if (!me) redirect('/signin');
  await db.update(users).set({ sessionVersion: dsql`${users.sessionVersion} + 1` }).where(eq(users.id, me.userId));
  invalidateUser(me.userId);
  await signOut({ redirectTo: '/signin' });
}

const limitHandleCheck = g.__taashHandleLimiter || (g.__taashHandleLimiter = createLimiter({ capacity: 30, perSecond: 2 }));

/** Is this username free? (Ignores the signed-in user's own.) For live feedback while typing. */
export async function checkHandleAction(raw) {
  if (!limitHandleCheck('h:' + await clientKey())) return { ok: false, error: 'Slow down a little.' };
  const parsed = handleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const me = await requireUser();
  const [row] = await db.select({ id: users.id }).from(users).where(dsql`lower(${users.handle}) = ${parsed.data}`).limit(1);
  return { ok: true, handle: parsed.data, available: !row || row.id === me?.userId };
}

export async function updateProfileAction(_prev, formData) {
  const me = await requireUser();
  if (!me) return { error: 'Sign in to edit your profile.' };
  const parsed = nameSchema.safeParse(formData.get('name'));
  if (!parsed.success) return { error: parsed.error.issues[0].message, field: 'name' };
  const patch = { name: parsed.data };
  const rawHandle = formData.get('handle');
  if (rawHandle != null && String(rawHandle).trim().replace(/^@/, '').toLowerCase() !== String(me.handle || '').toLowerCase()) {
    const h = handleSchema.safeParse(String(rawHandle).trim().replace(/^@/, ''));
    if (!h.success) return { error: h.error.issues[0].message, field: 'handle' };
    const [taken] = await db.select({ id: users.id }).from(users).where(dsql`lower(${users.handle}) = ${h.data} and ${users.id} <> ${me.userId}`).limit(1);
    if (taken) return { error: 'That username is taken. Try another.', field: 'handle' };
    patch.handle = h.data;
  }
  try {
    await db.update(users).set(patch).where(eq(users.id, me.userId));   // only ever the signed-in user's row
  } catch {
    return { error: 'That username was just taken. Try another.', field: 'handle' };   // unique index race
  }
  invalidateUser(me.userId);
  await renameUser(me.userId, patch.name, patch.handle || me.handle);
  return { ok: true, name: patch.name, handle: patch.handle || me.handle };
}

export async function changePasswordAction(_prev, formData) {
  const me = await requireUser();
  if (!me) return { error: 'Sign in first.' };
  if (!limitAuth('pw:' + me.userId)) return { error: 'Too many attempts. Wait a minute and try again.' };
  const next = z.string().min(8, 'Use at least 8 characters.').max(200).safeParse(formData.get('next'));
  if (!next.success) return { error: next.error.issues[0].message };
  const [u] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, me.userId)).limit(1);
  if (!u || !(await verifyPassword(u.hash, String(formData.get('current') || '')))) return { error: 'Your current password is not right.' };
  // Changing the password signs out every other device.
  await db.update(users).set({ passwordHash: await hashPassword(next.data), sessionVersion: dsql`${users.sessionVersion} + 1` }).where(eq(users.id, me.userId));
  invalidateUser(me.userId);
  await signOut({ redirectTo: '/signin?changed=1' });
}
