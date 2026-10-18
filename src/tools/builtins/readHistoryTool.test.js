// read_history (design 1D-3): verbatim read-back of a message range with the
// same audience / project isolation as search_history (P0-3).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-read-history-'));
for (const dir of ['desktop', 'desktop/agents', 'desktop/threads']) mkdirSync(join(TEST_HOME, dir), { recursive: true });

const messages = prefix => Array.from({ length: 8 }, (_, i) => ({
  id: `${prefix}-${i}`, role: i % 2 ? 'assistant' : 'user', content: `${prefix} message ${i} 端口 ${8000 + i}`, createdAt: `2026-10-0${i + 1}T10:00:00.000Z`,
  ...(i === 3 ? { toolResults: [{ toolCallId: 'c', toolName: 'file_read', ok: true, path: '/srv/app.cfg', summary: 'port=8443' }] } : {}),
}));
const chat = (id, extra) => ({ id, title: id, mode: 'chat', agentId: 'main', chatType: 'private', sessionMemory: [], messages: messages(id), ...extra });
writeFileSync(join(TEST_HOME, 'desktop', 'state.json'), JSON.stringify({
  projects: [{ id: 'p1', name: 'P1', instructions: '', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'p2', name: 'P2', instructions: '', createdAt: '2026-01-01T00:00:00.000Z' }],
  chats: [chat('own', { projectId: 'p1', source: 'desktop' }), chat('same', { projectId: 'p1', source: 'desktop' }), chat('other', { projectId: 'p2', source: 'desktop' }), chat('tg', { projectId: 'p1', source: 'telegram' })],
  tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], externalToolRuns: [],
  agentProfiles: { main: { id: 'main', name: 'main', model: 'gpt-4o', identity: '', soulMd: '', tools: [], skills: [], channels: {} } },
  projectAgentOverrides: {},
  settings: { selectedProjectId: null, selectedChatId: null, selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat', promptHistory: [], enabledConnectorIds: [], enabledSkillIds: [], customSkills: [] },
}));
process.env.MELO_HOME = TEST_HOME;
const { readHistoryTool, sliceHistory } = await import('./readHistoryTool.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = ORIGINAL_MELO_HOME;
});

const desktop = { meloHome: TEST_HOME, chatId: 'own', projectId: 'p1', chatSource: 'desktop' };

test('reads a verbatim range of the current chat with ids, tool facts and continuation', async () => {
  const result = await readHistoryTool.run({ fromMessageId: 'own-2', toMessageId: 'own-4' }, desktop);
  assert.equal(result.ok, true);
  assert.match(result.output, /\[#own-2\] User \(2026-10-03 10:00\):\nown message 2 端口 8002/);
  assert.match(result.output, /\[#own-3\] Assistant/);
  assert.match(result.output, /\[Tools used\] file_read \(ok\): \/srv\/app.cfg — port=8443/);
  assert.doesNotMatch(result.output, /own-5/);
  assert.equal(result.meta.count, 3);
  assert.equal(result.meta.nextMessageId, null);
  const limited = await readHistoryTool.run({ fromMessageId: 'own-0', limit: 2 }, desktop);
  assert.equal(limited.meta.count, 2);
  assert.equal(limited.meta.nextMessageId, 'own-2');
  assert.match(limited.output, /continue with fromMessageId="own-2"/);
  const around = await readHistoryTool.run({ aroundMessageId: 'own-5', before: 1, after: 1 }, desktop);
  assert.deepEqual(around.output.match(/\[#own-\d\]/g), ['[#own-4]', '[#own-5]', '[#own-6]']);
});

test('unknown ids and ranges fail closed with canonical codes', async () => {
  assert.equal((await readHistoryTool.run({ fromMessageId: 'nope' }, desktop)).error, 'NOT_FOUND');
  assert.equal((await readHistoryTool.run({ chatId: 'missing' }, desktop)).error, 'NOT_FOUND');
  assert.deepEqual(sliceHistory([], { fromMessageId: 'x' }).messages, []);
});

test('desktop owner stays inside the project unless scope=all; channels only read their own chat', async () => {
  assert.equal((await readHistoryTool.run({ chatId: 'same', limit: 1 }, desktop)).ok, true);
  const foreign = await readHistoryTool.run({ chatId: 'other', limit: 1 }, desktop);
  assert.equal(foreign.error, 'PERMISSION_DENIED');
  assert.equal((await readHistoryTool.run({ chatId: 'other', limit: 1, scope: 'all' }, desktop)).ok, true);
  const telegram = { meloHome: TEST_HOME, chatId: 'tg', projectId: 'p1', chatSource: 'telegram' };
  assert.equal((await readHistoryTool.run({ limit: 1 }, telegram)).ok, true);
  assert.equal((await readHistoryTool.run({ chatId: 'own', limit: 1 }, telegram)).error, 'PERMISSION_DENIED');
  assert.equal((await readHistoryTool.run({ chatId: 'own', limit: 1, scope: 'all' }, telegram)).error, 'PERMISSION_DENIED');
});
