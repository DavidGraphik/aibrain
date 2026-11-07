import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {actionPreview} from '../bin/sibema-action.mjs';

test('PDF approval metadata preserves exact bytes without a base64-like placeholder',()=>{
  const bytes=Buffer.from('%PDF-1.7\nreal uploaded bytes\n%%EOF');
  const stored={request_json:JSON.stringify({offerId:102,body:{filename:'offer.pdf',content_base64:bytes.toString('base64')}})};
  const preview=actionPreview(stored,true);
  assert.deepEqual(preview.request.body.content_base64,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  assert.equal(JSON.parse(stored.request_json).body.content_base64,bytes.toString('base64'));
  assert.ok(!JSON.stringify(preview).includes(bytes.toString('base64')));
});
