/**
 * Tests for draftSkillFromChat (Phase 5C — UI entry point for
 * "Save chat as skill").
 *
 * The helper is a thin orchestration layer around draftSkillFromConversation.
 * These tests exercise:
 *   - NO_CONVERSATION when chatId is falsy
 *   - NO_CONVERSATION when the chat id doesn't exist in state
 *   - Happy path wires chat.messages + resolved config straight through to
 *     the drafting function
 *   - Hint is forwarded to the drafter
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { draftSkillFromChat } from './desktopStore.js';

function makeState(chats = []) {
  return {
    chats,
    settings: {},
    agentProfiles: [],
  };
}

function stubConfig() {
  return { authMode: 'api-key', apiKey: 'sk-test', baseUrl: 'https://x', model: 'm' };
}

test('draftSkillFromChat: NO_CONVERSATION when chatId is empty', async () => {
  const res = await draftSkillFromChat('', {
    _configFn: async () => stubConfig(),
    _loadStateFn: async () => makeState([]),
    _draftFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NO_CONVERSATION');
});

test('draftSkillFromChat: NO_CONVERSATION when chat is missing', async () => {
  const res = await draftSkillFromChat('missing-chat', {
    _configFn: async () => stubConfig(),
    _loadStateFn: async () => makeState([{ id: 'c1', messages: [] }]),
    _draftFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'NO_CONVERSATION');
  assert.match(res.reason, /missing-chat/);
});

test('draftSkillFromChat: happy path forwards messages + config + hint', async () => {
  const seenArgs = [];
  const res = await draftSkillFromChat('c1', {
    hint: 'focus on weather lookups',
    _configFn: async () => stubConfig(),
    _loadStateFn: async () => makeState([
      {
        id: 'c1',
        messages: [
          { role: 'user', content: 'what is weather in Seoul' },
          { role: 'assistant', content: 'rainy' },
        ],
      },
    ]),
    _draftFn: async (args) => {
      seenArgs.push(args);
      return { ok: true, skill: { id: 'weather-lookup', name: 'Weather lookup' } };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.skill.id, 'weather-lookup');
  assert.equal(seenArgs.length, 1);
  assert.equal(seenArgs[0].hint, 'focus on weather lookups');
  assert.equal(seenArgs[0].messages.length, 2);
  assert.equal(seenArgs[0].config.apiKey, 'sk-test');
});

test('draftSkillFromChat: propagates drafter error envelope', async () => {
  const res = await draftSkillFromChat('c1', {
    _configFn: async () => stubConfig(),
    _loadStateFn: async () => makeState([{ id: 'c1', messages: [{ role: 'user', content: 'hi' }] }]),
    _draftFn: async () => ({ ok: false, error: 'MODEL_ERROR', reason: 'model down' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'MODEL_ERROR');
  assert.equal(res.reason, 'model down');
});

test('draftSkillFromChat: tolerates chat with non-array messages', async () => {
  const seenArgs = [];
  const res = await draftSkillFromChat('c1', {
    _configFn: async () => stubConfig(),
    _loadStateFn: async () => makeState([{ id: 'c1', messages: null }]),
    _draftFn: async (args) => {
      seenArgs.push(args);
      return { ok: false, error: 'NO_CONVERSATION', reason: 'empty' };
    },
  });
  assert.equal(res.ok, false);
  assert.equal(seenArgs[0].messages.length, 0);
});
