import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// Native runner follows the repository pattern: remove only type-only imports for dependency-free testing.
const source=readFileSync(new URL('../src/insijets/cms-proxy.ts',import.meta.url),'utf8').replace('from "./cms-access"','from "'+new URL('../src/insijets/cms-access.ts',import.meta.url).href+'"');
const {proxyCMS}=await import('data:text/javascript,'+encodeURIComponent((await import('node:module')).stripTypeScriptTypes(source)));
import {canAccessInsiJetsCMS,cmsPathAllowed} from '../src/insijets/cms-access.ts';
const session={provider:'local',user:{id:'owner-1',name:'David',email:'operator@example.invalid'},tenant:{id:'insijets-demo',name:'InsiJets'},expiresAt:new Date(Date.now()+60000).toISOString()};
const config={installationId:'insijets-demo',enabled:true,upstreamOrigin:'https://site.example.test',brainOrigin:'https://brain.example.test',signingKey:'synthetic-cms-key-12345678901234567890'};
const request=(path='/admin',options={})=>new Request(config.brainOrigin+'/api/insijets/cms'+path,options);
test('exact live local owners and tenant only; expired/demo/third-party users fail before upstream',async()=>{
 const fetchBefore=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('ok');};
 try{for(const [s,c] of [[null,config],[{...session,user:{...session.user,email:'third-admin@example.test'}},config],[{...session,provider:'demo'},config],[{...session,expiresAt:'2020-01-01'},config],[{...session,tenant:{id:'g03'}},config],[session,{...config,installationId:'arnall'}]]){const res=await proxyCMS(request(),c,s,'/admin');assert.ok([401,403].includes(res.status));}assert.equal(calls,0);
 for(const email of ['operator@example.invalid','cms-owner@example.invalid'])assert.equal(canAccessInsiJetsCMS({...session,user:{...session.user,email}},config.installationId),true);
 }finally{globalThis.fetch=fetchBefore;}
});
test('bounded content routes and same-origin JSON writes; headers/cookies stripped and body-bound signatures',async()=>{
 const fetchBefore=globalThis.fetch;let received;globalThis.fetch=async(url,options)=>{received={url,options};return new Response('{"ok":true}',{headers:{'content-type':'application/json','set-cookie':'provider-secret=value','location':'https://evil.test'}});};
 try {
 for(const path of ['/api/admin/users','/api/admin/requests','/api/gateway/action','/../admin','/%2e%2e/admin','/admin\\foo','/https://evil.test','/uploads/../../x'])assert.equal(cmsPathAllowed(path,'GET'),false,path);
 let res=await proxyCMS(request('/api/admin/content',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.test'},body:'{}'}),config,session,'/api/admin/content');assert.equal(res.status,403);assert.equal(received,undefined);
 res=await proxyCMS(request('/admin?token=secret'),config,session,'/admin');assert.equal(res.status,400);
 const body=JSON.stringify({id:'fixture'});res=await proxyCMS(request('/api/admin/content',{method:'POST',headers:{origin:config.brainOrigin,'content-type':'application/json',cookie:'brain_secret=never-forward','x-insijets-cms-signature':'forged'},body}),config,session,'/api/admin/content');assert.equal(res.status,200);assert.equal(res.headers.get('set-cookie'),null);assert.equal(res.headers.get('location'),null);assert.equal(received.options.headers.cookie,undefined);assert.equal(received.url,config.upstreamOrigin+'/brain-cms/api/admin/content');assert.equal(received.options.redirect,'manual');const claims=JSON.parse(Buffer.from(received.options.headers['X-InsiJets-CMS-Assertion'],'base64url'));assert.equal(claims.email,session.user.email);assert.equal(claims.target,'/brain-cms/api/admin/content');assert.equal(claims.method,'POST');assert.equal(received.options.body.toString(),body);assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'self'/);
 }finally{globalThis.fetch=fetchBefore;}
});
test('disabled/foreign configuration and upstream redirects are fail closed',async()=>{
 assert.equal((await proxyCMS(request(),{...config,enabled:false},session,'/admin')).status,503);
 for(const upstreamOrigin of ['http://evil.test','https://site.example.test/extra','https://user:secret@site.example.test','https://site.example.test/?token=x'])assert.equal((await proxyCMS(request(),{...config,upstreamOrigin},session,'/admin')).status,503);
 const before=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'https://evil.test'}});try{assert.equal((await proxyCMS(request(),config,session,'/admin')).status,502);}finally{globalThis.fetch=before;}
});
