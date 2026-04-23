/**
 * Tests for the /save-as-skill slash command handler (Phase 3A).
 *
 * We exercise the DI seams (draftFn / saveFn / io / readLine) so the tests
 * can drive the full draft-then-confirm loop without network or disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSaveAsSkillCommand } from './index.js';

function makeIO() {
  const chunks = [];
  return {
    write: (s) => { chunks.push(s); return true; },
    get text() { return chunks.join(''); },
    chunks,
  };
}

function draftOk(skillPatch = {}) {
  return async () => ({
    ok: true,
    skill: {
      id: 'draft-1',
      name: 'Drafted skill',
      description: 'does the thing',
      systemPrompt: 'You are the drafted skill.',
      type: 'executable',
      maxIterations: 6,
      parametersSchema: {
        type: 'object',
        properties: { task: { type: 'string', description: 'task' } },
        required: ['task'],
      },
      ...skillPatch,
    },
  });
}

test('handleSaveAsSkillCommand: NO_CONVERSATION when messages are empty', async () => {
  const io = makeIO();
  const res = await handleSaveAsSkillCommand({
    messages: [],
    config: { apiKey: 'k' },
    io,
    draftFn: async () => { throw new Error('should not draft'); },
    saveFn: async () => { throw new Error('should not save'); },
    readLine: async () => 'y',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NO_CONVERSATION');
  assert.match(io.text, /have a chat first/);
});

test('handleSaveAsSkillCommand: MISSING_CONFIG when config is absent', async () => {
  const io = makeIO();
  const res = await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: null,
    io,
    draftFn: async () => { throw new Error('should not draft'); },
    saveFn: async () => { throw new Error('should not save'); },
    readLine: async () => 'y',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'MISSING_CONFIG');
});

test('handleSaveAsSkillCommand: surfaces draftFn failure reason', async () => {
  const io = makeIO();
  const draftFn = async () => ({ ok: false, error: 'MODEL_ERROR', reason: 'timeout' });
  const res = await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: { apiKey: 'k' },
    io,
    draftFn,
    saveFn: async () => { throw new Error('should not save'); },
    readLine: async () => 'y',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'MODEL_ERROR');
  assert.match(io.text, /Draft failed: MODEL_ERROR.*timeout/);
});

test('handleSaveAsSkillCommand: prints draft, confirms, and calls saveFn on "yes"', async () => {
  const io = makeIO();
  const saveCalls = [];
  const saveFn = async (s) => { saveCalls.push(s); return { ok: true }; };
  const res = await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: { apiKey: 'k' },
    io,
    draftFn: draftOk(),
    saveFn,
    readLine: async () => 'yes',
  });
  assert.equal(res.ok, true);
  assert.equal(res.saved, true);
  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].id, 'draft-1');
  assert.match(io.text, /Drafted skill/);
  assert.match(io.text, /Saved skill "draft-1"/);
});

test('handleSaveAsSkillCommand: does NOT save when user declines', async () => {
  const io = makeIO();
  const saveCalls = [];
  const res = await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: { apiKey: 'k' },
    io,
    draftFn: draftOk(),
    saveFn: async (s) => { saveCalls.push(s); return {}; },
    readLine: async () => 'n',
  });
  assert.equal(res.ok, true);
  assert.equal(res.saved, false);
  assert.equal(saveCalls.length, 0);
  assert.match(io.text, /Discarded/);
});

test('handleSaveAsSkillCommand: treats empty answer as "no"', async () => {
  const io = makeIO();
  const saveCalls = [];
  const res = await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: { apiKey: 'k' },
    io,
    draftFn: draftOk(),
    saveFn: async (s) => { saveCalls.push(s); return {}; },
    readLine: async () => '',
  });
  assert.equal(res.saved, false);
  assert.equal(saveCalls.length, 0);
});

test('handleSaveAsSkillCommand: surfaces save failure cleanly', async () => {
  const io = makeIO();
  const res = await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: { apiKey: 'k' },
    io,
    draftFn: draftOk({ id: 'dup' }),
    saveFn: async () => { throw new Error('duplicate id "dup"'); },
    readLine: async () => 'y',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'SAVE_FAILED');
  assert.match(io.text, /Save failed: duplicate id "dup"/);
});

test('handleSaveAsSkillCommand: non-interactive (no readLine) returns pending draft', async () => {
  const io = makeIO();
  const saveCalls = [];
  const res = await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: { apiKey: 'k' },
    io,
    draftFn: draftOk({ id: 'pending-x' }),
    saveFn: async (s) => { saveCalls.push(s); return {}; },
    // no readLine → caller (e.g. Telegram bot) handles confirmation
  });
  assert.equal(res.ok, true);
  assert.equal(res.pending, true);
  assert.equal(res.skill.id, 'pending-x');
  assert.equal(saveCalls.length, 0);
});

test('handleSaveAsSkillCommand: warns when draft is _suspicious', async () => {
  const io = makeIO();
  const res = await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: { apiKey: 'k' },
    io,
    draftFn: draftOk({ _suspicious: true }),
    saveFn: async () => ({}),
    readLine: async () => 'n',
  });
  assert.equal(res.ok, true);
  assert.match(io.text, /_suspicious flag set/);
});

test('handleSaveAsSkillCommand: passes hint through to draftFn', async () => {
  const io = makeIO();
  let seenArgs = null;
  const draftFn = async (args) => {
    seenArgs = args;
    return draftOk()();
  };
  await handleSaveAsSkillCommand({
    messages: [{ role: 'user', content: 'hi' }],
    config: { apiKey: 'k' },
    hint: 'make it about weather',
    io,
    draftFn,
    saveFn: async () => ({}),
    readLine: async () => 'n',
  });
  assert.ok(seenArgs);
  assert.equal(seenArgs.hint, 'make it about weather');
  // Our messages are forwarded verbatim.
  assert.equal(seenArgs.messages[0].content, 'hi');
});
