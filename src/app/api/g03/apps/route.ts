import { productRoute, boundedBody } from '@/g03-products/http';
import { listApps, readApp, mutateApp } from '@/g03-products/apps';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return productRoute(request, async ctx => { const url = new URL(request.url); if (url.searchParams.get('capabilities') === '1') return { canCreate: ctx.grants.includes('apps'), canWriteRecords: ctx.appRecordsWritable !== false }; return url.searchParams.has('id') ? readApp(ctx,url.searchParams.get('id'),url.searchParams.get('published') === '1') : listApps(ctx); }); }
export async function POST(request: Request) { return productRoute(request, async ctx => mutateApp(ctx, await boundedBody(request))); }
