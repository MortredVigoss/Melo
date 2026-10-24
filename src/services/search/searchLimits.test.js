import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchLimits, withSearchLimits, searchLimits, SEARCH_LIMIT_DEFAULTS, scopedSearchRun } from './searchLimits.js';
import { searchRequest } from '../../../shared/agent/tools.js';
test('search configuration is bounded and immutable with per-request precedence', () => {
  assert.deepEqual(normalizeSearchLimits(),SEARCH_LIMIT_DEFAULTS);
  const value=normalizeSearchLimits({operationalLimits:{search:{maxResults:5,timeoutMs:100,cacheTtlMs:0,contentMaxChars:1e9}},agentRuntime:{search:{maxResults:2,timeoutMs:9000}}});
  assert.equal(value.maxResults,2);assert.equal(value.timeoutMs,9000);assert.equal(value.cacheTtlMs,0);assert.equal(value.contentMaxChars,50000);assert.equal(Object.isFrozen(value),true);
  const request=searchRequest({query:'weather',maxResults:8},{search:{backend:'http',endpoint:'https://fixture.invalid/search',maxResults:2}});assert.equal(request.body.maxResults,2);
});
test('concurrent searches bind limits before IO and cannot overwrite another request', async () => {
  let release;const gate=new Promise(resolve=>release=resolve);
  const config={operationalLimits:{search:{contentMaxChars:1234}}};
  const a=withSearchLimits(config,async()=>{await gate;assert.equal(searchLimits().contentMaxChars,1234);});
  config.operationalLimits.search.contentMaxChars=9999;
  const run=scopedSearchRun(async()=>{assert.equal(searchLimits().contentMaxChars,5678);release();await a;assert.equal(searchLimits().contentMaxChars,5678);});
  await run({}, {config:{operationalLimits:{search:{contentMaxChars:5678}}}});
  assert.equal(searchLimits(),SEARCH_LIMIT_DEFAULTS);
});

test('archived channel score limits are bounded without enabling a channel',async()=>{ const {replyScoreLimits}=await import('../remote/telegramReplyScore.js'); assert.deepEqual(replyScoreLimits(),{threshold:.55,grayMin:.3});assert.deepEqual(replyScoreLimits({operationalLimits:{remote:{replyThreshold:.2,grayMin:.9}}}),{threshold:.2,grayMin:.2}); });
