// Operator-provisioned, temporary access to a disposable zero-value QA order.
// This never grants access from model-supplied identity or expectedOrder data.
export function qaOrderScope(binding,input,now=Date.now()) {
  const q=binding.qaOrderScope;
  if(binding.owner!=='david'||!q||!Number.isFinite(Date.parse(q.expiresAt))||Date.parse(q.expiresAt)<=now||
    !['orderId','customerId','offerId'].every(k=>Number.isSafeInteger(q[k])&&q[k]>0)||
    typeof q.reference!=='string'||!q.reference.startsWith('QA-ANL-')||
    !['update_order','record_order_delivery','update_order_status'].includes(input.type)||input.request?.orderId!==q.orderId) return null;
  const body=input.request.body;
  if(!body||typeof body!=='object'||Array.isArray(body))return null;
  if(input.type==='update_order'&&Object.keys(body).some(k=>k!=='lines'))return null;
  if(input.type==='update_order_status'&&(Object.keys(body).join(',')!=='status_id'||![1,2].includes(body.status_id)))return null;
  for(const line of body.lines??[]){
    if(input.type==='update_order'&&Object.keys(line).some(k=>!['line_id','quantity','final_quantity','delete'].includes(k)))return null;
    for(const key of ['quantity','final_quantity'])if(line[key]!==undefined&&(!Number.isFinite(line[key])||line[key]<0||line[key]>100000))return null;
  }
  if(input.type==='record_order_delivery'&&(!body.reference?.startsWith(q.reference+'-UI-')||body.lines?.some(l=>l.quantity<=0)))return null;
  return q;
}

export function assertQaOrderIdentity(scope,readback) {
  const order=readback?.data;
  if(!order||order.order_id!==scope.orderId||order.customer_id!==scope.customerId||order.offer_id!==scope.offerId||
    order.reference!==scope.reference||!Array.isArray(order.lines)||!order.lines.length||
    order.lines.some(line=>line.unit_price!==0))throw Error('ACCESS_DENIED');
}
