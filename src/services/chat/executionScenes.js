import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene, sceneFinished, sceneUrl, sceneSourceUrl, mergeSceneSources } from '../../shared/executionScene.js';
import { extractTextUrls } from '../../media/textUrls.js';
import { signWorkspaceFileUrl } from '../../web/urlSigning.js';
import { observeShellWeb } from '../../tools/shellWebObservation.js';
import { archiveSceneImages } from '../../media/imageRecords.js';
import { sessionContext } from '../../shared/sessionEvents.js';
import { readToolInvocationRecords } from '../../tools/toolInvocationRecord.js';

const live = new Map();
const keyFor = (home, runId) => `${home}\0${runId}`;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const fileFor = (home, runId) => {
  if (!validId(runId)) throw Object.assign(new Error('Invalid run ID'), { statusCode: 400 });
  return join(home, 'desktop', 'execution-scenes', `${runId}.json`);
};
const copy = value => structuredClone(value);
export function executionSearchContext(messages = [], query = '') {
  if (query.length > 40 || !/^(再|继续|还是|那|这|重试|往下|多查|多搜)/.test(query)) return '';
  return messages.filter(m => m.role === 'user').slice(-4).map(m => m.content).join('\n').slice(-2000);
}
function refreshArtifactUrls(scene) {
  for (const artifact of [...(scene.artifacts || []), ...(scene.previews || [])]) {
    if (artifact.path && artifact.path.startsWith('/')) {
      artifact.originalUrl ||= artifact.url;
      artifact.url = signWorkspaceFileUrl(artifact.path);
      if (artifact.beforePath?.startsWith('/')) artifact.beforeUrl = signWorkspaceFileUrl(artifact.beforePath);
    }
  }
  return scene;
}

function citationSources(message, scene) {
  const text = [message?.content, ...(message?.blocks || []).filter(b => b.type !== 'code').map(b => b.text)].filter(Boolean).join('\n');
  const labels = new Map();
  for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const key = sceneSourceUrl(match[2]); if (!key) continue;
    const host = new URL(key).hostname.replace(/^www\./, '');
    if (!labels.has(key) || labels.get(key).replace(/^www\./, '') === host) labels.set(key, match[1]);
  }
  const urls = [...extractTextUrls(text), ...(message?.citations || []).map(c => c.src)]
    .map(sceneUrl).filter(url => url && !scene.artifacts.some(a => a.url === url || a.originalUrl === url));
  return [...new Set(urls)].map(url => ({ url, citationUrl: url, citationLabel: labels.get(sceneSourceUrl(url)), reading: 'unknown' }));
}

// Read-only migration of old saved observations. Never run a tool to fill a
// history gap. Preserve timestamps, terminal status, selection and event log.
export function recoverSceneObservations(scene, { message, searchContext = '' } = {}) {
  if (!sceneFinished(scene)) return scene;
  const copyScene = copy(scene), terminalStatus = scene.status, events = copyScene.events;
  const citations = citationSources(message, scene);
  // Reconcile saved citations even when tool observations are already current.
  // Rebuild only source records to collapse legacy tracking-tag duplicates;
  // retain the first node ID and all recorded reading/provider evidence.
  copyScene.sources = [];
  mergeSceneSources(copyScene, scene.sources.map(s => ({ ...s, titleProvided: !!s.titleProvided })));
  copyScene.status = 'running';
  if (!(scene.observationVersion >= 2)) {
    for (const op of scene.operations) {
      if (op.name !== 'bash' || op.status !== 'completed') continue;
      const observation = observeShellWeb({}, { ok: true, output: op.output }, { citationUrls: citations.map(s => s.url) });
      if (!observation) continue;
      applyExecutionEvent(copyScene, { ...observation, kind: 'operation', id: op.id, status: op.status, at: op.finishedAt || scene.finishedAt });
    }
    copyScene.observationVersion = 2;
    copyScene.searchContext = searchContext.slice(-2000);
    if (scene.operations.some(op => op.name === 'bash' && op.output?.length >= 2200)) {
      copyScene.observationNote = '旧工具输出有截断；仅恢复可核对的来源，缺失的读取范围保留未知。';
    }
  }
  mergeSceneSources(copyScene, citations);
  const cited = new Set(citations.map(s => sceneSourceUrl(s.url)));
  if (message) copyScene.sources.forEach(s => { s.cited = cited.has(sceneSourceUrl(s.url)); });
  copyScene.status = terminalStatus; copyScene.events = events.slice(0, scene.events.length);
  copyScene.sequence = scene.sequence;
  if (isDeepStrictEqual(copyScene, scene)) return scene;
  copyScene.sequence++;
  return copyScene;
}

