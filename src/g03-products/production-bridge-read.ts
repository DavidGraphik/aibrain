import type { ProductContext } from './access';
import { object,requireProduct } from './contracts';
import { readProduction,summarizeProductionAudit } from './production';
/** Reuse live permissions/state, but never transport source workbooks or large audit snapshots. */
export async function readProductionBridge(ctx:ProductContext,input:unknown={}){
  const args=object(input),section=String(args.section??'orders'),offset=args.offset??0,limit=args.limit??100,query=String(args.query??'').toLowerCase();
  requireProduct(['orders','phases','receipts','catalog','intake','tasks','deliveredHistory','audit'].includes(section),'Secció invàlida.');
  requireProduct(Number.isSafeInteger(offset)&&Number(offset)>=0&&Number.isSafeInteger(limit)&&Number(limit)>=1&&Number(limit)<=100&&query.length<=500,'Paginació invàlida.');
  const state=await readProduction(ctx),source=state[section as 'orders'|'phases'|'receipts'|'catalog'|'intake'|'tasks'|'deliveredHistory'|'audit']??[];
  const compact=(row:unknown)=>row&&typeof row==='object'?Object.fromEntries(Object.entries(row).filter(([key])=>!['sourceCells','sourceSheets','sourceReferenceValue'].includes(key))):row;
  const rows=source.filter(row=>!query||JSON.stringify(compact(row)).toLowerCase().includes(query));
  const page=rows.slice(Number(offset),Number(offset)+Number(limit));const records=section==='audit'?summarizeProductionAudit(page as typeof state.audit):page.map(compact);
  const nextOffset=Number(offset)+page.length<rows.length?Number(offset)+page.length:null;
  const result={revision:state.revision,sourceVersion:state.sourceVersion,readAt:new Date().toISOString(),section,totalRecords:rows.length,records,[section]:records,nextOffset,complete:nextOffset===null,lookups:state.lookups,configuration:state.configuration??{},view:state.view,sourceImportPaused:state.sourceImportPaused,permissions:{read:ctx.grants.includes('read'),orders:ctx.grants.includes('orders'),machines:ctx.grants.includes('machines'),receipts:ctx.grants.includes('receipts'),receiptValidate:ctx.grants.includes('validate-receipts'),applicationDesign:ctx.appDesigner===true&&ctx.grants.includes('apps')}};
  requireProduct(Buffer.byteLength(JSON.stringify(result))<=256*1024,'Resposta massa gran: redueix limit i pagina els resultats.',413);return result;
}
