// Official SIBEMA UI reference catalogue and single-order condition readback.
import {sibemaOrigin as origin} from './provider-config.mjs';
const positive=value=>Number.isSafeInteger(value)&&value>0;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw Error(`SIBEMA_PAYMENT_METHODS: ${message}`);};
const name=value=>typeof value==='string'&&value.trim()&&value.length<=255&&!/[\x00-\x1f\x7f]/.test(value)?value.trim():fail('invalid method name');
const normalize=value=>name(value).normalize('NFKC').replace(/\s+/g,' ').toLocaleUpperCase('es');
async function nativeGet(client,path){
 if(client.host!==origin||!/^\/rest\/(?:paymentmethod\/getAll|saleorder\/[1-9]\d*)$/.test(path))fail('unexpected tenant or route');
 if(!client.token||Date.now()>client.tokenExpiresAt-60000)await client.authenticate();
 const response=await client.fetchImpl(`${origin}/ERPBerma${path}`,{method:'GET',headers:{authorization:`Bearer ${client.token}`,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)fail(`native read failed (${response.status})`);
 const limit=1024*1024;if(Number(response.headers.get('content-length'))>limit)fail('native response too large');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();fail('native response too large');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{fail('native response is not JSON');}
}
export async function readPaymentMethods(client,input={}){
 if(!object(input)||Object.keys(input).some(k=>k!=='name'))fail('unknown catalogue argument');
 const wanted=input.name===undefined?null:normalize(input.name);
 const raw=await nativeGet(client,'/rest/paymentmethod/getAll');
 if(!Array.isArray(raw)||raw.length>1000)fail('invalid catalogue');
 const ids=new Set();const methods=raw.map(row=>{
  if(!object(row)||!positive(row.paymentmethodid)||ids.has(row.paymentmethodid))fail('invalid or duplicate native method ID');
  ids.add(row.paymentmethodid);return {payment_method_id:row.paymentmethodid,name:name(row.paymentmethod)};
 });
 const matches=wanted===null?methods:methods.filter(row=>normalize(row.name)===wanted);
 if(wanted!==null&&matches.length!==1)fail(matches.length?'ambiguous exact payment method':'payment method not found');
 return {schema_version:1,payment_methods:matches,matching:'exact normalized name only; no fuzzy match'};
}
export async function readOrderConditions(client,orderId){
 if(!positive(orderId))fail('positive order ID required');
 const row=await nativeGet(client,`/rest/saleorder/${orderId}`);
 if(!object(row)||row.saleorderid!==orderId||row.contractorid?.contractorid!==1||!positive(row.customerid?.customerid))fail('order identity or tenant mismatch');
 const payment=row.paymentmethodid;
 if(payment!==null&&(!object(payment)||!positive(payment.paymentmethodid)))fail('invalid order payment method');
 return {order_id:orderId,contractor_id:1,customer_id:row.customerid.customerid,payment_method_id:payment?.paymentmethodid??null,payment_method:payment===null?null:name(payment.paymentmethod)};
}
export function assertPaymentConditions(conditions,order,expectedId){
 if(conditions.order_id!==order.order_id||conditions.customer_id!==order.customer_id||conditions.contractor_id!==1)fail('order identity mismatch');
 if(expectedId!==undefined&&conditions.payment_method_id!==expectedId)fail('payment method ID readback mismatch');
 if(conditions.payment_method===null?order.payment_method!=null&&order.payment_method!=='':normalize(conditions.payment_method)!==normalize(order.payment_method))fail('payment method label readback mismatch');
}
