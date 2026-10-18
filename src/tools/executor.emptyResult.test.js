// Bug audit 2026-10-18 T1: the executor's result normalisation dropped the
// B1 envelope fields a tool sets itself (`status:'empty'`, `code:'NO_RESULTS'`),
// so an empty grep / read_history reached the runner as a plain `ok` with no
// NO_RESULTS hint. These tests run the real tools through `executeTool`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../testSupport/directAgentFixture.js';
import { grepTool } from './builtins/grepTool.js';
import { readHistoryTool } from './builtins/readHistoryTool.js';
import { buildToolInvocationRecord } from './toolInvocationRecord.js';
import { toolCodeHint } from './toolResult.js';

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-exec-empty-home-'));
  const ws = await realpath(await mkdtemp(join(tmpdir(), 'melo-exec-empty-ws-')));
  const prev = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try { await fn({ home, ws }); }
  finally {
    if (prev === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = prev;
    await rm(home, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
}

test('executeTool keeps status=empty / code=NO_RESULTS from a real empty grep and the record carries the hint', async () => {
  await withHome(async ({ ws }) => {
    await mkdir(join(ws, 'src'), { recursive: true });
    await writeFile(join(ws, 'src', 'a.js'), 'fn main() {}\n', 'utf8');
    const result = await executeTool(grepTool, { pattern: 'NOTHING_MATCHES_THIS_TOKEN' }, { workspacePath: ws, chatId: 'chat-empty' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'empty');
    assert.equal(result.code, 'NO_RESULTS');
    assert.equal(result.error, undefined);
    assert.match(result.output, /No matches found/);
    assert.match(toolCodeHint(result.code), /found nothing/);
    const record = buildToolInvocationRecord({ runId: 'run', iteration: 0, call: { id: 'c1', name: 'grep', arguments: { pattern: 'x' } }, result, modelFacingOutput: '' });
    assert.equal(record.resultEnvelope.status, 'empty');
    assert.equal(record.resultEnvelope.code, 'NO_RESULTS');
    assert.match(record.resultEnvelope.hint, /broaden or change the query/);
  });
});

test('executeTool keeps status=empty for read_history on an empty range (fixture state)', async () => {
  await withHome(async ({ home }) => {
    await mkdir(join(home, 'desktop'), { recursive: true });
    const chat = { id: 'own', title: 'own', mode: 'chat', agentId: 'main', chatType: 'private', projectId: null, source: 'desktop', sessionMemory: [],
      messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: '2026-10-01T10:00:00.000Z' }] };
    // A chat with no user/assistant rows at all: every range inside it is empty.
    const blank = { ...chat, id: 'blank', title: 'blank', messages: [{ id: 's1', role: 'system', content: 'setup', createdAt: '2026-10-01T10:00:00.000Z' }] };
    await writeFile(join(home, 'desktop', 'state.json'), JSON.stringify({
      projects: [], chats: [chat, blank], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], externalToolRuns: [],
      agentProfiles: { main: { id: 'main', name: 'main', model: 'gpt-4o', identity: '', soulMd: '', tools: [], skills: [], channels: {} } },
      projectAgentOverrides: {},
      settings: { selectedProjectId: null, selectedChatId: null, selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat', promptHistory: [], enabledConnectorIds: [], enabledSkillIds: [], customSkills: [] },
    }));
    const filled = await executeTool(readHistoryTool, { fromMessageId: 'm1' }, { chatId: 'own', chatSource: 'desktop', meloHome: home });
    assert.equal(filled.ok, true, filled.output);
    assert.equal(filled.status, 'ok');
    assert.equal(filled.code, undefined);
    const empty = await executeTool(readHistoryTool, { chatId: 'blank' }, { chatId: 'own', chatSource: 'desktop', meloHome: home });
    assert.equal(empty.ok, true, empty.output);
    assert.equal(empty.status, 'empty', 'the executor must not downgrade an empty read to a plain ok');
    assert.equal(empty.code, 'NO_RESULTS');
    assert.match(empty.output, /No messages in that range/);
    assert.ok(toolCodeHint(empty.code));
  });
});
