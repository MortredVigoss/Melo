import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../storage.js';
import { resolveRuntimePaths } from './paths.js';
import { requestEnvironment } from './requestScope.js';

const queues = new Map();
const VALID_IDS = new Set(['model', 'image', 'audio', 'video', 'document', 'link', 'search']);
const VALID_LEVELS = new Set(['none', 'response', 'image-input', 'ocr', 'transcript', 'keyframes', 'transcript+keyframes', 'body', 'preview', 'results']);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function readCapabilityEvidence(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'desktop', 'capabilities.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

// A fixed-size, content-free record. Never persist prompts, URLs, keys or errors.
export function createCapabilityRecorder({ home = resolveRuntimePaths().home, env = requestEnvironment(), config = {} } = {}) {
  const enabled = env.MELO_DIAGNOSTICS_RECORD !== '0' && !env.NODE_TEST_CONTEXT;
  const simulated = Boolean(env.MELO_MOCK_RESPONSE);
  const model = String(config.model || env.MELO_MODEL || '').slice(0, 100);
  const authMode = String(config.authMode || env.MELO_AUTH_MODE || '').slice(0, 30);
  return function record(id, { ok = false, level = 'none', cached = false, provider = '', reason = '', simulated: mock = simulated, reportedModel = '', transport = '' } = {}) {
    if (!enabled || !VALID_IDS.has(id)) return Promise.resolve();
    const entry = {
      ok: Boolean(ok), level: VALID_LEVELS.has(level) ? level : 'none',
      cached: Boolean(cached), simulated: Boolean(mock),
      provider: /^[a-z0-9:+._-]{0,80}$/i.test(provider) ? provider : '',
      reason: /^[a-z0-9-]{0,80}$/i.test(reason) ? reason : 'request-failed',
      model, authMode, checkedAt: new Date().toISOString(),
      ...(id === 'model' ? {
        reportedModel: /^[a-z0-9._:/-]{1,150}$/i.test(reportedModel) ? reportedModel : '',
        transport: /^[a-z0-9-]{1,40}$/i.test(transport) ? transport : '',
      } : {}),
    };
    const previous = queues.get(home) || Promise.resolve();
    const pending = previous.then(async () => {
      const saved = await readCapabilityEvidence(home);
      const snapshot = Object.fromEntries(Object.entries(saved).filter(([key]) => VALID_IDS.has(key)));
      snapshot[id] = entry;
      await atomicWriteJson(join(home, 'desktop', 'capabilities.json'), snapshot);
    }).catch(() => {});
    queues.set(home, pending);
    void pending.finally(() => { if (queues.get(home) === pending) queues.delete(home); });
    return pending;
  };
}

export function capabilityStatus(entry, { now = Date.now(), model = '', authMode = '' } = {}) {
  if (!entry) return { status: 'yellow', reason: 'not-tested', level: 'none' };
  const age = now - Date.parse(entry.checkedAt);
  const stale = !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS;
  const changed = (model && entry.model && entry.model !== model) || (authMode && entry.authMode && entry.authMode !== authMode);
  let reason = entry.reason || (entry.ok ? 'request-succeeded' : 'request-failed');
  let status = entry.ok ? 'green' : 'red';
  if (stale || changed || entry.simulated || entry.cached || ['preview', 'results', 'keyframes', 'image-input'].includes(entry.level)) {
    status = 'yellow';
    reason = stale ? 'stale-evidence' : changed ? 'configuration-changed' : entry.simulated ? 'simulated-only'
      : entry.cached ? 'cached-only' : 'partial-evidence';
  }
  return { ...entry, status, reason };
}

export function describeMediaEvidence(attachment, entry, { modelSupportsVision = false, cached = false } = {}) {
  const kind = entry?.metadata?.directMediaExtractionAttempted ? 'video'
    : attachment?.mimeType?.includes('pdf') ? 'document' : attachment?.kind;
  const id = ['audio', 'video', 'image', 'document'].includes(kind) ? kind : 'link';
  const source = String(entry?.metadata?.source || '');
  const text = String(entry?.text || '').trim();
  const real = Boolean(text) && !source.endsWith('-placeholder') && !['vision-passthrough', 'whisper-unavailable'].includes(source);
  let level = 'none';
  if (real) {
    const frames = entry.metadata?.keyframes?.length > 0;
    if (id === 'video') {
      const transcript = entry.kind === 'transcript' || source === 'video-audio-transcript'
        || entry.metadata?.hasTranscript === true || entry.metadata?.directMediaExtractionSource === 'video-audio-transcript';
      level = transcript ? (frames ? 'transcript+keyframes' : 'transcript') : frames ? 'keyframes' : 'preview';
    } else if (id === 'image') level = 'ocr';
    else if (id === 'audio') level = entry.kind === 'transcript' ? 'transcript' : 'none';
    else level = source.includes('oembed') || source.startsWith('social-link:') ? 'preview' : 'body';
  } else if (id === 'image' && modelSupportsVision) {
    // Passing the image to the provider is not proof it was understood.
    level = 'image-input';
  }
  return { id, ok: level !== 'none', level, cached, provider: source, reason: level === 'none' ? 'no-extracted-content' : '' };
}

export function describeSearchEvidence(source, result) {
  const id = source === 'web-search' ? 'search' : 'link';
  const ok = result?.ok !== false && Boolean(result?.output || result?.body);
  const meta = result?.meta || {};
  const social = source === 'social-link' || meta.platform || meta.method === 'social-link';
  const level = !ok ? 'none' : social ? 'preview' : id === 'search'
    ? Number(meta.contentFetched || 0) > 0 ? 'body' : 'results'
    : Number(meta.length || 0) > 0 ? 'body' : 'preview';
  return {
    id, ok, level,
    cached: Boolean(meta.cacheHit || meta.timings?.cacheHit || meta.stale
      || (meta.contentFromCache > 0 && !(meta.contentFreshFetched > 0))),
    provider: meta.provider || meta.method || result?.via || '',
    reason: ok ? '' : result?.aborted ? 'aborted' : 'reader-failed',
  };
}
