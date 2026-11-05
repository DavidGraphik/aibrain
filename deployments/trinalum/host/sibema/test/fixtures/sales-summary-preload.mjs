// Synthetic transport for the real CLI/client path. No network fallback exists.
const order={order_id:101,customer_id:1,status:{name:'FACTURADO'},shipping_date:'2026-01-15',lines:[{line_id:1,quantity:2,unit:'t',unit_price:25,discount:0}]};
globalThis.fetch=async(location,options={})=>{
 const url=new URL(location);
 if(url.origin!=='https://erp.example.invalid')throw Error('Unexpected fixture origin');
 if(url.pathname==='/ERPBerma/authenticate'&&options.method==='POST')return Response.json({token:'synthetic-token'});
 if(options.method!==undefined&&options.method!=='GET')throw Error('Summary must only read');
 const prefix='/ERPBerma/company/api/v1';
 if(url.pathname===prefix+'/orders'){
  const page=Number(url.searchParams.get('page'));
  if(page===0)return Response.json({data:[order],has_next:true});
  if(page===1)return Response.json({data:[{order_id:102,customer_id:1,status:{name:'FACTURADO'},shipping_date:'2025-12-31'},{order_id:103,customer_id:1,status:{name:'FACTURADO'},shipping_date:null},{order_id:104,customer_id:1,status:{name:'Confirmado'},shipping_date:'2026-01-16'}],has_next:false});
 }
 if(url.pathname===prefix+'/customers')return Response.json({data:[{customer_id:1,name:'Synthetic customer',address:{state:'Synthetic region'}}],has_next:false});
 if(url.pathname===prefix+'/orders/101')return Response.json(order);
 throw Error('Unexpected fixture route');
};
