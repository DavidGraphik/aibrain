import test from 'node:test';
import assert from 'node:assert/strict';
import {outlookConfig,parseMailboxes} from '../lib/config.mjs';
test('configured mail accounts support any number of distinct employees without provider defaults',()=>{
 const accounts=[{name:'First employee',address:'first@example.test'},{name:'Second employee',address:'second@example.test',loginAddress:'second-login@example.test'}];
 assert.equal(parseMailboxes(JSON.stringify(accounts)).length,2);
 const env={OUTLOOK_PROVIDER:'imap_smtp',OUTLOOK_MAILBOXES_JSON:JSON.stringify(accounts),OUTLOOK_TOKEN_ENCRYPTION_KEY:'a'.repeat(64),OUTLOOK_IMAP_HOST:'imap.example.test',OUTLOOK_SMTP_HOST:'smtp.example.test'};
 const value=outlookConfig(env);assert.equal(value.imapHost,'imap.example.test');assert.equal(value.mailboxes[1].loginAddress,'second-login@example.test');
 assert.equal(value.dataDirectory,'/var/lib/aibrain/mail');
 assert.equal(outlookConfig({...env,OUTLOOK_DATA_DIR:'/private/synthetic-mail-state'}).dataDirectory,'/private/synthetic-mail-state');
 assert.throws(()=>outlookConfig({...env,OUTLOOK_IMAP_HOST:''}),/OUTLOOK_IMAP_HOST/);
 for(const invalid of [[],[accounts[0],accounts[0]],[{name:'x',address:'bad address'}]])assert.throws(()=>parseMailboxes(JSON.stringify(invalid)));
});
