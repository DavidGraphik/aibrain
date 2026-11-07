import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {SibemaClient} from '../lib/sibema-client.mjs';
import {specification} from '../lib/api-contract.mjs';
test('provider client refuses another origin even with valid credentials',()=>{
 assert.throws(()=>new SibemaClient({username:'synthetic',password:'synthetic',host:'https://other.example.test'}),/protected installation/);
});
test('protected origin and namespace configure every provider route without an operational default',()=>{
 const module=new URL('../lib/sibema-client.mjs',import.meta.url).href;
 const code=`const {SibemaClient}=await import(${JSON.stringify(module)});const c=new SibemaClient({username:'synthetic',password:'synthetic'});process.stdout.write(JSON.stringify({host:c.host,base:c.base}));`;
 const env={...process.env,AIBRAIN_SIBEMA_ORIGIN:'https://tenant.example.test',SIBEMA_API_NAMESPACE:'tenant'};
 let r=spawnSync(process.execPath,['--input-type=module','-e',code],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{host:'https://tenant.example.test',base:'https://tenant.example.test/ERPBerma/tenant/api/v1'});
 for(const change of [{AIBRAIN_SIBEMA_ORIGIN:'http://tenant.example.test'},{AIBRAIN_SIBEMA_ORIGIN:'https://tenant.example.test/other'},{SIBEMA_API_NAMESPACE:'../other'}]){r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...env,...change},encoding:'utf8'});assert.notEqual(r.status,0);}
});
test('a configured native namespace retains the same operation/schema fingerprint',()=>{
 const module=new URL('../lib/api-contract.mjs',import.meta.url).href;
 const code=`const {specification,contractFingerprint}=await import(${JSON.stringify(module)});const native=structuredClone(specification);native.paths=Object.fromEntries(Object.entries(native.paths).map(([path,schema])=>[path.replace('/company/api/v1/','/tenant/api/v1/'),schema]));if(contractFingerprint('POST','/customers')!==contractFingerprint('POST','/customers',native))throw Error('contract changed');`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,SIBEMA_API_NAMESPACE:'tenant'},encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
test('public provider examples carry only synthetic contact and address values',()=>{
 const example=specification.paths['/company/api/v1/customers'].post.requestBody.content['application/json'].example;
 assert.equal(example.name,'Empresa Sintética de Ejemplo S.L.');
 assert.equal(example.email,'purchasing@example.test');
 assert.equal(example.phone,'+12025550100');
 assert.equal(example.vat_number,'SYNTHETIC-TAX-001');
 assert.deepEqual(example.address,{street:'Calle de Ejemplo 1',postal_code:'00000',town_id:1,state_id:1,country_id:1});
 const text=JSON.stringify(specification);
 const emails=text.match(/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)??[];
 assert(emails.every(email=>email.endsWith('@example.test')));
 assert(specification.servers.every(server=>new URL(server.url).hostname.endsWith('.example.invalid')));
 assert.match(specification.info.title,/Empresa de ejemplo/);
});
