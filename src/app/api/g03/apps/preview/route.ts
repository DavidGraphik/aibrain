import { getSession } from '@/auth/session';
import { productContext } from '@/g03-products/access';
import { readApp } from '@/g03-products/apps';
import { appDocument, APP_CSP } from '@/g03-products/sandbox';
import { ProductError, requireProduct } from '@/g03-products/contracts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const session = await getSession(); requireProduct(session,'No autenticat.',401); const url = new URL(request.url); const channel = url.searchParams.get('channel') ?? 'preview'; requireProduct(/^[a-zA-Z0-9-]{1,80}$/.test(channel),'Canal invàlid.'); const app = await readApp(await productContext(session),url.searchParams.get('id'),url.searchParams.get('published') === '1'); return new Response(appDocument(app.version.html,channel), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': APP_CSP, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' } }); }
  catch(e) { return Response.json({ error: e instanceof ProductError ? e.message : 'App no disponible.' },{status:e instanceof ProductError?e.status:503}); }
}
