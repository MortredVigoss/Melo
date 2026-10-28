import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, appendFile, writeFile, rename, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { traceOperation, TRACE_LIMITS } from '../../shared/agent/trace.js';

const buildInfo = (() => {
  try {
    const root = new URL('../../', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('shared/agent/dist/manifest.json', root), 'utf8'));
    const verified = Object.entries(manifest.sources || {}).every(([path, digest]) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex') === digest);
    return { coreBundleHash: manifest.sha256, sourceManifestVerified: verified, runtimeVersion: process.version };
  } catch { return { coreBundleHash: null, sourceManifestVerified: false, runtimeVersion: process.version }; }
})();
const scope = new AsyncLocalStorage();
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const bounded = (work, ms = TRACE_LIMITS.flushMs) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), ms);
  Promise.resolve(work).then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(false); });
});
export const currentLoopTrace = () => scope.getStore() || null;
export function createLoopTrace({ home, traceId = randomUUID(), runId = traceId, host = 'node', clock = () => performance.now(), io = {}, limits = {} }) {
  if (!home || !validId(traceId) || !validId(runId)) throw new Error('Invalid local trace destination.');
  const storage = { mkdir, appendFile, writeFile, rename, ...io };
  const directory = join(home, 'traces', traceId);
  const quota = { ...TRACE_LIMITS, ...limits };
  let state = traceOperation({ action: 'create', context: { traceId, runId, scopeId: 'chat', spanId: runId }, now: clock(), maxEvents: quota.maxEvents }).trace;
  let writes = Promise.resolve(), queued = 0, bytes = 0, lost = 0, mediaOmitted = false, incomplete = false, finished = false, capped = false;
  const problems = new Set();
  const root = { traceId, runId, host, directory, manifest: null,
    get state() { return state; },
    get closed() { return finished; },
    get pending() { return writes; },
    record(event, context = { runId, scopeId: 'chat', spanId: runId }) {
      if (finished) return null;
      try {
        const value = traceOperation({ action: 'append', trace: state, context: { traceId, ...context }, event, now: Math.max(state.lastMono, clock()), at: new Date().toISOString() });
        state = value.trace;
        if (!value.record) return null;
        const record = value.record;
        let artifact = null;
        if (value.artifact) {
          const hash = createHash('sha256').update(value.artifact.json).digest('hex');
          const ref = 'artifacts/' + hash + '.json';
          artifact = { ref, json: value.artifact.json };
          record.data = { ...record.data, contentRef: ref, contentSha256: hash, contentBytes: Buffer.byteLength(value.artifact.json) };
        }
        mediaOmitted ||= record.capture.mediaOmitted;
        incomplete ||= record.capture.truncated;
        if (capped && event.type !== 'run.finished') { lost++; return null; }
        let line = JSON.stringify(record) + '\n';
        const size = Buffer.byteLength(line) + (artifact ? Buffer.byteLength(artifact.json) : 0);
        if (queued >= quota.maxQueue || bytes + size > quota.maxRunBytes - 8192 && event.type !== 'run.finished') {
          incomplete = true; lost++; capped = true; problems.add(queued >= quota.maxQueue ? 'queue_limit' : 'run_byte_limit');
          const gap = traceOperation({ action: 'append', trace: state, context, event: { type: 'trace.truncated', data: { reason: [...problems].at(-1) } }, now: Math.max(state.lastMono, clock()), at: new Date().toISOString() });
          state = gap.trace;
          if (gap.record) { line = JSON.stringify(gap.record) + '\n'; artifact = null; }
          else return null;
        }
        bytes += Buffer.byteLength(line) + (artifact ? Buffer.byteLength(artifact.json) : 0); queued++;
        // All strings, paths and scope are captured before crossing this queue.
        const capturedLine = line, capturedArtifact = artifact;
        writes = writes.catch(() => {}).then(async () => {
          await storage.mkdir(join(directory, 'artifacts'), { recursive: true, mode: 0o700 });
          if (capturedArtifact) await storage.writeFile(join(directory, capturedArtifact.ref), capturedArtifact.json, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          await storage.appendFile(join(directory, 'events.jsonl'), capturedLine, { mode: 0o600 });
        }).catch(() => { incomplete = true; lost++; problems.add('io_error'); }).finally(() => { queued--; });
        return record;
      } catch { incomplete = true; lost++; problems.add('invalid_event'); return null; }
    },
    async flush() {
      const ok = await bounded(writes, quota.flushMs);
      if (!ok) { incomplete = true; problems.add('write_timeout'); }
      return ok;
    },
    async finish(data = {}) {
      if (finished) return root.manifest;
      root.record({ type: 'run.finished', data }, { runId, scopeId: 'chat', spanId: runId });
      finished = true;
      await root.flush();
      const manifest = { schemaVersion: 1, traceId, runId, host, status: data.outcome || 'unknown', finishedAt: new Date().toISOString(),
        complete: !incomplete && !lost, droppedEvents: lost, problems: [...problems], bytes, lastSequence: state.sequence,
        replayability: { policy: !incomplete && !lost, text: 'requires_artifact_validation', multimodal: mediaOmitted ? 'unavailable' : 'not_captured' }, pinned: false };
      root.manifest = manifest;
      const snapshot = JSON.stringify(manifest, null, 2);
      writes = writes.catch(() => {}).then(async () => { await storage.mkdir(directory, { recursive: true, mode: 0o700 }); await storage.writeFile(join(directory, 'manifest.json.tmp'), snapshot, { mode: 0o600 }); await storage.rename(join(directory, 'manifest.json.tmp'), join(directory, 'manifest.json')); }).catch(() => { problems.add('manifest_io_error'); });
      await bounded(writes, quota.flushMs);
      return manifest;
    },
  };
  return root;
}
export function traceEvent(type, data = {}, payload, fields = {}) {
  const current = scope.getStore(); if (!current) return null;
  return current.root.record({ type, data, ...(payload === undefined ? {} : { payload }), ...fields }, current.context);
}
export async function traceFlush() { return scope.getStore()?.root.flush(); }
export async function withLoopTrace({ home, runId = randomUUID(), kind = 'chat', goal, metadata = {} } = {}, work) {
  const inherited = scope.getStore();
  const parent = inherited?.root.closed ? null : inherited;
  if (!parent && !home) return work();
  const logicalRunId = runId; if (!validId(runId)) runId = randomUUID();
  const root = parent?.root || createLoopTrace({ home, runId });
  const context = { runId, logicalRunId, scopeId: kind, spanId: runId, parentRunId: parent?.context.runId || null, parentSpanId: parent?.context.spanId || null };
  return scope.run({ root, context }, async () => {
    traceEvent('run.started', { host: 'node', kind, ...buildInfo, ...metadata }, { goal });
    try {
      const result = await work();
      const completion = result?.normalizedReply?.completion || result?.meta?.completion || result?.completion;
      const outcome = completion?.outcome || 'unknown';
      if (parent) { traceEvent('run.finished', { outcome, completion: completion || null }); await root.flush(); }
      else await root.finish({ outcome, completion: completion || null });
      return result;
    } catch (error) {
      const data = { outcome: error?.name === 'AbortError' || error?.code === 'ABORTED' ? 'cancelled' : 'failed', code: error?.code || error?.name || 'ERROR' };
      if (parent) { traceEvent('run.finished', data); await root.flush(); } else await root.finish(data);
      throw error;
    } finally { if (!parent) await pruneLocalTraces(home).catch(() => {}); }
  });
}
export async function traceModelCall(options, work) {
  const parent = scope.getStore(); if (!parent || parent.modelSpan) return work(options);
  const spanId = parent.context.runId + ':model:' + randomUUID();
  const context = { ...parent.context, spanId, parentSpanId: parent.context.spanId };
  return scope.run({ ...parent, context, modelSpan: spanId }, async () => {
    const started = performance.now(); let first = null;
    const snapshot = { instructions: options.systemPrompt, messages: options.messages, tools: options.tools ?? options.functionTools ?? options.toolDefinitions ?? null, nativeWebSearchEnabled: options.nativeWebSearchEnabled ?? null, purpose: options.purpose || 'loop' };
    traceEvent('context.snapshot', { source: 'model-adapter', skillsCapturedInInstructions: true }, snapshot);
    traceEvent('capabilities.snapshot', { source: 'model-adapter', purpose: options.purpose || 'loop', toolSchemaCaptured: Array.isArray(snapshot.tools) }, { tools: snapshot.tools });
    traceEvent('model.request.prepared', { model: options.model || null, purpose: options.purpose || 'loop', usageOrigin: 'unknown' }, snapshot);
    traceEvent('model.request.started', { source: 'model-adapter', providerDispatch: 'unknown' });
    await traceFlush();
    const originalDelta = options.onDelta;
    const onDelta = typeof originalDelta === 'function' ? (...args) => { if (first == null && (args[0]?.delta || args[0]?.text)) first = performance.now() - started; return originalDelta(...args); } : undefined;
    try {
      const result = await work({ ...options, onDelta });
      traceEvent('model.response', { durationMs: performance.now() - started, firstEventMs: first, usageOrigin: 'unknown' }, result);
      return result;
    } catch (error) { traceEvent('model.error', { durationMs: performance.now() - started, firstEventMs: first, code: error?.code || error?.name || 'ERROR' }); throw error; }
  });
}
/** Returns the original serialized bytes; only the separate snapshot is redacted. */
export async function traceProviderPayload(payload) {
  const body = JSON.stringify(payload);
  traceEvent('model.provider.payload', { source: 'provider-wire', model: payload.model || null }, payload);
  traceEvent('model.transport.started', { source: 'provider-wire' });
  await traceFlush(); return body;
}
export async function traceToolCall(tool, args, options, work) {
  const parent = scope.getStore(); if (!parent) return work();
  const context = { ...parent.context, spanId: parent.context.runId + ':tool:' + (options.toolCallId || randomUUID()), parentSpanId: parent.context.spanId };
  return scope.run({ ...parent, context, toolDispatch: { started: false } }, async () => {
    traceEvent('tool.executor.requested', { callId: options.toolCallId || null, name: tool?.id || 'unknown' }, args);
    try {
      const result = await work(); const started = scope.getStore().toolDispatch.started;
      traceEvent('tool.result', { callId: options.toolCallId || null, name: tool?.id || 'unknown', ok: result?.ok === true,
        effectState: !started ? 'not_started' : result?.meta?.aborted || ['TIMEOUT', 'TOOL_TIMEOUT', 'ABORTED', 'BUDGET_EXHAUSTED'].includes(result?.code || result?.error) ? 'unknown' : result?.ok ? 'returned' : 'error_returned' }, result);
      return result;
    } catch (error) { traceEvent('tool.result', { callId: options.toolCallId || null, name: tool?.id || 'unknown', ok: false, effectState: scope.getStore().toolDispatch.started ? 'unknown' : 'not_started', code: error?.code || 'EXECUTOR_ERROR' }); throw error; }
  });
}
export async function traceToolDispatch(name) {
  const current = scope.getStore(); if (current?.toolDispatch) current.toolDispatch.started = true;
  traceEvent('tool.dispatch.started', { name, effectState: 'dispatched' }); await traceFlush();
}
export async function pruneLocalTraces(home, { now = Date.now(), limits = TRACE_LIMITS } = {}) {
  const base = join(home, 'traces'); const names = await readdir(base).catch(() => []); const runs = [];
  for (const name of names) {
    if (!validId(name)) continue;
    const path = join(base, name); let manifest;
    try { manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')); } catch { continue; }
    if (manifest.schemaVersion !== 1 || manifest.traceId !== name) continue;
    runs.push({ name, path, manifest, age: Date.parse(manifest.finishedAt) || 0, bytes: Number(manifest.bytes) || 0 });
  }
  runs.sort((a, b) => b.age - a.age); let total = runs.reduce((sum, row) => sum + row.bytes, 0), kept = 0;
  for (const row of runs) {
    if (row.manifest.pinned) continue;
    if (++kept <= limits.maxRuns && now - row.age <= limits.retentionDays * 86400000 && total <= limits.maxBytes) continue;
    await rm(row.path, { recursive: true, force: true }); total -= row.bytes;
  }
}
export async function readLocalTrace(directory) {
  if ((await stat(join(directory, 'events.jsonl'))).size > TRACE_LIMITS.maxRunBytes + 65536) throw new Error('Trace exceeds read budget.');
  const raw = await readFile(join(directory, 'events.jsonl'), 'utf8');
  if (Buffer.byteLength(raw) > TRACE_LIMITS.maxRunBytes + 65536) throw new Error('Trace exceeds read budget.');
  const events = [], errors = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { errors.push({ line: index + 1, code: 'INVALID_JSON_LINE' }); }
  }
  let manifest = null; try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); } catch { errors.push({ code: 'MISSING_MANIFEST' }); }
  for (const event of events) if (event.data?.contentRef) {
    const ref = event.data.contentRef;
    if (!/^artifacts\/[a-f0-9]{64}\.json$/u.test(ref)) { errors.push({ code: 'INVALID_ARTIFACT_REFERENCE' }); continue; }
    try { const content = await readFile(join(directory, ref)); if (createHash('sha256').update(content).digest('hex') !== event.data.contentSha256) errors.push({ code: 'ARTIFACT_HASH_MISMATCH' }); }
    catch { errors.push({ code: 'MISSING_ARTIFACT' }); }
  }
  const ids = new Set(); let sequence = 0;
  for (const row of events) {
    if (row.schemaVersion !== 1 || ids.has(row.eventId) || row.sequence !== ++sequence) errors.push({ code: 'EVENT_IDENTITY_OR_GAP' });
    ids.add(row.eventId);
  }
  if (!manifest?.complete) errors.push({ code: 'INCOMPLETE_TRACE' });
  return { manifest, events, errors, complete: errors.length === 0 };
}
