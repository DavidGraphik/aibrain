import test from 'node:test';
import assert from 'node:assert/strict';
import {mailSearchIntentQuery} from '../lib/mail-search-intent.mjs';
import {compileImapQuery} from '../lib/mail-api.mjs';

test('one structured lookup preserves reference, all company terms, sender and dates',()=>{
 const query=mailSearchIntentQuery({reference:'987654-A:1234',referenceIn:'subject',companies:['Example supplier','Example customer'],from:'sender@example.test',after:'2026-01-01',before:'2026-02-01'});
 assert.equal(query,'subject_reference:"987654-A:1234" AND text:"Example supplier" AND text:"Example customer" AND from:"sender@example.test" AND after:2026-01-01 AND before:2026-02-01');
 const native=JSON.stringify(compileImapQuery(query));
 for(const term of ['987654 - A:1234','Example supplier','Example customer','sender@example.test','2026-01-01','2026-02-01'])assert.ok(native.includes(term),term);
});
test('quoted business text cannot inject an OR or alter another constraint',()=>{
 const query=mailSearchIntentQuery({reference:'123-45',companies:['A " OR from:other@example.test OR " B']});
 const native=JSON.stringify(compileImapQuery(query));assert.ok(native.includes('A \\" OR from:other@example.test OR \\" B'));assert.ok(!native.includes('"from":"other@example.test"'));
});
test('rejects missing reference scope, extra fields and invalid dates without broadening',()=>{
 for(const input of [{},{referenceIn:'subject'},{companies:[]},{reference:'123-4',mailbox:'other@example.test'},{reference:'123-4',after:'2026-02-30'},{text:'x',after:'2026-02-01',before:'2026-01-01'}])assert.throws(()=>mailSearchIntentQuery(input),{code:'MAIL_SEARCH_INTENT_INVALID'});
});
