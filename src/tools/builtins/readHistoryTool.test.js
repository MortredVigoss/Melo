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
// Bug audit T3: one message far larger than the 8k-token budget, followed by a normal one.
const HUGE_BODY = Array.from({ length: 1200 }, (_, i) => `line ${String(i).padStart(4, '0')} 这是一段很长的会议记录文本，用来测试单条消息超出预算时的续读。`).join('\n');
const huge = { ...chat('huge', { projectId: 'p1', source: 'desktop' }), messages: [
  { id: 'huge-0', role: 'user', content: HUGE_BODY, createdAt: '2026-10-01T10:00:00.000Z' },
  { id: 'huge-1', role: 'assistant', content: 'short reply', createdAt: '2026-10-02T10:00:00.000Z' },
] };
writeFileSync(join(TEST_HOME, 'desktop', 'state.json'), JSON.stringify({
  projects: [{ id: 'p1', name: 'P1', instructions: '', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'p2', name: 'P2', instructions: '', createdAt: '2026-01-01T00:00:00.000Z' }],
  chats: [chat('own', { projectId: 'p1', source: 'desktop' }), chat('same', { projectId: 'p1', source: 'desktop' }), chat('other', { projectId: 'p2', source: 'desktop' }), chat('tg', { projectId: 'p1', source: 'telegram' }), huge],
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

test('T3: a single message over the budget is cut with continueFromChar and the continuation loop terminates covering the whole text', async () => {
  const first = await readHistoryTool.run({ chatId: 'huge', fromMessageId: 'huge-0' }, desktop);
  assert.equal(first.ok, true);
  assert.equal(first.meta.count, 1);
  assert.equal(first.meta.truncated, true);
  assert.equal(first.meta.nextMessageId, 'huge-0', 'the same message continues…');
  assert.ok(first.meta.continueFromChar > 0, '…from a character offset, never from the start again');
  assert.match(first.output, /fromChar=\d+/);
  assert.match(first.output, /\[message cut here/);
  // Follow the continuation exactly as the model would; it must end and cover the body in order.
  let next = { id: first.meta.nextMessageId, fromChar: first.meta.continueFromChar }, pieces = [first.output], rounds = 1;
  const seen = new Set([`${next.id}:${next.fromChar}`]);
  while (next.id) {
    const page = await readHistoryTool.run({ chatId: 'huge', fromMessageId: next.id, fromChar: next.fromChar }, desktop);
    assert.equal(page.ok, true, page.output);
    rounds++;
    assert.ok(rounds < 50, 'continuation must terminate');
    pieces.push(page.output);
    next = { id: page.meta.nextMessageId, fromChar: page.meta.continueFromChar || 0 };
    const key = `${next.id}:${next.fromChar}`;
    assert.equal(seen.has(key), false, `continuation must make progress (repeated ${key})`);
    seen.add(key);
  }
  const joined = pieces.join('\n');
  assert.match(joined, /line 0000 /);
  assert.match(joined, /line 1199 /);
  assert.match(joined, /\[#huge-1\] Assistant/);
  assert.ok(rounds >= 3, `expected several pages, got ${rounds}`);
  // Offsets beyond the body fall back to an empty continuation rather than an error.
  const tail = await readHistoryTool.run({ chatId: 'huge', fromMessageId: 'huge-0', fromChar: 10 ** 9 }, desktop);
  assert.equal(tail.ok, true);
  assert.match(tail.output, /continued from character/);
  assert.equal(readHistoryTool.parametersSchema.properties.fromChar.type, 'number');
});
