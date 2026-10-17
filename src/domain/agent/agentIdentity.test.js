import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAgentIdentity } from './agentIdentity.js';
import { summarizeAgentPrompt } from '../../services/chat/systemPrompt.js';

const profile = {
  id: 'custom-1', name: '金冬天', description: 'Winter-inspired private chat agent',
  instructions: '## 工作要求\n软软地说话。\n\n## 身份\n金冬天。',
  capabilities: { readFiles: true, network: false, knowledgeMemory: true },
  channels: {},
};

test('chat, member and voice variants render the same persona document', () => {
  const chat = renderAgentIdentity(profile, { variant: 'chat' });
  const member = renderAgentIdentity(profile, { variant: 'member' });
  const voice = renderAgentIdentity(profile, { variant: 'voice' });
  assert.equal(chat, member);
  assert.match(chat, /^User-selected role: 金冬天\nRole purpose: Winter-inspired private chat agent/);
  assert.match(chat, /Apply this role on every turn/);
  assert.ok(chat.endsWith(profile.instructions));
  assert.equal(voice, profile.instructions, 'voice carries the document without chat framing');
});

test('legacy profiles without merged instructions use the canonical section order', () => {
  const legacy = { name: 'L', rolePrompt: 'Role first', identity: 'Identity second', soulMd: 'Soul third', systemPrompt: 'System last' };
  const text = renderAgentIdentity(legacy, { variant: 'voice' });
  assert.ok(text.indexOf('Role first') < text.indexOf('IDENTITY.md:\nIdentity second'));
  assert.ok(text.indexOf('IDENTITY.md') < text.indexOf('SOUL.md:\nSoul third'));
  assert.ok(text.indexOf('SOUL.md') < text.indexOf('Agent system prompt:\nSystem last'));
  assert.equal(renderAgentIdentity({ name: 'Empty' }, { variant: 'voice' }), 'You are Empty.');
  assert.equal(renderAgentIdentity(null), '');
});

test('the chat system prompt names capabilities, never the legacy tools list', () => {
  const text = summarizeAgentPrompt({ ...profile, tools: ['localCommand', 'localFiles', 'search'] });
  assert.match(text, /Enabled capabilities: read files, use knowledge and memory\./);
  assert.doesNotMatch(text, /Enabled agent tools|Local command/);
  const none = summarizeAgentPrompt({ ...profile, capabilities: {} });
  assert.match(none, /Enabled capabilities: none/);
  const legacyAll = summarizeAgentPrompt({ ...profile, capabilities: null });
  assert.doesNotMatch(legacyAll, /Enabled capabilities/, 'unmigrated agents make no capability claim');
});
