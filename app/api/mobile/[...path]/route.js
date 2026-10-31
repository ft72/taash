/** Native app HTTP API. The routes live in lib/mobile/router.js; see docs/MOBILE-API.md. */
import { handleMobile } from '@/lib/mobile/router';
import { preflight } from '@/lib/mobile/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const OPTIONS = req => preflight(req);
export const GET = async (req, ctx) => handleMobile(req, 'GET', (await ctx.params).path);
export const POST = async (req, ctx) => handleMobile(req, 'POST', (await ctx.params).path);
