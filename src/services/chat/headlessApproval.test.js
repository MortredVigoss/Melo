// Audit 2026-10-22 (re-fix of 2026-10-17 B-3): every chat turn wraps its
// emitter to record execution, so a Telegram / Discord / background turn
// reached the approval gate with a function and waited the full 120 s for a
// prompt nobody could answer, holding the polling loop. The turn now marks
// itself as having no approval surface; the live desktop stream still prompts.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_HOME = process.env.MELO_HOME, ORIGINAL_MOCK = process.env.MELO_MOCK_RESPONSE;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-headless-approval-'));
process.env.MELO_HOME = TEST_HOME;
process.env.MELO_TEST_MODE = '1';
mkdirSync(join(TEST_HOME, 'desktop'), { recursive: true });
const full = { version: 1, readFiles: true, writeFiles: true, runCommands: true, network: true, knowledgeMemory: true, generateMedia: true, delegate: false, mcpServers: [], skills: [], connectors: [] };
const chat = id => ({ id, title: id, mode: 'chat', projectId: null, agentId: 'main', messages: [], sessionMemory: [] });
writeFileSync(join(TEST_HOME, 'desktop', 'state.json'), JSON.stringify({
  projects: [], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], externalToolRuns: [],
  chats: [chat('remote-chat'), chat('desktop-chat')],
  agentProfiles: { main: { id: 'main', name: 'main', model: 'gpt-4', identity: '', soulMd: '', tools: ['local-files'], skills: [], channels: {}, capabilities: full } },
  projectAgentOverrides: {},
  settings: { selectedProjectId: null, selectedChatId: 'remote-chat', selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat', promptHistory: [], enabledConnectorIds: [], enabledSkillIds: [], customSkills: [] },
}));

const { sendChatMessage } = await import('./sendChatMessage.js');
const { readToolInvocationRecords } = await import('../../tools/toolInvocationRecord.js');
const { resolvePermission } = await import('../../tools/permissions.js');
const { resolveFileSafety } = await import('../../safety/fileSafetyGate.js');
const { bootstrapBuiltinTools } = await import('../../tools/registry.js');
bootstrapBuiltinTools();

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_HOME === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = ORIGINAL_HOME;
  if (ORIGINAL_MOCK === undefined) delete process.env.MELO_MOCK_RESPONSE; else process.env.MELO_MOCK_RESPONSE = ORIGINAL_MOCK;
});

const writeCall = name => `<tool_call>{"id":"w-1","name":"file_write","arguments":{"path":"${name}","content":"proof"}}</tool_call>`;

test('a background (Telegram-style) turn refuses an approval-gated tool at once and never runs it', { timeout: 60_000 }, async () => {
  process.env.MELO_MOCK_RESPONSE = writeCall('remote-proof.txt');
  const started = Date.now();
  const result = await sendChatMessage({ chatId: 'remote-chat', content: '写个文件', requestId: 'remote-1', background: true, skipBootstrap: true });
  assert.ok(Date.now() - started < 30_000, `answered without waiting for the 120 s approval timeout (${Date.now() - started} ms)`);
  const records = await readToolInvocationRecords(result.runId, { home: TEST_HOME });
  const writes = records.filter(r => r.toolId === 'file_write');
  assert.ok(writes.length >= 1, 'the model did ask to write');
  assert.ok(writes.every(r => r.resultEnvelope?.code === 'PERMISSION_NO_SURFACE'), JSON.stringify(writes.map(r => r.resultEnvelope)));
  assert.equal(existsSync(join(TEST_HOME, 'workspaces', 'chats', 'remote-chat', 'remote-proof.txt')), false, 'nothing was written');
});

test('the live desktop stream still gets the prompt and the approved write happens', { timeout: 60_000 }, async () => {
  process.env.MELO_MOCK_RESPONSE = writeCall('desktop-proof.txt');
  let prompts = 0;
  const sseEmitter = (event, payload) => {
    if (event !== 'tool_permission') return;
    prompts += 1;
    resolveFileSafety(payload.requestId, 'once');
    resolvePermission(payload.requestId, true);
  };
  await sendChatMessage({ chatId: 'desktop-chat', content: '写个文件', requestId: 'desktop-1', skipBootstrap: true, sseEmitter });
  assert.ok(prompts >= 1, 'the desktop was asked');
  assert.equal(existsSync(join(TEST_HOME, 'workspaces', 'chats', 'desktop-chat', 'desktop-proof.txt')), true, 'the approved write happened');
});
