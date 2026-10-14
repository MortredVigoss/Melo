import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteRegistry } from './routeRegistry.js';
import { domainRouteInventory,matchesDomainRoute,handleDomainRoutes } from './domainRoutes.js';
import { createTtsRoutes } from './ttsRoutes.js';
test('the same route declaration handles matching, method restrictions and authorization',async()=>{
  let calls=0;
  const router=createRouteRegistry([{method:'POST',path:'/api/write',auth:'local-write',handler:async()=>{calls++;}}]);
  const url=new URL('http://localhost/api/write');
  assert.equal(router.matches({method:'GET'},url),false);
  assert.equal(await router.handle({method:'GET'},{},url,()=>true),false);
  assert.equal(await router.handle({method:'POST'},{},url,()=>false),true);
  assert.equal(calls,0,'denied writes must not reach the handler');
  await router.handle({method:'POST'},{},url,()=>true);assert.equal(calls,1);
  assert.throws(()=>createRouteRegistry([{method:'POST',path:'/api/write',auth:'local-read',handler(){}}]));
});
test('domain and voice inventories are unique and every declared write is gated before dispatch',async()=>{
  const voice=createTtsRoutes({startVoicePackServers:()=>{throw Error('must not start');}});
  const inventories=[domainRouteInventory,voice.inventory];
  for(const rows of inventories) {
    assert.equal(new Set(rows.map(r=>r.method+' '+r.path)).size,rows.length);
    assert.ok(rows.filter(r=>r.method!=='GET').every(r=>r.auth==='local-write'));
  }
  for(const row of domainRouteInventory.filter(r=>r.method==='POST'&&!r.path.includes(':'))) {
    const request={method:'POST'},url=new URL('http://localhost'+row.path);
    assert.equal(matchesDomainRoute(request,url),true);
    await handleDomainRoutes(request,{},url,()=>false);
  }
});
