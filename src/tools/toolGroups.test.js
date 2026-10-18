import test from 'node:test';
import assert from 'node:assert/strict';
import { toolGroupOf, wantedToolGroups, nextActivatedGroups, selectStableTools } from './toolGroups.js';

// 2026-10-17 design audit T1 / option A2: the tool array only grows within a chat.
const tools = ['file_read', 'bash', 'web_search', 'fetch_url', 'web_screenshot', 'browser_open', 'browser_click', 'pdf', 'xlsx', 'image', 'media_info', 'search_history'].map(id => ({ id }));

test('core tools are always present and extension groups need a hint', () => {
  assert.deepEqual(selectStableTools(tools, []).map(t => t.id), ['file_read', 'bash', 'web_search', 'fetch_url', 'web_screenshot', 'search_history']);
  assert.equal(toolGroupOf('web_screenshot'), 'core', 'web_screenshot is a small core definition, not a browser-group tool');
  assert.equal(toolGroupOf('browser_fill'), 'browser');
  assert.equal(toolGroupOf('pdf'), 'documents');
  assert.equal(toolGroupOf('image'), 'media');
  assert.equal(toolGroupOf('grep'), 'core');
});

test('hints activate groups and activation never shrinks', () => {
  const env = { MELO_CDP_ENABLED: '1' };
  const docs = wantedToolGroups({ text: '把这份报告导出成 pdf' });
  assert.deepEqual([...docs], ['documents']);
  const media = wantedToolGroups({ text: 'look', attachments: [{ kind: 'image', url: 'data:image/png;base64,AA==' }] });
  assert.deepEqual([...media], ['media']);
  assert.deepEqual([...wantedToolGroups({ text: '截图发我看看' })], ['media'], 'screenshot / preview wording counts as media');
  assert.deepEqual([...wantedToolGroups({ text: '放大看一下', history: [{ role: 'user', attachments: [{ kind: 'image', url: 'data:image/png;base64,AA==' }] }] })], ['media'], 'earlier images in the chat keep the media group');
  // Browser tools: available from the first turn whenever the CDP flag is on
  // (pre-A2 semantics), never without it, and off when the user disabled networking.
  assert.deepEqual([...wantedToolGroups({ text: 'hello', env })], ['browser']);
  assert.deepEqual([...wantedToolGroups({ text: 'open the page and click login', env: {} })], [], 'browser still needs the CDP flag');
  assert.deepEqual([...wantedToolGroups({ text: 'open the page', searchPlan: { exposedNetworkTools: ['browser_open'], reason: 'user-disabled-network' }, env })], [], 'user network-off wins');
  let activated = nextActivatedGroups([], docs);
  assert.deepEqual(activated, ['documents']);
  activated = nextActivatedGroups(activated, new Set());
  assert.deepEqual(activated, ['documents'], 'a turn without hints does not remove groups');
  activated = nextActivatedGroups(activated, media);
  assert.deepEqual(activated, ['documents', 'media']);
  assert.deepEqual(selectStableTools(tools, activated).map(t => t.id), ['file_read', 'bash', 'web_search', 'fetch_url', 'web_screenshot', 'pdf', 'xlsx', 'image', 'media_info', 'search_history']);
  assert.deepEqual(nextActivatedGroups(['bogus', 'media'], new Set(['nope'])), ['media'], 'unknown ids are dropped');
});

test('search routing no longer removes network tools from the stable set', () => {
  const noSearch = { route: 'none', reason: 'no-web-intent', exposedNetworkTools: [] };
  assert.deepEqual([...wantedToolGroups({ text: 'what is 2+2', searchPlan: noSearch, env: {} })], []);
  assert.ok(selectStableTools(tools, []).some(t => t.id === 'web_search'), 'web_search stays; the routing prompt decides use');
});
