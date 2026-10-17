// agentMemoryContext.slots.test.js — design 2026-10-17 §3.4 "Agent 级记忆定位".
//
// The old single `corrections` group (6 seats, all namespaces) is split into
//   • agentNotes  — rows of `agent:<activeAgent>` only (self-corrections,
//                   user-flagged requirements for this agent, tasks it owns),
//                   limit 4;
//   • sharedFacts — the rest of what the group held (chat / project /
//                   personal session facts and corrections), limit 4.
// Both render as labelled sub-blocks inside the same "Relevant saved facts"
// block, rows still flow into onRecall (memoryRendered), and another agent's
// namespace never reaches the agent sub-block.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../memory/store.js';
import {
  buildAgentMemoryNodeContext, AGENT_NOTES_LIMIT, SHARED_FACTS_LIMIT, AGENT_NOTES_HEADING, SHARED_FACTS_HEADING,
} from './agentMemoryContext.js';

const CHAT = 'c1', P = 'P', AGENT = 'main', OTHER = 'other';
const at = minutesAgo => new Date(Date.now() - minutesAgo * 60_000).toISOString();

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-agent-slots-'));
  const prev = { home: process.env.MELO_HOME, attic: process.env.MELO_ATTIC_ENABLED, tiers: process.env.MELO_MEMORY_TIERS_RECALL };
  process.env.MELO_HOME = home;
  // The Hot Attic would claim the correction rows first (they are "hot" by
  // category); switch it off so only the split group is observed.
  process.env.MELO_ATTIC_ENABLED = '0';
  process.env.MELO_MEMORY_TIERS_RECALL = '0';
  store._resetStoreForTests();
  try { await fn(); } finally {
    store._resetStoreForTests();
    for (const [key, value] of [['MELO_HOME', prev.home], ['MELO_ATTIC_ENABLED', prev.attic], ['MELO_MEMORY_TIERS_RECALL', prev.tiers]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

function seed() {
  const rows = [];
  // Six agent:main rows — more than the 4 seats. Newest first by updatedAt.
  rows.push({ id: 'verification:agent:main:a1', namespace: `agent:${AGENT}`, kind: 'verification-correction', updatedAt: at(1),
    text: 'AGENT_NOTE_1 beta: Self-correction: port is 8080', metadata: { scope: 'agent', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'correction' } });
  rows.push({ id: 'promoted:a2', namespace: `agent:${AGENT}`, kind: 'session-fact', updatedAt: at(2),
    text: 'AGENT_NOTE_2 beta: always answer this agent in 中文', metadata: { scope: 'agent', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'user_preference' } });
  rows.push({ id: `task:agent:${AGENT}:t1`, namespace: `agent:${AGENT}`, kind: 'task', updatedAt: at(3),
    text: 'AGENT_NOTE_3 beta deploy\nopen', metadata: { title: 'AGENT_NOTE_3 beta deploy', status: 'open', owner: AGENT, chatId: CHAT, projectId: P } });
  rows.push({ id: 'promoted:a4', namespace: `agent:${AGENT}`, kind: 'session-fact', updatedAt: at(4),
    text: 'AGENT_NOTE_4 beta: keep answers under 200 words', metadata: { scope: 'agent', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'user_preference' } });
  rows.push({ id: 'promoted:a5', namespace: `agent:${AGENT}`, kind: 'session-fact', updatedAt: at(5),
    text: 'AGENT_NOTE_5 beta: never use emoji', metadata: { scope: 'agent', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'user_preference' } });
  rows.push({ id: 'promoted:a6', namespace: `agent:${AGENT}`, kind: 'session-fact', updatedAt: at(6),
    text: 'AGENT_NOTE_6 beta: cite file paths', metadata: { scope: 'agent', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'user_preference' } });
  // Another agent's notes: must never show up.
  rows.push({ id: 'verification:agent:other:o1', namespace: `agent:${OTHER}`, kind: 'verification-correction', updatedAt: at(0),
    text: 'OTHER_AGENT_NOTE beta: Self-correction of a different agent', metadata: { scope: 'agent', audience: 'local', agentId: OTHER, chatId: CHAT, category: 'correction' } });
  rows.push({ id: 'promoted:o2', namespace: `agent:${OTHER}`, kind: 'session-fact', updatedAt: at(0),
    text: 'OTHER_AGENT_FACT beta: requirement for the other agent', metadata: { scope: 'agent', audience: 'local', agentId: OTHER, chatId: CHAT, category: 'user_preference' } });
  // Six shared rows (chat / personal / project) — more than the 4 seats.
  rows.push({ id: 'promoted:s1', namespace: `chat:${CHAT}`, kind: 'session-fact', updatedAt: at(1),
    text: 'SHARED_1 beta: chat decision use sqlite', metadata: { scope: 'chat', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'technical_detail' } });
  rows.push({ id: 'promoted:s2', namespace: 'user:local', kind: 'session-fact', updatedAt: at(2),
    text: 'SHARED_2 beta: user is in Shanghai', metadata: { scope: 'personal', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'identity' } });
  rows.push({ id: 'book:s3', namespace: `project:${P}`, kind: 'session-fact', updatedAt: at(3),
    text: 'SHARED_3 beta: project convention tabs', metadata: { scope: 'project', audience: 'local', projectId: P, agentId: AGENT, chatId: CHAT, category: 'project_context', bookStatus: 'auto' } });
  rows.push({ id: 'promoted:s4', namespace: `chat:${CHAT}`, kind: 'session-fact', updatedAt: at(4),
    text: 'SHARED_4 beta: chat detail node 22', metadata: { scope: 'chat', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'technical_detail' } });
  rows.push({ id: 'promoted:s5', namespace: `chat:${CHAT}`, kind: 'session-fact', updatedAt: at(5),
    text: 'SHARED_5 beta: chat detail pnpm', metadata: { scope: 'chat', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'technical_detail' } });
  rows.push({ id: 'promoted:s6', namespace: `chat:${CHAT}`, kind: 'session-fact', updatedAt: at(6),
    text: 'SHARED_6 beta: chat detail esm', metadata: { scope: 'chat', audience: 'local', agentId: AGENT, chatId: CHAT, category: 'technical_detail' } });
  for (const row of rows) store.upsertMemory({ ...row, createdAt: row.updatedAt });
  return rows;
}

const chat = () => ({ id: CHAT, source: 'desktop', projectId: P, agentId: AGENT, messages: [] });
const state = () => ({ chats: [chat()], settings: {}, approvals: [], tasks: [] });

function factsBlock(ctx) {
  const block = ctx.split('\n\n').find(b => b.startsWith('Relevant saved facts and corrections'));
  assert.ok(block, 'the facts block is still rendered under its original heading');
  return block;
}
const subLines = (block, heading, nextHeading) => {
  const start = block.indexOf(heading);
  if (start < 0) return [];
  const end = nextHeading ? block.indexOf(nextHeading) : -1;
  return block.slice(start + heading.length, end > start ? end : undefined).split('\n').map(l => l.trim()).filter(l => l.startsWith('- '));
};

test('corrections group is split into agentNotes (limit 4, own namespace only) and sharedFacts (limit 4)', async () => {
  await withHome(async () => {
    seed();
    const rendered = [];
    const ctx = buildAgentMemoryNodeContext({ state: state(), chat: chat(), latestUserMessage: 'beta', activeAgentProfile: { id: AGENT }, project: { id: P },
      onRecall: rows => rendered.push(...rows) });
    const block = factsBlock(ctx);
    assert.ok(block.indexOf(AGENT_NOTES_HEADING) < block.indexOf(SHARED_FACTS_HEADING), 'agent notes render before shared facts');
    const agentLines = subLines(block, AGENT_NOTES_HEADING, SHARED_FACTS_HEADING);
    const sharedLines = subLines(block, SHARED_FACTS_HEADING);
    assert.equal(agentLines.length, AGENT_NOTES_LIMIT, `agent notes: ${agentLines.join(' | ')}`);
    assert.equal(sharedLines.length, SHARED_FACTS_LIMIT, `shared facts: ${sharedLines.join(' | ')}`);
    for (const line of agentLines) assert.match(line, /AGENT_NOTE_/, 'only this agent\'s namespace in the agent sub-block');
    for (const line of sharedLines) assert.match(line, /SHARED_/, 'only chat/project/personal rows in the shared sub-block');
    assert.doesNotMatch(ctx, /OTHER_AGENT/, 'another agent\'s namespace is never rendered');
    // Owner tasks are part of the agent's notes and keep the task line format.
    assert.ok(agentLines.some(line => /AGENT_NOTE_3 beta deploy \[open\]/.test(line)), `owner task rendered as a task line: ${agentLines.join(' | ')}`);
    assert.equal((ctx.match(/AGENT_NOTE_3 beta deploy/g) || []).length, 1, 'the owner task is not repeated by the tasks group');
    // Rows keep flowing into memoryRendered (onRecall) with their exact fragment.
    const renderedIds = new Set(rendered.map(row => row.id));
    const renderedTexts = new Set(rendered.map(row => row.renderedText));
    for (const line of [...agentLines, ...sharedLines]) assert.ok(renderedTexts.has(line), `${line} must be reported through onRecall`);
    assert.equal(rendered.filter(row => row.namespace === `agent:${AGENT}`).length, AGENT_NOTES_LIMIT);
    assert.equal(rendered.filter(row => /SHARED_/.test(row.text)).length, SHARED_FACTS_LIMIT);
    for (const row of rendered) assert.ok(row.renderedText && ctx.includes(row.renderedText), `${row.id} renderedText must be verbatim in the prompt`);
    assert.ok(!renderedIds.has('verification:agent:other:o1') && !renderedIds.has('promoted:o2'));
  });
});

test('ordering inside each sub-block follows the recall order (newest first with a non-discriminating query)', async () => {
  await withHome(async () => {
    seed();
    const ctx = buildAgentMemoryNodeContext({ state: state(), chat: chat(), latestUserMessage: '', activeAgentProfile: { id: AGENT }, project: { id: P } });
    const block = factsBlock(ctx);
    const agentOrder = subLines(block, AGENT_NOTES_HEADING, SHARED_FACTS_HEADING).map(line => Number(line.match(/AGENT_NOTE_(\d)/)?.[1]));
    const sharedOrder = subLines(block, SHARED_FACTS_HEADING).map(line => Number(line.match(/SHARED_(\d)/)?.[1]));
    assert.deepEqual(agentOrder, [1, 2, 3, 4], 'agent notes keep updated_at DESC recall order and cut at 4');
    assert.deepEqual(sharedOrder, [1, 2, 3, 4], 'shared facts keep updated_at DESC recall order and cut at 4');
  });
});

test('an agent with no notes renders only the shared sub-block; shared rows never borrow agent seats', async () => {
  await withHome(async () => {
    seed();
    // Agent "fresh" has no namespace rows; the 6 shared rows must still cap at 4.
    const ctx = buildAgentMemoryNodeContext({ state: state(), chat: chat(), latestUserMessage: 'beta', activeAgentProfile: { id: 'fresh' }, project: { id: P } });
    const block = factsBlock(ctx);
    assert.doesNotMatch(block, new RegExp(AGENT_NOTES_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(subLines(block, SHARED_FACTS_HEADING).length, SHARED_FACTS_LIMIT);
    assert.doesNotMatch(ctx, /AGENT_NOTE_|OTHER_AGENT/, 'main\'s and other\'s agent rows are not visible to a third agent');
  });
});

test('a remote channel chat gets no agentNotes from the desktop owner, only its own chat-scoped correction', async () => {
  await withHome(async () => {
    seed();
    store.upsertMemory({ id: 'verification:agent:main:tg1', namespace: `agent:${AGENT}`, kind: 'verification-correction', createdAt: at(0), updatedAt: at(0),
      text: 'REMOTE_NOTE beta: Self-correction made in telegram', metadata: { scope: 'chat', audience: 'remote', agentId: AGENT, chatId: 'tg', category: 'correction' } });
    const tg = { id: 'tg', source: 'telegram', chatType: 'private', agentId: AGENT, messages: [] };
    const ctx = buildAgentMemoryNodeContext({ state: { chats: [chat(), tg], settings: {}, approvals: [], tasks: [] }, chat: tg, latestUserMessage: 'beta',
      activeAgentProfile: { id: AGENT }, project: null });
    assert.match(ctx, /REMOTE_NOTE beta/);
    assert.doesNotMatch(ctx, /AGENT_NOTE_|SHARED_|OTHER_AGENT/);
  });
});
