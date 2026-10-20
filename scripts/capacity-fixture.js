import { performance } from 'node:perf_hooks';
import { readdir, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequestContext } from '../src/runtime/requestContext.js';
import { runWithRequestContext } from '../src/runtime/requestScope.js';
import { withPerformanceTrace } from '../src/runtime/performanceTrace.js';
import { updateStateAtomically, loadState } from '../src/state/stateStore.js';
import { getDesktopBootstrap } from '../src/services/desktop/bootstrap.js';
import { encodeBootstrap } from '../src/http/bootstrapTransport.js';
import { decodeBootstrap } from '../desktop-ui/bootstrapPatch.js';
import { runChatAgentExecutionGraph } from '../src/services/chat/chatExecutionRunner.js';
import { registerDerivedDispatcher } from '../src/state/derivedDispatcher.js';

export function capacityChats(count, messages, chars) {
  return Array.from({ length: count }, (_, c) => ({
    id: `capacity-${c}`, title: `Capacity ${c}`, agentId: 'main', mode: 'chat', source: 'desktop',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    messages: Array.from({ length: messages }, (_, m) => ({
      id: `capacity-${c}-${m}`, role: m % 2 ? 'assistant' : 'user',
      content: `CAPACITY_HIT_${c}_${m} ` + 'Synthetic local history. '.repeat(Math.ceil(chars / 'Synthetic local history. '.length)).slice(0, chars),
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(c > 0 && m % 10 === 1 ? { attachments: [{ type: 'image', name: 'synthetic-reference.png', path: '/synthetic/not-opened.png' }] } : {}),
    })),
  }));
}
export function distribution(values) {
  assert.ok(values.length > 0 && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1],
    min: sorted[0], max: sorted.at(-1), samples: values };
}
export async function capacityWorker({ home, mode, chats, messages, chars, rounds = 1, indexMode = 'deferred' }) {
  const context = createRequestContext({ home, env: { MELO_HOME: home, MELO_TEST_MODE: '1', MELO_OFFLINE_ONLY: '1', MELO_DREAMING_ENABLED: '0' } });
  await mkdir(home, { recursive: true });
  // Control background CPU/IO separately from source read/projection timings.
  // Production registers a worker here; this harness retains the revision
  // notification but performs no derived indexing in deferred mode.
  const deferredRevisions = [];
  const unregister = indexMode === 'deferred' ? registerDerivedDispatcher(home, revision => deferredRevisions.push(revision)) : () => {};
  try { return await runWithRequestContext(context, async () => {
    if (mode === 'seed') {
      await updateStateAtomically(state => {
        state.chats = capacityChats(chats, messages, chars);
        state.settings.selectedChatId = 'capacity-0';
      }, { home });
      if (indexMode === 'deferred') assert.ok(deferredRevisions.length > 0, 'the fixture dispatcher must actually receive the source revision');
      const dir = join(home, 'desktop', 'threads');
      const threadFiles = await readdir(dir);
      const threadBytes = (await Promise.all(threadFiles.map(name => stat(join(dir, name))))).reduce((sum, item) => sum + item.size, 0);
      return { manifestBytes: (await stat(join(home, 'desktop', 'state.json'))).size, threadBytes, threadFiles: threadFiles.length, indexMode, deferredRevisions };
    }
    const samples = [], stages = {};
    if (mode === 'warm') await getDesktopBootstrap(); // explicit unmeasured warm-up
    let baseline;
    await withPerformanceTrace({ onTiming: row => (stages[row.stage] ||= []).push(row.durationMs) }, async () => {
      for (let i = 0; i < rounds; i++) {
        const begin = performance.now();
        const bootstrap = await getDesktopBootstrap();
        const built = performance.now();
        const full = JSON.stringify(bootstrap);
        const serialized = performance.now();
        const encoded = encodeBootstrap(bootstrap, { home, baseToken: baseline?._snapshot?.token });
        const wire = JSON.stringify(encoded);
        const transport = performance.now();
        const decoded = decodeBootstrap(encoded, baseline);
        assert.equal(decoded.activeChat.id, 'capacity-0');
        assert.equal(decoded.activeChat.messages.length, messages);
        assert.equal(decoded.chats.length, chats);
        baseline = decoded;
        samples.push({ buildMs: built - begin, serializeMs: serialized - built, transportMs: transport - serialized,
          fullBytes: Buffer.byteLength(full), wireBytes: Buffer.byteLength(wire), wireKind: encoded.kind || 'full' });
      }
    });
    const localPreparationMs = [];
    let modelCalls = 0;
    if (mode === 'warm') {
      for (let i = 0; i < rounds; i++) {
        const begin = performance.now();
        const state = await loadState({ home });
        const chat = state.chats.find(row => row.id === 'capacity-0');
        const turnContext = createRequestContext({ home, chatId: chat.id, env: context.env });
        await runChatAgentExecutionGraph({ context: turnContext, home, state, chat, agentId: 'main',
          config: { authMode: 'unset', model: 'capacity-stub', apiKey: '', baseUrl: '' },
          workspace: { rootPath: home, exists: false, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] },
          connectors: [], skills: [], latestUserMessage: '你好', onDelta() {},
          _dependencies: { getEmbedding: async () => null, createReply: async options => {
            modelCalls++;
            localPreparationMs.push(performance.now() - begin);
            options.onDelta?.({ delta: 'Synthetic fixture reply.' });
            return 'Synthetic fixture reply.';
          } },
        });
      }
      assert.equal(modelCalls, rounds, 'exactly one stub boundary per measured turn');
      // Exercise actual search and historical selection after repeated cached reads.
      const last = `capacity-${chats - 1}`, target = `${last}-${messages - 1}`;
      const found = await getDesktopBootstrap(`CAPACITY_HIT_${chats - 1}_${messages - 1}`);
      assert.ok(found.search.chatThreads.some(row => row.chatId === last) || found.search.chatHits.some(row => row.chatId === last), 'search must retain a navigable historical conversation');
      await updateStateAtomically(state => { state.settings.selectedChatId = last; }, { home });
      const selected = await getDesktopBootstrap();
      assert.equal(selected.activeChat.id, last);
      assert.equal(selected.activeChat.messages.at(-1).id, target);
      assert.equal(selected.activeChat.messages.at(-1).content, capacityChats(1, messages, chars)[0].messages.at(-1).content.replace('CAPACITY_HIT_0_', `CAPACITY_HIT_${chats - 1}_`));
      await updateStateAtomically(state => { state.settings.selectedChatId = 'capacity-0'; }, { home });
    }
    return { samples, stages, localPreparationMs, modelCalls, modelNetworkMs: null,
      peakRssBytes: process.resourceUsage().maxRSS * 1024, finalRssBytes: process.memoryUsage().rss,
      semantics: mode === 'warm' ? ['current-chat', 'original-text', 'search-conversation-id', 'history-selection', 'delta-round-trip'] : ['current-chat', 'delta-round-trip'] };
  }); } finally { unregister(); }
}