// Retention for `<home>/desktop/execution-scenes/<runId>.*` (bug audit T15):
// the scene JSON, the D1 `<runId>.tools.jsonl` record file and any
// `.selection` variants used to accumulate forever. Runs older than
// SCENE_RETENTION_DAYS or beyond the newest SCENE_RETENTION_RUNS are deleted
// (whole run at a time, never a run that is still live). The sweep runs from
// the recorder's `finish` — the same place scenes are written — at most once
// per SCENE_PRUNE_INTERVAL_MS per home, and never throws.
export const SCENE_RETENTION_DAYS = 14;
export const SCENE_RETENTION_RUNS = 300;
const SCENE_PRUNE_INTERVAL_MS = 10 * 60_000;
const lastPrune = new Map();
const RUN_FILE = /^([a-zA-Z0-9_-]{1,128})(\.json|\.tools\.jsonl|\.json\.selection\.tmp|\.json\.tmp)$/;

export async function pruneExecutionScenes(home, { maxAgeDays = SCENE_RETENTION_DAYS, maxRuns = SCENE_RETENTION_RUNS, now = Date.now() } = {}) {
  const directory = join(home, 'desktop', 'execution-scenes');
  let names;
  try { names = await readdir(directory); } catch { return { removedRuns: 0, removedFiles: 0 }; }
  const runs = new Map();
  for (const name of names) {
    const match = RUN_FILE.exec(name);
    if (!match) continue;
    let mtime = 0;
    try { mtime = (await stat(join(directory, name))).mtimeMs; } catch { continue; }
    const run = runs.get(match[1]) || { files: [], newest: 0 };
    run.files.push(name);
    run.newest = Math.max(run.newest, mtime);
    runs.set(match[1], run);
  }
  const cutoff = now - Math.max(0, maxAgeDays) * 86_400_000;
  const ordered = [...runs.entries()].sort((a, b) => b[1].newest - a[1].newest);
  let removedRuns = 0, removedFiles = 0;
  for (const [index, [runId, run]] of ordered.entries()) {
    if (live.has(keyFor(home, runId))) continue;
    if (run.newest >= cutoff && index < Math.max(0, maxRuns)) continue;
    // Keep image identities when detailed execution telemetry expires.
    // Refuse to prune this run if its image record cannot be preserved.
    try {
      const scene = JSON.parse(await readFile(fileFor(home, runId), 'utf8'));
      await archiveSceneImages(home, scene);
    } catch (error) { if (error.code !== 'ENOENT') continue; }
    for (const name of run.files) {
      try { await rm(join(directory, name), { force: true }); removedFiles++; } catch {}
    }
    removedRuns++;
  }
  return { removedRuns, removedFiles };
}

function schedulePrune(home) {
  const now = Date.now();
  if (now - (lastPrune.get(home) || 0) < SCENE_PRUNE_INTERVAL_MS) return;
  lastPrune.set(home, now);
  pruneExecutionScenes(home, { now }).catch(() => {});
}

