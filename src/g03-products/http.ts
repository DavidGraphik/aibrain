import 'server-only';
import { getSession } from '@/auth/session';
import { isSameOriginMutation } from '@/auth/request-security';
import { productContext, type ProductContext } from './access';
import { ProductError, requireProduct } from './contracts';
import type { AuthSession } from '@/auth/types';
export async function productRoute(request: Request | null, handler: (ctx: ProductContext, session:AuthSession) => Promise<unknown>) {
  try {
    if (request && request.method !== 'GET') requireProduct(await isSameOriginMutation(request), 'Origen no autoritzat.',403);
    const session = await getSession(); requireProduct(session,'No autenticat.',401);
    const result = await handler(await productContext(session),session);
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return Response.json({ error: error instanceof ProductError ? error.message : 'Servei no disponible.' }, { status: error instanceof ProductError ? error.status : 503, headers: { 'Cache-Control': 'private, no-store' } }); }
}
export async function boundedBody(request: Request) {
  const raw = await request.text(); requireProduct(Buffer.byteLength(raw) <= 8 * 1024 * 1024,'Petición massa gran.',413);
  try { return JSON.parse(raw); } catch { throw new ProductError(400,'JSON invàlid.'); }
}
