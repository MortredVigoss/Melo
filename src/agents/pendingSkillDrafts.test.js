/**
 * Tests for Phase 3C: pending-skill-draft registry + chat reply glue.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySkillDraftReply,
  createPendingSkillDraftStore,
  handleChatSkillDraftReply,
} from './pendingSkillDrafts.js';

function makeSkill(patch = {}) {
  return {
    id: 'demo-skill',
    name: 'Demo skill',
    systemPrompt: 'hi',
    type: 'executable',
    ...patch,
  };
}

// ─── classifySkillDraftReply ─────────────────────────────────────────────────

test('classifySkillDraftReply: confirms in English and Chinese', () => {
  for (const s of ['y', 'yes', 'yep', 'save', 'Confirm', 'OK', 'Do it', 'go ahead']) {
    assert.equal(classifySkillDraftReply(s).intent, 'confirm', `"${s}"`);
  }
  for (const s of ['好', '好的', '确认', '保存', '就这个', '存起来']) {
    assert.equal(classifySkillDraftReply(s).intent, 'confirm', `"${s}"`);
  }
});

test('classifySkillDraftReply: rejects in English and Chinese', () => {
  for (const s of ['n', 'no', 'Nope', 'cancel', 'Discard', 'never mind', 'forget it']) {
    assert.equal(classifySkillDraftReply(s).intent, 'reject', `"${s}"`);
  }
  for (const s of ['不', '不要', '算了', '取消', '作废']) {
    assert.equal(classifySkillDraftReply(s).intent, 'reject', `"${s}"`);
  }
});

test('classifySkillDraftReply: picks up edit intent with hint', () => {
  const en = classifySkillDraftReply('edit: make the systemPrompt shorter');
  assert.equal(en.intent, 'edit');
  assert.match(en.hint, /shorter/);

  const zh = classifySkillDraftReply('改成 每次输出最多 3 句');
  assert.equal(zh.intent, 'edit');
  assert.match(zh.hint, /3 句/);
});

test('classifySkillDraftReply: unknown when user is just chatting', () => {
  for (const s of ['', '   ', 'what can you do', '今天天气怎么样', 'tell me a joke']) {
    assert.equal(classifySkillDraftReply(s).intent, 'unknown', `"${s}"`);
  }
});

// ─── pending-draft store ─────────────────────────────────────────────────────

test('store: set + get + has + clear roundtrip', () => {
  const store = createPendingSkillDraftStore();
  assert.equal(store.has('c1'), false);
  store.set('c1', { agentId: 'a1', skill: makeSkill() });
  assert.equal(store.has('c1'), true);
  const got = store.get('c1');
  assert.equal(got.agentId, 'a1');
  assert.equal(got.skill.id, 'demo-skill');
  store.clear('c1');
  assert.equal(store.has('c1'), false);
});

test('store: TTL sweep evicts stale entries', () => {
  let now = 1_000_000;
  const store = createPendingSkillDraftStore({ ttlMs: 1000, nowFn: () => now });
  store.set('c1', { skill: makeSkill() });
  assert.equal(store.has('c1'), true);
  now += 999;
  assert.equal(store.has('c1'), true);
  now += 2;
  // Past TTL.
  assert.equal(store.has('c1'), false);
  assert.equal(store.get('c1'), null);
});

test('store: set without chatId throws', () => {
  const store = createPendingSkillDraftStore();
  assert.throws(() => store.set('', { skill: makeSkill() }));
  assert.throws(() => store.set(null, { skill: makeSkill() }));
});

// ─── handleChatSkillDraftReply ──────────────────────────────────────────────

test('handler: no pending draft → handled:false', async () => {
  const store = createPendingSkillDraftStore();
  const res = await handleChatSkillDraftReply({
    chatId: 'c1',
    text: 'yes',
    saveFn: async () => {},
    store,
  });
  assert.equal(res.handled, false);
});

test('handler: ordinary chat message with pending draft → handled:false (not consumed)', async () => {
  const store = createPendingSkillDraftStore();
  store.set('c1', { skill: makeSkill() });
  const res = await handleChatSkillDraftReply({
    chatId: 'c1',
    text: 'what is the weather today?',
    saveFn: async () => {},
    store,
  });
  assert.equal(res.handled, false);
  // And the pending draft is still there — unknown intent leaves it alone.
  assert.ok(store.has('c1'));
});

test('handler: confirm intent saves and clears', async () => {
  const store = createPendingSkillDraftStore();
  store.set('c1', { skill: makeSkill({ id: 'x' }) });
  const saveCalls = [];
  const res = await handleChatSkillDraftReply({
    chatId: 'c1',
    text: '保存',
    saveFn: async (s) => { saveCalls.push(s); },
    store,
  });
  assert.equal(res.handled, true);
  assert.equal(res.intent, 'confirm');
  assert.equal(res.saved, true);
  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].id, 'x');
  assert.equal(store.has('c1'), false);
  assert.match(res.reply, /Saved skill "x"/);
});

test('handler: reject intent clears without saving', async () => {
  const store = createPendingSkillDraftStore();
  store.set('c1', { skill: makeSkill({ id: 'x', name: 'Dropped' }) });
  const saveCalls = [];
  const res = await handleChatSkillDraftReply({
    chatId: 'c1',
    text: '不要',
    saveFn: async (s) => { saveCalls.push(s); },
    store,
  });
  assert.equal(res.handled, true);
  assert.equal(res.intent, 'reject');
  assert.equal(res.saved, undefined);
  assert.equal(saveCalls.length, 0);
  assert.equal(store.has('c1'), false);
  assert.match(res.reply, /Dropped/);
});

test('handler: edit intent clears and surfaces hint', async () => {
  const store = createPendingSkillDraftStore();
  store.set('c1', { skill: makeSkill() });
  const res = await handleChatSkillDraftReply({
    chatId: 'c1',
    text: 'edit add support for Chinese output',
    saveFn: async () => {},
    store,
  });
  assert.equal(res.handled, true);
  assert.equal(res.intent, 'edit');
  assert.match(res.editHint, /Chinese output/);
  assert.equal(store.has('c1'), false);
});

test('handler: save failure keeps pending draft so user can retry', async () => {
  const store = createPendingSkillDraftStore();
  store.set('c1', { skill: makeSkill({ id: 'dup' }) });
  const res = await handleChatSkillDraftReply({
    chatId: 'c1',
    text: 'confirm',
    saveFn: async () => { throw new Error('id already exists'); },
    store,
  });
  assert.equal(res.handled, true);
  assert.equal(res.intent, 'confirm');
  assert.match(res.error, /id already exists/);
  assert.ok(store.has('c1'), 'pending draft must remain so user can fix and retry');
});

test('handler: cross-agent guard prevents unrelated agent from consuming the draft', async () => {
  const store = createPendingSkillDraftStore();
  store.set('c1', { agentId: 'agent-A', skill: makeSkill() });
  const res = await handleChatSkillDraftReply({
    chatId: 'c1',
    text: 'yes',
    agentId: 'agent-B',
    saveFn: async () => { throw new Error('should not be called'); },
    store,
  });
  assert.equal(res.handled, false);
  assert.ok(store.has('c1'));
});

test('handler: missing saveFn on confirm is reported but does not crash', async () => {
  const store = createPendingSkillDraftStore();
  store.set('c1', { skill: makeSkill() });
  const res = await handleChatSkillDraftReply({
    chatId: 'c1',
    text: 'yes',
    saveFn: null,
    store,
  });
  assert.equal(res.handled, true);
  assert.equal(res.error, 'MISSING_SAVE_FN');
});
