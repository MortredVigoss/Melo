import test from 'node:test';
import assert from 'node:assert/strict';
import { executionScene, executionContext, publicReasoning } from './execution.js';
import { startTurn, advanceTurn } from './turn.js';
import { replyPresentation, inlinePresentation } from '../../src/shared/replyDocument.js';

test('observed tool start and result survive JSON persistence without turning snippets into page reads', () => {
  let scene = executionScene({ action: 'create', runId: 'r', chatId: 'c', query: 'brunch', at: '2026-10-18T01:00:00Z' });
  const observe = event => { scene = executionScene({ action: 'event', scene: JSON.parse(JSON.stringify(scene)), at: '2026-10-18T01:00:01Z', event }); };
  observe({ kind: 'operation', id: 's', name: 'web_search', module: 'search', input: 'brunch', status: 'running' });
  observe({ kind: 'operation', id: 's', status: 'completed', sources: [{ url: 'https://fixture.invalid/menu', reading: 'snippet' }], output: '2 candidates' });
  assert.equal(scene.operations.length, 1); assert.equal(scene.sources[0].accessed, false);
  observe({ kind: 'operation', id: 'f', name: 'fetch_url', status: 'completed', sources: [{ url: 'https://fixture.invalid/menu', accessed: true }] });
  assert.equal(scene.sources.length, 1); assert.equal(scene.sources[0].reading, 'extracted');
  scene = executionScene({ action: 'finish', scene, outcome: 'partial', reason: 'PHONE_UNAVAILABLE', at: '2026-10-18T01:00:02Z' });
  assert.equal(scene.taskOutcome, 'partial'); assert.equal(scene.status, 'failed');
  assert.match(executionContext([scene]), /PHONE_UNAVAILABLE/);
  assert.equal(executionScene({ action: 'event', scene, event: { id: 'late', status: 'completed' } }).operations.length, 2);
  assert.match(executionContext([null]), /no recorded tool details/);
});

test('only public summary_text is displayed; opaque/internal reasoning and sensitive URLs are excluded', () => {
  assert.equal(publicReasoning([{ type: 'reasoning', encrypted_content: 'private', content: [{ text: 'internal' }], summary: [{ type: 'summary_text', text: 'Public summary' }, { type: 'reasoning_text', text: 'hidden' }] }, { type: 'thinking', thinking: 'hidden' }]), 'Public summary');
  let scene = executionScene({ action: 'create', runId: 'r', chatId: 'c', query: '', at: 'now' });
  scene = executionScene({ action: 'event', scene, at: 'now', event: { id: 's', sources: [{ url: 'javascript:alert(1)' }, { url: 'https://user:pass@fixture.invalid' }, { url: 'https://fixture.invalid?api_key=secret' }], output: 'Bearer sensitive1234', input: '{"password":"raw-secret","url":"https://fixture.invalid?token=raw-query"}' } });
  assert.equal(scene.sources.length, 1); assert.match(scene.sources[0].url, /redacted/); assert.doesNotMatch(JSON.stringify(scene), /sensitive1234/);
  assert.doesNotMatch(JSON.stringify(scene), /raw-secret|raw-query/);
});

test('navigation cannot precede its required research even under a new tool call ID', () => {
  let state = startTurn({ runId: 'r', turnId: 't', now: 0, allowedTools: ['web_search', 'phone_use'], requiredTools: ['web_search', 'phone_use'], toolDependencies: { phone_use: ['web_search'] } });
  const send = (type, fields = {}) => { state = advanceTurn(state, { type, runId: 'r', turnId: 't', ...fields }, 0); };
  send('request'); send('calls', { calls: [{ id: 'early', name: 'phone_use', arguments: { goal: 'Navigate', purpose: 'action' } }] });
  assert.equal(state.rejections.early, 'PREREQUISITE_MISSING'); assert.deepEqual(state.phoneTasks, []);
  send('result', { callId: 'early', ok: false });
  send('request'); send('calls', { calls: [{ id: 's', name: 'web_search', arguments: { query: 'brunch' } }] }); send('result', { callId: 's', ok: true });
  send('request'); send('calls', { calls: [{ id: 'nav', name: 'phone_use', arguments: { goal: 'Navigate', purpose: 'action' } }] });
  assert.deepEqual(state.permitted, ['nav']);
});

test('shared Markdown presentation handles emphasis, code literals, safe links and narrow-screen table structure', () => {
  const blocks = replyPresentation('# Heading\n\n- **Single O** and `a_b * c`\n\n[Maps](https://maps.fixture.invalid/place_(a))\n\n| Name | Note |\n|---|---|\n| A | **Good** |\n\n```js\na_b * c\n```');
  assert.deepEqual(blocks.map(row => row.type), ['heading', 'list', 'paragraph', 'table', 'code']);
  assert.equal(blocks[1].inline.find(span => span.bold).text, 'Single O');
  assert.equal(blocks[1].inline.find(span => span.code).text, 'a_b * c');
  assert.equal(blocks[2].inline[0].url, 'https://maps.fixture.invalid/place_(a)');
  assert.equal(blocks[3].cells[1][1][0].bold, true);
  assert.equal(blocks[4].text, 'a_b * c');
  assert.equal(inlinePresentation('**bold `code`**').find(span => span.code).bold, true);
  assert.equal(inlinePresentation('[Source](<https://fixture.invalid/menu>)')[0].url, 'https://fixture.invalid/menu');
  assert.equal(inlinePresentation('my_value')[0].text, 'my_value');
  assert.equal(inlinePresentation('**unfinished')[0].text, '**unfinished');
  assert.equal(inlinePresentation('[bad](javascript:alert(1))').some(span => span.url), false);
  assert.equal(inlinePresentation('[bad](https://secret@fixture.invalid)').some(span => span.url), false);
  assert.equal(inlinePresentation('<script>unsafe()</script>')[0].text, '<script>unsafe()</script>');
});
