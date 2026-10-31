import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export function GET() {
  const appID = process.env.IOS_APP_ID;
  return NextResponse.json({ applinks: { apps: [], details: appID ? [{ appID, paths: ['/t/*', '/join*', '/u/*', '/reset*'] }] : [] } }, { headers: { 'cache-control': 'public, max-age=3600' } });
}
