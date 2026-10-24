import test from 'node:test';
import assert from 'node:assert/strict';
import { toolGroupOf, wantedToolGroups, nextActivatedGroups, selectStableTools } from './toolGroups.js';
const tools = ['calculator', 'web_search', 'fetch_url', 'browser_open', 'browser_click', 'pdf', 'xlsx', 'image', 'media_info'].map(id => ({id}));

test('authorized document/media catalogs do not depend on wording, language or old history', () => {
  for (const text of ['2+2', 'translate this', '背景を変更', '배경 바꾸기', 'haz una tabla', '继续']) {
    const groups = nextActivatedGroups([], wantedToolGroups({text}));
    assert.deepEqual(selectStableTools(tools, groups).map(t=>t.id), ['calculator','web_search','fetch_url','pdf','xlsx','image','media_info'], text);
  }
  assert.equal(toolGroupOf('browser_fill'), 'browser');
  assert.equal(toolGroupOf('web_screenshot'), 'core');
  assert.equal(toolGroupOf('pdf'), 'documents');
});
test('browser opt-in and explicit current network restrictions take effect immediately', () => {
  const env = {MELO_CDP_ENABLED:'1'};
  assert.ok(wantedToolGroups({env}).has('browser'));
  for (const searchPlan of [{reason:'user-disabled-network'}, {reason:'network-forbidden'}, {sharedPlan:{network:{fetchForbidden:true}}}]) {
    const groups=nextActivatedGroups([],wantedToolGroups({env,searchPlan}));
    assert.equal(selectStableTools(tools,groups).some(t=>t.id.startsWith('browser_')),false);
  }
  assert.equal(nextActivatedGroups([],wantedToolGroups()).includes('browser'),false);
  assert.deepEqual(nextActivatedGroups(['bogus','media'],new Set(['nope'])),['media'],'historical merge stays lossless, but the live catalog ignores it');
});
test('search route does not control permission to use other authorized tools', () => {
  const groups=nextActivatedGroups([],wantedToolGroups({env:{MELO_CDP_ENABLED:'1'},searchPlan:{route:'none'}}));
  assert.deepEqual(selectStableTools(tools,groups),tools);
  assert.deepEqual(selectStableTools(tools.filter(t=>t.id==='calculator'),groups).map(t=>t.id),['calculator'],'groups cannot add unauthorized tools');
});
