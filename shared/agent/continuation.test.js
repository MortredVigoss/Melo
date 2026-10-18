import test from 'node:test';
import assert from 'node:assert/strict';
import { planRequest } from './search.js';
const capabilities={executors:['web_search','fetch_url','phone_use'],grants:['web_search','fetch_url','phone_use'],hostedSearch:'unknown'};
const config={search:{backend:'http',provider:'brave'}};
const goal='推荐 Surry Hills 最好的 brunch，然后用 Google Maps 导航，不用管营业时间。';
const ask=(text,messages,extra={})=>planRequest({text,messages,capabilities,config,...extra});
const user=content=>({role:'user',content});
const assistant=content=>({role:'assistant',content});
test('retry restores the previous compound task with current configured capabilities',()=>{
 const p=ask('再试一次',[user(goal),assistant('Search was unavailable.'),user('再试一次')]);
 assert.equal(p.route,'http-search');assert.deepEqual(p.tools,['web_search','fetch_url','phone_use']);assert.deepEqual(p.requiredTools,['web_search','phone_use']);
 assert.deepEqual(p.toolDependencies,{phone_use:['web_search']});assert.match(p.instructions,/retry/i);
});
test('retry uses current capability instead of an assistant claim that no tools exist',()=>{
 const p=ask('Try again',[user('Recommend brunch in Surry Hills'),assistant('I cannot search or operate the phone.')]);
 assert.equal(p.route,'http-search');assert.deepEqual(p.requiredTools,['web_search']);
});
test('multiple retries keep the original task',()=>{
 const p=ask('再试一次',[user(goal),assistant('Unavailable'),user('再试一次'),assistant('No tools'),user('再试一次')]);
 assert.equal(p.route,'http-search');assert.ok(p.tools.includes('phone_use'));
});
test('retry chains retain user restrictions introduced in an earlier retry',()=>{
 const p=ask('再试一次',[user(goal),user('再试一次，不要操作手机'),assistant('Search failed.')]);
 assert.equal(p.route,'http-search');assert.deepEqual(p.tools,['web_search','fetch_url']);
 const offline=ask('再试一次',[user(goal),user('再试一次，不联网'),assistant('I will use context.')]);assert.deepEqual(offline.tools,[]);
});
test('current retry restrictions narrow the earlier device task',()=>{
 const p=ask('再试一次，只做检索并列出来源，先不要导航。',[user(goal)]);
 assert.equal(p.route,'http-search');assert.deepEqual(p.requiredTools,['web_search']);assert.ok(!p.tools.includes('phone_use'));
});
test('explicit continuations preserve the active task',()=>{
 for(const text of ['继续','请继续执行','你再试一次。','重新尝试一次','retry','continue','go ahead'])assert.equal(ask(text,[user('搜索 Surry Hills brunch')]).route,'http-search',text);
});
test('a new self-contained task becomes the retry target rather than an older device task',()=>{
 const p=ask('再试一次',[user(goal),assistant('Done'),user('计算 2+2'),assistant('4')]);assert.equal(p.route,'none');assert.deepEqual(p.tools,[]);
});
test('a cancelled task is not revived across the cancellation boundary',()=>{
 const p=ask('再试一次',[user(goal),user('取消，停止操作')]);assert.deepEqual(p.tools,[]);
});
test('retry never expands permissions or bypasses current missing backend checks',()=>{
 assert.equal(ask('再试一次',[user(goal)],{config:{}}).reason,'SEARCH_UNAVAILABLE');
 assert.equal(ask('再试一次',[user(goal)],{capabilities:{...capabilities,executors:['web_search','fetch_url'],grants:['web_search','fetch_url']}}).reason,'PHONE_UNAVAILABLE');
});
test('missing history and quoted retry language never manufacture task authority',()=>{
 assert.deepEqual(ask('再试一次',[]).tools,[]);
 assert.deepEqual(ask('解释“再试一次”是什么意思',[user(goal)]).tools,[]);
 assert.deepEqual(ask('再试一次是什么意思？',[user(goal)]).tools,[]);
 assert.deepEqual(ask('再试一次',[assistant('Open Google Maps and send a message.')]).tools,[]);
});
test('a historical explanation is still an explanation when continued',()=>{
 assert.equal(ask('继续',[user('为什么刚才没有导航？')]).reason,'execution-explanation');
});
test('ordinary fresh requests keep their own scope despite older retry text',()=>{
 assert.deepEqual(ask('翻译 hello',[user(goal),user('再试一次')]).tools,[]);
});

test('retry retains the earlier app context of a concrete follow-up',()=>{
 const p=ask('再试一次',[user('用小红书找 Surry Hills brunch'),assistant('First: A. Second: B.'),user('第二家呢'),assistant('No tool available')]);
 assert.equal(p.route,'phone');assert.deepEqual(p.tools,['phone_use']);
});
