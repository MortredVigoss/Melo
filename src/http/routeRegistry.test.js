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

test('a local-write route dispatched without an origin gate throws instead of hanging', async () => {
  // Regression for the 2026-10-17 audit P0-1: server.js called
  // ttsRoutes.handle(request, response, url) without the gate, and the
  // registry treated the missing function as "denied" — returning true with
  // no response written, so every POST /api/tts/* and /api/audio/transcribe
  // request hung until the socket timed out.
  let calls = 0;
  const router = createRouteRegistry([{ method: 'POST', path: '/api/write', auth: 'local-write', handler: async () => { calls++; } }]);
  const url = new URL('http://localhost/api/write');
  await assert.rejects(router.handle({ method: 'POST' }, {}, url), /no requireLocalOrigin gate/);
  assert.equal(calls, 0);
  // Reads never need the gate.
  const reads = createRouteRegistry([{ method: 'GET', path: '/api/read', auth: 'local-read', handler: async () => { calls++; } }]);
  assert.equal(await reads.handle({ method: 'GET' }, {}, new URL('http://localhost/api/read')), true);
  assert.equal(calls, 1);
});
