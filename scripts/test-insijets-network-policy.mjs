import test from 'node:test';import assert from 'node:assert/strict';import {renderSquid} from '../infra/insijets/network/render-squid.mjs';
const base={compartment:'research',approvedHosts:['example.com'],clientSubnet:'172.30.81.0/24'};
test('production Squid is deny-by-default and rejects CRM hosts, wildcards, IPs and unsafe configuration',()=>{
 const config=renderSquid(base);assert.ok(config.endsWith('http_access deny all\n'));assert.ok(config.includes('http_access deny private_dest'));assert.ok(config.includes('http_access deny crm'));assert.ok(config.includes('http_access deny CONNECT !SSL_ports'));assert.ok(config.includes('access_log none'));assert.equal(config.includes('SYNTHETIC CI FIXTURE'),false);
 for(const h of ['api.hubapi.com','app.hubspot.com','tenant.myfreshworks.com','*.example.com','example.com\nhttp_access allow all','127.0.0.1','EXAMPLE.com'])assert.throws(()=>renderSquid({...base,approvedHosts:[h]}));
 assert.throws(()=>renderSquid({...base,fixtureAddress:'127.0.0.1'}));assert.throws(()=>renderSquid({...base,clientSubnet:'0.0.0.0/0'}));
});
test('provider compartment has independent exact endpoints and logging does not retain payloads',()=>{
 const p=renderSquid({compartment:'provider',approvedHosts:['approved-gateway.example.test'],clientSubnet:'172.30.82.0/24'});assert.ok(p.includes('approved-gateway.example.test'));assert.ok(p.includes('cache deny all'));assert.equal(p.includes('example.com'),false);assert.ok(p.includes('http_access deny !client'));
});
