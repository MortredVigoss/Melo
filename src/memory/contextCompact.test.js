import test from 'node:test';
import assert from 'node:assert/strict';
import { planIncrementalCompact, compactConversation } from './contextCompact.js';

const history = () => Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `Message ${i}: ${'x'.repeat(800)}` }));

test('incremental compact retains recent full turns and does not recompact old history', () => {
  const chat = { messages: history() };
  const plan = planIncrementalCompact(chat, { triggerTokens: 3000 });
  assert.ok(plan);
  assert.equal(plan.boundaryId, 'm13');
  assert.equal(plan.messages.at(-1).role, 'assistant');
  chat.compactSummary = 'Previous facts';
  chat.compactBoundaryMessageId = plan.boundaryId;
  chat.messages.push({ id: 'next', role: 'user', content: 'continue' });
  assert.equal(planIncrementalCompact(chat, { triggerTokens: 3000 }), null);
});

test('compact chunk bounds never advance over unsummarized messages', () => {
  const chat = { messages: history() };
  const plan = planIncrementalCompact(chat, { triggerTokens: 1000, maxChunkTokens: 1500 });
  assert.ok(plan.messages.length < 14);
  assert.equal(plan.compactedCount, plan.messages.length);
  assert.equal(chat.messages[plan.compactedCount].role, 'user');
  assert.equal(planIncrementalCompact({ ...chat, compactFailures: 3 }, { triggerTokens: 1000 }), null);
});

test('summary request includes previous summary, media transcript and speaker identity', async () => {
  let request;
  const summary = await compactConversation([{ id: 'm1', role: 'user', senderId: 'alice', content: 'audio', extractedMedia: [{ kind: 'transcript', text: 'My commute is 40 minutes.' }] }], {
    config: {}, previousSummary: 'Works in Doncaster.',
    _createReply: async options => { request = options; return 'Merged summary'; },
  });
  assert.equal(summary, 'Merged summary');
  assert.match(request.messages[0].content, /Works in Doncaster/);
  assert.match(request.messages[0].content, /My commute is 40 minutes/);
  assert.match(request.messages[0].content, /speaker:alice/);
  assert.equal(request.nativeWebSearchEnabled, false);
});

test('offline fallback receives prior memory and media; does not lose them at the boundary', async () => {
  const summary = await compactConversation([{ role: 'user', content: '', extractedMedia: [{ kind: 'transcript', text: 'My alarm is at 8:20.' }] }], {
    config: {}, previousSummary: 'Works in Doncaster.',
    _createReply: async () => { throw new Error('offline'); },
    _compactOffline: async messages => {
      const text = messages.map(message => message.content).join('\n');
      assert.match(text, /Works in Doncaster/);
      assert.match(text, /My alarm is at 8:20/);
      return 'Merged offline facts';
    },
  });
  assert.equal(summary, 'Merged offline facts');
});

test('an oversized first turn still makes bounded, explicitly partial compact progress',()=>{
 const chat={messages:history()};chat.messages[0].content='long source '.repeat(20000);const original=chat.messages[0].content;
 const plan=planIncrementalCompact(chat,{triggerTokens:100,maxChunkTokens:1000});
 assert.ok(plan);assert.ok(plan.truncated);assert.equal(plan.boundaryId,'m1');assert.ok(plan.messages[0].content.length<6000);assert.equal(chat.messages[0].content,original);
 chat.compactSummary='partial';chat.compactBoundaryMessageId=plan.boundaryId;
 assert.notEqual(planIncrementalCompact(chat,{triggerTokens:100,maxChunkTokens:1000}).boundaryId,plan.boundaryId);
});

test('compaction reports its provenance and labels an extractive fallback as degraded', async () => {
  const { compactConversationDetailed, formatCompactContextBlock } = await import('./contextCompact.js');
  const messages = [{ id: 'm1', role: 'user', content: 'Please remember the deploy is on Friday.' }, { id: 'm2', role: 'assistant', content: 'Noted.' }];
  const cloud = await compactConversationDetailed(messages, { config: {}, _createReply: async () => 'Deploy on Friday.' });
  assert.deepEqual(cloud, { summary: 'Deploy on Friday.', source: 'cloud' });
  const local = await compactConversationDetailed(messages, { config: {},
    _createReply: async () => { throw new Error('offline'); },
    _compactOffline: async () => ({ summary: 'Local LLM summary', source: 'local' }) });
  assert.equal(local.source, 'local');
  const rule = await compactConversationDetailed(messages, { config: {},
    _createReply: async () => { throw new Error('offline'); },
    _compactOffline: async () => ({ summary: 'Extractive sentences', source: 'rule' }) });
  assert.equal(rule.source, 'rule');
  // Legacy string-returning fallbacks are treated as extractive.
  const legacy = await compactConversationDetailed(messages, { config: {},
    _createReply: async () => { throw new Error('offline'); },
    _compactOffline: async () => 'Plain string' });
  assert.deepEqual(legacy, { summary: 'Plain string', source: 'rule' });
  // The string API is unchanged for existing callers.
  assert.equal(await compactConversation(messages, { config: {}, _createReply: async () => 'Deploy on Friday.' }), 'Deploy on Friday.');
  // The prompt block says so when the summary is degraded.
  assert.match(formatCompactContextBlock('x', 12, { source: 'rule' }), /extractive fallback[\s\S]*may omit decisions/);
  assert.doesNotMatch(formatCompactContextBlock('x', 12, { source: 'cloud' }), /extractive/);
  assert.doesNotMatch(formatCompactContextBlock('x', 12), /extractive/);
});
