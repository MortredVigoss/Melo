import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadState } from '../state/stateStore.js';
import { syncDerivedSnapshot } from '../memory/derivedIndex.js';
import {warmKnowledgeIndex} from '../memory/knowledgeIndex.js';
import { reconcileDerivedFacts } from './reconcileDerivedFacts.js';
import { createRequestContext } from './requestContext.js';
import { runWithRequestContext } from './requestScope.js';
import { atomicWriteJson } from '../storage.js';

const { home, env } = workerData;
const ctx = { home, storePath: join(home, 'desktop/store.sqlite') };
const manifest = join(home, 'desktop/state.json');
const marker = join(home, 'desktop/derived-index.json');
const context = createRequestContext({ home, env });
let busy = false, requested = false, retry = null, failures = 0, initialized = false, previousChatIds = new Set();

async function run() {
  if (busy) { requested = true; return; }
  busy = true; requested = false;
  clearTimeout(retry);
  try {
    await runWithRequestContext(context, async () => {
      let raw;
      try { raw = await readFile(manifest, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const state = await loadState({ home });
      if (raw !== await readFile(manifest, 'utf8')) { requested = true; return; }
      const started = performance.now();
      syncDerivedSnapshot(state, ctx, { throwOnError: true });
      // Embedding is optional background work, outside prompt retrieval and
      // outside the durable source/index acknowledgement path.
      void warmKnowledgeIndex({home}).catch(()=>{});
      previousChatIds = reconcileDerivedFacts({ home, snapshot: state, initialize: !initialized, previousChatIds });
      initialized = true;
      const committed = { revision: state._revision || 0, manifestHash: createHash('sha256').update(raw).digest('hex'),
        indexedAt: new Date().toISOString(), durationMs: Math.round((performance.now()-started)*1000)/1000 };
      // Manifest revision is the durable outbox. Acknowledgement advances only
      // after success; process crashes replay the latest committed manifest.
      await atomicWriteJson(marker, committed);
      parentPort.postMessage({ type: 'indexed', ...committed });
      if (raw !== await readFile(manifest, 'utf8')) requested = true;
    });
    failures = 0;
  } catch (error) {
    failures++;
    parentPort.postMessage({ type: 'deferred', code: error.code || 'DERIVED_INDEX_FAILED' });
    retry = setTimeout(run, Math.min(30_000, 250 * 2 ** Math.min(failures, 7)));
  } finally {
    busy = false;
    if (requested) setImmediate(run);
    else parentPort.postMessage({ type: 'idle', failed: failures > 0 });
  }
}
parentPort.on('message', message => { if (message.type === 'commit') run(); });
run();
