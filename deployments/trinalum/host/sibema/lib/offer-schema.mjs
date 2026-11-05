const fields = new Set(['description','customer_id','vendor_id','payment_method_id','incoterm_id','valid_from','valid_until','remarks','lines']);
export function validateOfferBody(body) {
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new Error('Offer body must be an object');
  // Live POST /offers confirmed the ERP's VARCHAR(255) limit on remarks.
  if (body.remarks != null && (typeof body.remarks !== 'string' || [...body.remarks].length>255)) throw new Error('Offer remarks must be at most 255 characters. Summarize all essential conditions explicitly; never silently truncate or claim the PDF was uploaded.');
  for (const key of Object.keys(body)) {
    if (!fields.has(key)) throw new Error(`Unsupported offer field ${key}. Use vendor_id, payment_method_id, incoterm_id with verified IDs; preserve textual conditions in remarks. Never invent an ID.`);
    if (key.endsWith('_id') && (!Number.isSafeInteger(Number(body[key])) || Number(body[key])<1)) throw new Error(`${key} must be a verified positive integer`);
  }
  for (const key of ['valid_from','valid_until']) if (body[key]!=null && (typeof body[key]!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(body[key]) || !Number.isFinite(Date.parse(body[key])) || new Date(body[key]).toISOString().slice(0,10)!==body[key])) throw new Error(`${key} must be a real YYYY-MM-DD date`);
  if (body.valid_from && body.valid_until && body.valid_from>body.valid_until) throw new Error('Offer validity ends before it starts');
  if ('lines' in body && !Array.isArray(body.lines)) throw new Error('Offer lines must be an array; omit to preserve existing lines');
  for (const line of body.lines??[]) {
    if (!line || typeof line!=='object' || Array.isArray(line)) throw new Error('Invalid offer line');
    for (const key of Object.keys(line)) if (!['product_id','quantity_from','unit_id','price'].includes(key)) throw new Error(`Unsupported offer line field ${key}`);
    for (const key of ['quantity_from','price']) if (line[key]!=null && (line[key]==='' || typeof line[key]==='boolean' || !Number.isFinite(Number(line[key])) || Number(line[key])<0)) throw new Error(`Invalid offer ${key}`);
  }
}
