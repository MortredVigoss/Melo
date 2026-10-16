#!/usr/bin/env node
// Isolated application-path benchmark. Model and embedding providers are
// deterministic stubs; numbers measure Melo overhead, NOT network/model speed.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequestContext } from '../src/runtime/requestContext.js';
import { runWithRequestContext } from '../src/runtime/requestScope.js';
import { withPerformanceTrace, measureStage } from '../src/runtime/performanceTrace.js';
import { updateStateAtomically, loadState } from '../src/state/stateStore.js';
import { getDesktopBootstrap } from '../src/services/desktop/bootstrap.js';
import { runChatAgentExecutionGraph } from '../src/services/chat/chatExecutionRunner.js';
import { startDerivedIndexing } from '../src/runtime/derivedIndexing.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const rounds = Number(option('--rounds', 50));
const count = Number(option('--chats', 64));
const output = option('--out', null);
if (!Number.isSafeInteger(rounds) || rounds < 1 || !Number.isSafeInteger(count) || count < 1) throw Error('Invalid benchmark size');
const home = await mkdtemp(join(tmpdir(), 'melo-bench-turn-'));
const context = createRequestContext({ home, env: { MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', MELO_OFFLINE_ONLY: '1' } });
const config = { authMode: 'unset', apiKey: '', baseUrl: '', model: 'fixture-model' };
const workspace = { rootPath: home, exists: false, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] };
const report = { fixture: { chats: count, messagesPerChat: 20, rounds, model: 'stub', embedding: 'stub-null' }, scenarios: {} };
const indexWorker = args.includes('--sync-index') ? null : startDerivedIndexing({ home, env: context.env });
report.fixture.indexing = indexWorker ? 'worker' : 'inline';
const percentile = (xs, p) => [...xs].sort((a,b) => a-b)[Math.max(0, Math.ceil(xs.length*p)-1)];
try {
  await runWithRequestContext(context, async () => {
    await updateStateAtomically(state => {
      state.chats = Array.from({ length: count }, (_, c) => ({ id: `bench-${c}`, title: `Bench ${c}`, mode: 'chat', agentId: 'main',
        messages: Array.from({ length: 20 }, (_, m) => ({ id: `msg-${c}-${m}`, role: m%2 ? 'assistant' : 'user',
          content: `Local memory retrieval sample ${c} ${m}. ` + 'Synthetic history. '.repeat(30), createdAt: '2026-01-01T00:00:00.000Z' })) }));
      state.settings.selectedChatId = 'bench-0';
    }, { home });
    await indexWorker?.flush();
    for (const [scenario, content] of Object.entries({ casual: '你好', short: '什么是本地记忆检索？', long: '解释这段材料的结构：'+'本地历史需要保留上下文，检索需要限定作用域。'.repeat(30), group: '如何整理群聊里的记忆？' })) {
      const stages = new Map(); let embeddings = 0, models = 0;
      const started = performance.now();
      await withPerformanceTrace({ onTiming: row => { const values = stages.get(row.stage) || []; values.push(row.durationMs); stages.set(row.stage, values); } }, async () => {
        for (let n = 0; n < rounds; n++) {
          await measureStage('turn.save_user', () => updateStateAtomically(s => {
            const chat = s.chats.find(c => c.id === 'bench-0');
            chat.chatType = scenario === 'group' ? 'group' : 'private';
            chat.messages.push({ id: `${scenario}-${n}-u`, role: 'user', content, senderId: `person-${n%3}`, createdAt: new Date().toISOString() });
          }, { home }));
          const state = await measureStage('turn.load', () => loadState({ home }));
          const chat = state.chats.find(c => c.id === 'bench-0');
          const result = await runChatAgentExecutionGraph({ context, home, config, state, chat, workspace, connectors: [], skills: [],
            latestUserMessage: content, agentId: 'main', onDelta: () => {},
            _dependencies: { getEmbedding: async () => { embeddings++; return null; }, createReply: async options => {
              models++; options.onDelta?.({ delta: '基准回答。' }); return '基准回答。';
            } } });
          await measureStage('turn.save_reply', () => updateStateAtomically(s => {
            s.chats.find(c => c.id === 'bench-0').messages.push({ ...result.normalizedReply, id: `${scenario}-${n}-a`, role: 'assistant', createdAt: new Date().toISOString() });
          }, { home }));
          await getDesktopBootstrap();
        }
      });
      report.scenarios[scenario] = { totalMs: Math.round(performance.now()-started), calls: { embeddings, models },
        stages: Object.fromEntries([...stages].map(([key, values]) => [key, { n: values.length, p50: percentile(values,.5), p95: percentile(values,.95) }])) };
    }
  });
  const catchUpStarted = performance.now();
  await indexWorker?.flush({timeoutMs:30_000});
  report.indexCatchUpMs = performance.now()-catchUpStarted;
  if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report,null,2)+'\n'); }
  console.log(JSON.stringify(report,null,2));
} finally { await indexWorker?.stop(); await rm(home, { recursive: true, force: true }); }
