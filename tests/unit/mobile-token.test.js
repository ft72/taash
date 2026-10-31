import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueMobileToken, viewerFromMobileToken, MOBILE_MAX_AGE } from '../../lib/auth/mobile-token.js';
import { encodeGuest } from '../../lib/auth/guest.js';

const guest = { kind: 'guest', id: 'g_abcdefghijklmnop', name: 'Hira' };
test('mobile guest tokens restore a stable identity without database access', async () => {
  const token = issueMobileToken(guest, 1000);
  const viewer = await viewerFromMobileToken(token, { now: 2000, lookup: () => { throw new Error('must not query'); } });
  assert.equal(viewer.kind, 'guest'); assert.equal(viewer.playerId, 'g:' + guest.id); assert.equal(viewer.name, 'Hira');
});
test('tampering, expired tokens, wrong purpose, malformed input and browser cookies are rejected', async () => {
  const token = issueMobileToken(guest, 1000);
  const data = Buffer.from(JSON.stringify({ ...guest, name: 'Forged' })).toString('base64url');
  for (const value of [null, '', 'x'.repeat(5000), token + '.extra', data + '.' + token.split('.')[1], encodeGuest(guest)]) assert.equal((await viewerFromMobileToken(value, { now: 2000 })).kind, 'anon');
  assert.equal((await viewerFromMobileToken(token, { now: 1000 + MOBILE_MAX_AGE * 1000 })).kind, 'anon');
});
test('registered mobile sessions use database identity and respect sign-out-everywhere', async () => {
  const token = issueMobileToken({ kind: 'user', id: 'uid', sv: 3, name: 'Stale name' });
  const info = { sv: 3, name: 'Current name', handle: 'current' };
  const viewer = await viewerFromMobileToken(token, { lookup: async uid => { assert.equal(uid, 'uid'); return info; } });
  assert.equal(viewer.playerId, 'u:uid'); assert.equal(viewer.name, info.name);
  assert.equal((await viewerFromMobileToken(token, { lookup: async () => ({ ...info, sv: 4 }) })).kind, 'anon');
  assert.equal((await viewerFromMobileToken(token, { lookup: async () => null })).kind, 'anon');
});
