import { createHmac, timingSafeEqual } from 'node:crypto';
function equal(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
/** Verify provider identity before the upstream controller sees any event. */
export function verifyInbound(req) {
  if (req.body?.MessageSid && req.body?.From) {
    const secret = process.env.TWILIO_AUTH_TOKEN;
    const url = process.env.HORARIA_PUBLIC_WEBHOOK_URL;
    if (!secret || !url) return false;
    const data = url + Object.keys(req.body).sort().map(key => key + req.body[key]).join('');
    return equal(req.get('x-twilio-signature'), createHmac('sha1', secret).update(data).digest('base64'));
  }
  if (process.env.WHATSAPP_PROVIDER === '360dialog') {
    return !!process.env.HORARIA_WEBHOOK_SECRET && equal(req.get('x-horaria-webhook-secret'), process.env.HORARIA_WEBHOOK_SECRET);
  }
  const secret = process.env.META_APP_SECRET;
  return !!secret && equal(req.get('x-hub-signature-256'), `sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}`);
}
