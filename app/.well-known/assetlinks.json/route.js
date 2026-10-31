import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export function GET() {
  const fingerprints = (process.env.ANDROID_CERT_SHA256 || '').split(',').map(s => s.trim()).filter(s => /^([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(s));
  return NextResponse.json(fingerprints.length ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: process.env.ANDROID_APP_PACKAGE || 'com.nezden.taash', sha256_cert_fingerprints: fingerprints } }] : [], { headers: { 'cache-control': 'public, max-age=3600' } });
}
