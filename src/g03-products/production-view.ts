import { createHash } from 'node:crypto';
import { grant, type ProductContext } from './access';
import { number, object, requireProduct } from './contracts';
import { defaultProductionView, normalizeProductionView, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, isProductionFontFamily, isProductionFontSize, productionColumns, type ProductionView } from './production-columns';

// Identity comes exclusively from the authenticated context, never the request.
const viewKey = (ctx: ProductContext) => `production-view-${createHash('sha256').update(ctx.actor).digest('hex')}`;
export async function readProductionView(ctx: ProductContext): Promise<ProductionView> {
  grant(ctx,'read');
  const saved=await ctx.store.read<ProductionView>(viewKey(ctx));
  return normalizeProductionView(saved);
}
export async function mutateProductionView(ctx: ProductContext,input: unknown) {
  grant(ctx,'read');
  const body=object(input), expected=number(body.revision);
  requireProduct(Number.isSafeInteger(expected),'Revisió de vista invàlida.');
  requireProduct(Object.keys(body).every(key=>['action','revision','reason','columnWidths','fontFamily','fontSizePt'].includes(key)),'Preferència de vista desconeguda.');
  const patch=Object.hasOwn(body,'columnWidths')?object(body.columnWidths):{}, keys=Object.keys(patch);
  requireProduct((!Object.hasOwn(body,'columnWidths')||keys.length>0) && keys.every(key=>productionColumns.some(c=>c.key===key)),'Columna desconeguda.');
  requireProduct(keys.length>0||Object.hasOwn(body,'fontFamily')||Object.hasOwn(body,'fontSizePt'),'Indica una preferència de vista.');
  if(Object.hasOwn(body,'fontFamily'))requireProduct(isProductionFontFamily(body.fontFamily),'Tipus de lletra no admès.');
  if(Object.hasOwn(body,'fontSizePt'))requireProduct(isProductionFontSize(body.fontSizePt),'Mida de lletra invàlida: de 8 a 24 punts, en passos de 0,25.');
  for (const width of Object.values(patch)) requireProduct(typeof width==='number' && Number.isSafeInteger(width) && width>=MIN_COLUMN_WIDTH && width<=MAX_COLUMN_WIDTH,'Amplada invàlida: entre 72 i 1000 píxels.');
  return ctx.store.mutate<ProductionView,ProductionView>(viewKey(ctx),defaultProductionView,view=>{
    Object.assign(view,normalizeProductionView(view));
    view.columnWidths={...view.columnWidths,...patch as Record<string,number>};
    if(isProductionFontFamily(body.fontFamily))view.fontFamily=body.fontFamily;
    if(isProductionFontSize(body.fontSizePt))view.fontSizePt=body.fontSizePt;
    return {...view,revision:view.revision+1,columnWidths:{...view.columnWidths}};
  },expected);
}
