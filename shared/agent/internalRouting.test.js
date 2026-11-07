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
test('feedback may import member effect fingerprints so the lead never repeats a completed or uncertain write', async () => {
  const { startTurn, advanceTurn } = await import('./turn.js');
  let state = startTurn({runId:'r',turnId:'t',allowedTools:['file_write','file_read'], now:0}), tick=0;
  const event = (type, payload={}) => {state=advanceTurn(state,{type,runId:'r',turnId:'t',...payload},++tick);};
  const write = (id, fingerprint) => ({id,name:'file_write',arguments:{path:'one',content:'value'},effect:'write',fingerprint});
  event('request');event('feedback',{internalRouting:true,successfulEffects:['member-wrote-one'],uncertainEffects:['member-maybe-two', 7, '']});
  event('request');event('calls',{calls:[write('again','member-wrote-one'),write('maybe','member-maybe-two'),{id:'read',name:'file_read',arguments:{path:'one'},effect:'read'}]});
  assert.deepEqual(state.permitted,['read']);
  assert.equal(state.rejections.again,'ALREADY_EXECUTED');assert.equal(state.rejections.maybe,'ALREADY_ATTEMPTED');
});

// 2026-11-07 review P1-2/P1-3: the lead routes, assigns, evaluates and reports;
// web retrieval belongs to the research member, first-hand posts to the social member.
test('retrieval members own retrieval: the lead is told so and hosts withhold exactly their tools', async () => {
  const { internalRouteCatalog, leadWithheldTools, internalRouting } = await import('./internalRouting.js');
  const { TASK_EVALUATION_POLICY } = await import('./taskEvaluation.js');
  const tools = ['web_search', 'native_web_search', 'fetch_url', 'mcp:melo-xiaohongshu:search_feeds', 'mcp:melo-public-media:read_post', 'calculator', 'file_read'];
  const catalog = internalRouteCatalog('查一下墨尔本咖啡节有哪些咖啡', tools);
  assert.deepEqual(catalog.roles.research, ['web_search', 'native_web_search', 'fetch_url']);
  assert.deepEqual(catalog.roles.social, ['mcp:melo-xiaohongshu:search_feeds', 'mcp:melo-public-media:read_post', 'web_search', 'native_web_search', 'fetch_url']);
  const withheld = leadWithheldTools(catalog);
  assert.deepEqual(withheld, ['web_search', 'native_web_search', 'fetch_url', 'mcp:melo-xiaohongshu:search_feeds', 'mcp:melo-public-media:read_post']);
  assert.deepEqual(internalRouting({ action: 'withheld', catalog }), withheld);
  assert.ok(!withheld.includes('calculator') && !withheld.includes('file_read'));
  assert.match(catalog.definition.description, /you hold no retrieval tools/);
  assert.match(catalog.definition.description, /assign the social member/);
  const m = TASK_EVALUATION_POLICY.member;
  assert.ok(catalog.definition.description.includes(`Members start with ${m.initialRounds} tool rounds and ${m.calls} tool calls`));
  assert.equal(m.initialRounds, 6); assert.equal(m.calls, 16);
  assert.equal(internalRouting({ action: 'limits' }).rounds, 6);
  // On the phone (no platform readers) the social member searches public permalinks.
  const phone = internalRouteCatalog('小红书上大家怎么评价这家店', ['native_web_search', 'open_url', 'web_screenshot', 'calculator']);
  assert.deepEqual(phone.roles.social, ['native_web_search', 'open_url']);
  assert.ok(leadWithheldTools(phone).includes('web_screenshot'));
  // Network-free requests have neither member, and the lead hears nothing about retrieval.
  const offline = internalRouteCatalog('不要联网，把 3 和 4 相加', [...tools]);
  assert.equal(offline.roles.research, undefined); assert.equal(offline.roles.social, undefined);
  assert.deepEqual(leadWithheldTools(offline), []); assert.doesNotMatch(offline.definition.description, /retrieval/i);
  assert.deepEqual(leadWithheldTools(null), []);
});
