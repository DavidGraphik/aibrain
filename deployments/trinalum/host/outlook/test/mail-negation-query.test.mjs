import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {compileImapQuery,mailApiContract} from '../lib/mail-api.mjs';
const require=createRequire(import.meta.url),{searchCompiler}=require('imapflow/lib/search-compiler.js'),{compiler}=require('imapflow/lib/handler/imap-handler.js');
const connection={mailbox:{},enabled:new Set(),capabilities:new Set()};
test('unary NOT excludes only the verified Message-ID and preserves required query predicates on the IMAP wire',async()=>{
 const query='subject:"order confirmation" NOT messageid:"<original.42@example.test>"',criteria=compileImapQuery(query);
 assert.deepEqual(criteria,{not:{or:[{not:{subject:'order confirmation'}},{not:{not:{header:{'Message-ID':'<original.42@example.test>'}}}}]}});
 const attrs=searchCompiler(connection,criteria),wire=(await compiler({tag:'A1',command:'UID SEARCH',attributes:attrs})).toString();
 assert.match(wire,/SUBJECT "order confirmation"/);assert.match(wire,/NOT HEADER MESSAGE-ID <original\.42@example\.test>/);assert.equal(wire.includes('\r\n'),false);
});
test('NOT precedence, groups, field inheritance and quoted literal NOT remain deterministic',()=>{
 assert.deepEqual(compileImapQuery('NOT (from:a OR from:b)'),{not:{or:[{from:'a'},{from:'b'}]}});
 assert.deepEqual(compileImapQuery('NOT NOT subject:x'),{not:{not:{subject:'x'}}});
 assert.deepEqual(compileImapQuery('subject:(x OR NOT y)'),{or:[{subject:'x'},{not:{subject:'y'}}]});
 assert.deepEqual(compileImapQuery('"NOT"'),{text:'NOT'});
 assert.deepEqual(compileImapQuery('body:"visible phrase" OR NOT is:unread'),{or:[{body:'visible phrase'},{not:{seen:false}}]});
});
test('missing operands, malformed IDs, unsupported negatives, injection and existing complexity caps reject',()=>{
 for(const query of ['NOT','subject:x AND NOT','NOT ()','NOT OR subject:x','messageid:','messageid:plain@example.test','messageid:"<bad id@example.test>"','messageid:"<id@example.test>\\r\\nX:bad"','-subject:x','NOT '.repeat(7)+'x','x '.repeat(65),'subject:('+ '('.repeat(7)+'x'+')'.repeat(8)])assert.throws(()=>compileImapQuery(query),undefined,query);
 assert.throws(()=>compileImapQuery('messageid:"<id@example.test>"\r\nUID SEARCH ALL'));
});
test('native discovery advertises implemented unary NOT and exact original Message-ID selector',()=>{
 assert.ok(mailApiContract().searchGrammar.operators.includes('NOT'));assert.ok(mailApiContract().searchGrammar.fields.includes('messageid'));assert.match(mailApiContract().searchGrammar.messageid,/HEADER Message-ID/);
});
