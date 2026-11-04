import test from 'node:test';
import assert from 'node:assert/strict';
import { internalRouteCatalog, startInternalJob, internalHandoff, MAX_ASSIGNMENTS } from './internalRouting.js';
import { calculateNumber, safeMathEval } from './arithmetic.js';
import { evaluate } from './index.js';
const tools = ['calculator','web_search','open_url','file_write','calendar_list_events','unknown_tool'];
const goal = 'Find the concert temperature, then convert it to Fahrenheit';
const catalog = internalRouteCatalog(goal, tools);
test('routing derives only from host capabilities and user policy; simple greeting has no control', () => {
  assert.equal(internalRouteCatalog('Hello',tools), null);
  assert.equal(internalRouteCatalog('No tools. Use only the supplied text.',[]), null);
  assert.deepEqual(catalog.roles.calculate,['calculator']);
  assert.ok(!Object.values(catalog.roles).flat().includes('unknown_tool'));
  assert.equal(internalRouteCatalog('不要联网，读取日历并计算差值',tools).roles.research,undefined);
  assert.equal(internalRouteCatalog(goal,[]),null);
  assert.equal(internalRouteCatalog('只依据提供的正文回答',tools),null);
  assert.ok(startInternalJob({catalog,goal,args:{role:'__proto__',task:'read'}}).error);
});
test('bounded, scoped member handoff requires real receipts; isolated child facts do not certify the goal', () => {
  const args = {role:'calculate',task:'Convert 20 °C'};
  const job = startInternalJob({catalog,goal,args});
  assert.deepEqual(job.tools,['calculator']);
  for (const callId of ['', ' '.repeat(4), 'a'.repeat(257)]) assert.ok(startInternalJob({catalog,goal,args,callId}).error);
  assert.ok(startInternalJob({catalog,goal,args,assignments:[job]}).error);
  assert.ok(startInternalJob({catalog,goal,args,assignments:Array(MAX_ASSIGNMENTS).fill({})}).error);
  assert.equal(JSON.parse(internalHandoff({job,answer:'I found 68 °F',observations:[{type:'tool',executed:false,ok:true}]})).status,'unverified');
  const observed = [{name:'calculator',type:'tool',ok:true,executed:true,id:'calc',output:'68 °F'}];
  assert.match(internalHandoff({job,observations:observed}),/68 °F/);
  assert.equal(JSON.parse(internalHandoff({job,observations:observed,limited:true})).status,'partial');
  assert.deepEqual(evaluate({version:1,op:'internalRouting',action:'catalog',goal,tools}).value,catalog);
});
test('portable math and conversions do not execute JavaScript', () => {
  assert.equal(calculateNumber({action:'convert',value:20,from:'celsius',to:'fahrenheit'}).result,68);
  assert.equal(safeMathEval('sqrt(144)+2^3'),20);
  assert.equal(safeMathEval('2**3**2'),512);
  assert.equal(safeMathEval('-2^2+2^-2'),-3.75);
  for (const expression of ['process.exit()', 'Math.random.constructor()', '1/0', '1 2', 'abs.constructor', 'constructor()', '2'.repeat(1025)]) assert.throws(()=>safeMathEval(expression));
});
test('handoff transitions never reapply completed or uncertain external writes', async () => {
  const { startTurn, advanceTurn } = await import('./turn.js');
  for (const initial of [{ok:true},{ok:false,code:'TIMEOUT'}]) {
    let state = startTurn({runId:'r',turnId:'t',allowedTools:['file_write'], now:0}), tick=0, effects=0;
    const event = (type, payload={}) => {state=advanceTurn(state,{type,runId:'r',turnId:'t',...payload},++tick);};
    const effect = id => ({id,name:'file_write',arguments:{path:'one',content:'value'},effect:'write'});
    event('request');event('feedback',{internalRouting:true});event('request');event('calls',{calls:[effect('first'),effect('same-batch')]});
    effects += state.permitted.length;assert.deepEqual(state.permitted,['first']);
    event('result',{callId:'first',...initial});event('result',{callId:'same-batch',ok:false,code:'ALREADY_ATTEMPTED'});
    event('request');event('feedback');event('request');event('calls',{calls:[effect('repeat')]});
    effects+=state.permitted.length;assert.equal(effects,1);
  }
});
test('host suggestions extend jobs from declarations but never override static lists, the deny list or policy', () => {
  const extra = ['bash','media_info','translate','mcp:s:read','delegate','skill:foo','route_task','development_job'];
  const suggestions = {bash:'execute', media_info:'lookup', translate:'calculate', 'mcp:s:read':'research', delegate:'execute', 'skill:foo':'execute',
    route_task:'execute', development_job:'execute', web_search:'calculate', ghost:'lookup', bogus:'nope'};
  const all = [...tools, ...extra];
  const extended = internalRouteCatalog(goal, all, suggestions);
  assert.deepEqual(extended.roles.execute, ['file_write','bash']);
  assert.deepEqual(extended.roles.calculate, ['calculator','translate']);
  assert.ok(extended.roles.lookup.includes('media_info') && extended.roles.research.includes('mcp:s:read'));
  assert.ok(extended.roles.research.includes('web_search') && !extended.roles.calculate.includes('web_search'));
  assert.ok(!Object.values(extended.roles).flat().some(id => ['delegate','skill:foo','route_task','development_job','ghost','bogus'].includes(id)));
  assert.equal(internalRouteCatalog('不要联网，读取日历并计算差值', all, suggestions).roles.research, undefined);
  assert.deepEqual(internalRouteCatalog(goal, all), internalRouteCatalog(goal, all, null));
  assert.deepEqual(internalRouteCatalog(goal, all, 'bash'), internalRouteCatalog(goal, all));
  assert.deepEqual(evaluate({version:1,op:'internalRouting',action:'catalog',goal,tools:all,suggestions}).value, extended);
});