export function createExecutionRecorder(context, query, emit) {
  const scene = createExecutionScene({ ...context, query });
  scene.observationVersion = 2;
  scene.searchContext = sceneTextContext(context.searchContext);
  const key = keyFor(context.home, context.runId);
  const file = fileFor(context.home, context.runId);
  const directory = join(context.home, 'desktop', 'execution-scenes');
  let writes = Promise.resolve(), pending = null, closed = false;
  live.set(key, scene);
  function persist() {
    const snapshot = JSON.stringify(scene);
    writes = writes.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      await archiveSceneImages(context.home, JSON.parse(snapshot), context.workspacePath);
    });
    writes.catch(() => {});
  }
  function publish() {
    try { emit?.('execution_scene', { scene: copy(scene) }); } catch {}
    if (!pending) pending = setTimeout(() => { pending = null; persist(); }, 100);
  }
  publish();
  return {
    scene,
    setSearchContext(messages) {
      scene.searchContext = executionSearchContext(messages, scene.query);
      scene.sequence++; publish();
    },
    event(event) { if (!closed && applyExecutionEvent(scene, event)) publish(); },
    recordTool(record) {
      if (closed || record?.runId !== context.runId) return;
      // Keep the authoritative record identity and result only. Full redacted
      // payloads already live in the tool jsonl, not in this UI projection.
      scene.toolCalls ||= [];
      const call = projectToolCall(record);
      const index = scene.toolCalls.findIndex(row => row.iteration === call.iteration && row.callId === call.callId);
      if (index >= 0) scene.toolCalls[index] = call;
      else if (scene.toolCalls.length < 160) scene.toolCalls.push(call);
      scene.sequence++;
      publish();
    },
    async finish(status, message) {
      if (closed) return copy(scene);
      closed = true;
      clearTimeout(pending); pending = null;
      // Use the same actual links/markers/citation data rendered by chat.
      // A citation without a recorded visit remains reading=unknown.
      const citations = citationSources(message, scene);
      if (citations.length) applyExecutionEvent(scene, { sources: citations });
      const citedUrls = citations.map(s => s.url);
      finishExecutionScene(scene, { status, message, citedUrls });
      persist();
      try { await writes; } catch { scene.persistenceError = '场景保存失败；本次仅可在当前窗口回看'; }
      try { emit?.('execution_scene', { scene: copy(scene) }); } catch {}
      live.delete(key);
      schedulePrune(context.home);
      return copy(scene);
    },
  };
}

const sceneTextContext = value => String(value || '').slice(-2000);

export async function readExecutionScene(home, runId, history = {}) {
  const current = live.get(keyFor(home, runId));
  if (current) return refreshArtifactUrls(copy(current));
  try {
    const scene = JSON.parse(await readFile(fileFor(home, runId), 'utf8'));
    if (scene.version !== 1 || scene.runId !== runId) return null;
    const records = await readToolInvocationRecords(runId, { home });
    if (records.length) scene.toolCalls = records.slice(0, 160).map(projectToolCall);
    if (!sceneFinished(scene)) finishExecutionScene(scene, { status: 'interrupted' });
    return refreshArtifactUrls(recoverSceneObservations(scene, history));
  } catch (error) {
    if (error.statusCode) throw error;
    return null;
  }
}

function projectToolCall(record) {
  return { iteration: record.iteration, callId: record.callId, toolId: record.toolId,
    argsHash: record.argsHash, status: record.resultEnvelope?.status, code: record.resultEnvelope?.code,
    executed: record.resultEnvelope?.meta?.executionStarted === false ? false : undefined,
    startedAt: record.startedAt, finishedAt: record.finishedAt };
}

export async function readExecutionContext(home, chat, { excludedRunId, enabled = true } = {}) {
  if (!enabled || !chat?.id) return '';
  // User messages also carry run IDs, so interrupted turns without an
  // assistant reply remain discoverable. Do not enumerate other chats.
  const ids = [...new Set((chat.messages || []).map(message => message.metadata?.runId)
    .filter(id => validId(id) && id !== excludedRunId))].slice(-3);
  const scenes = await Promise.all(ids.map(async id => {
    const scene = await readExecutionScene(home, id);
    return scene?.chatId === chat.id ? scene : null;
  }));
  return sessionContext(scenes);
}

export function selectSceneImage(scene, artifactId, slot = 0) {
  if (!sceneFinished(scene)) throw Object.assign(new Error('请等待本轮生成结束'), { statusCode: 409 });
  const images = scene.artifacts.filter(a => a.kind === 'image');
  const candidate = images.find(a => a.id === artifactId);
  if (!candidate || !Number.isInteger(slot) || slot < 0 || slot >= Math.min(scene.requestedImages, images.length)) {
    throw Object.assign(new Error('候选或展示位置无效'), { statusCode: 400 });
  }
  const previous = scene.selectedImageIds.indexOf(artifactId);
  if (previous >= 0) [scene.selectedImageIds[slot], scene.selectedImageIds[previous]] = [scene.selectedImageIds[previous], scene.selectedImageIds[slot]];
  else scene.selectedImageIds[slot] = artifactId;
  scene.selectionChangedAt = new Date().toISOString();
  return scene;
}

export async function saveExecutionScene(home, scene) {
  const file = fileFor(home, scene.runId);
  await writeFile(`${file}.selection.tmp`, JSON.stringify(scene), { mode: 0o600 });
  await rename(`${file}.selection.tmp`, file);
}
