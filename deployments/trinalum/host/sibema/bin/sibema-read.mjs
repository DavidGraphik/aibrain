#!/usr/bin/env node
import {SibemaClient} from '../lib/sibema-client.mjs';
import {legacyRead,legacyCatalog} from '../lib/legacy-read.mjs';
const [command,...raw]=process.argv.slice(2);const args=Object.fromEntries(raw.reduce((a,v,i)=>i%2?a:[...a,[v.replace(/^--/,''),raw[i+1]]],[]));
const c=new SibemaClient();
try{
 if(command==='get'){
 console.log(JSON.stringify(await legacyRead(c,args.path)));
 }else if(command==='catalog'){
 if(Object.keys(args).some(key=>key!=='references'))throw Error('catalog accepts only --references JSON_ARRAY');
 console.log(JSON.stringify(await legacyCatalog(c,args.references===undefined?{}:{references:JSON.parse(args.references)})));
 }else if(command==='sales-summary'){
 const {buildSalesSummary}=await import('../lib/sales-summary.mjs');
 const limit=Number(args.limit??30);if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Limit must be 1-100');
 console.log(JSON.stringify(await buildSalesSummary(c,{from:args.from,to:args.to,limit})));
 }else if(command==='accounting-summary'){
 const id=Number(args['contractor-id']);if(!Number.isSafeInteger(id)||id<1)throw Error('Explicit --contractor-id required');
 const from=args.from,to=args.to;if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))throw Error('Explicit --from and --to required');
 const [entries,invoices]=await Promise.all([c.listAll('accounting/entries',{contractor_id:id,from,to}),c.listAll('invoices/sale',{from,to})]);
 const detail=[];for(let i=0;i<invoices.length;i+=4)detail.push(...await Promise.all(invoices.slice(i,i+4).map(x=>c.getObject('invoices/sale',x.invoice_id))));
 const statusCounts={};for(const x of detail){const st=x.status?.name??'Sin estado';statusCounts[st]=(statusCounts[st]??0)+1;}
 console.log(JSON.stringify({source:'SIBEMA contabilidad y facturas de venta',contractor_id:id,range:{from,to},accounting_entries:entries.length,accounting_last_date:entries.map(x=>x.date).sort().at(-1)??null,sale_invoice_count:detail.length,sale_status_counts:statusCounts,sale_invoice_total:Math.round(detail.reduce((s,x)=>s+Number(x.totals?.total??0),0)*100)/100,sale_invoices:detail.map(x=>({invoice_id:x.invoice_id,number:x.number,date:x.date,customer_id:x.customer_id,status:x.status,totals:x.totals,accounting_entry_id:x.accounting_entry_id})),warnings:['La API no expone vencimiento ni saldo pendiente por factura: no se pueden identificar facturas vencidas con certeza.','Los importes se leen del detalle; el listado puede devolver ceros sin cargar líneas.','Las ventas de las representadas y las facturas de compra son ámbitos separados.']}));
 }else throw Error('Usage: sibema-read.mjs get --path /orders/ID | catalog [--references JSON_ARRAY] | sales-summary --from YYYY-MM-DD --to YYYY-MM-DD | accounting-summary --contractor-id ID --from YYYY-MM-DD --to YYYY-MM-DD');
}catch(e){console.error(JSON.stringify({status:'error',message:e.message}));process.exitCode=1;}
