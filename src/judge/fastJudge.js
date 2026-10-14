import { createHash } from 'node:crypto';
import { createOpenAICompatibleReply } from '../openai.js';
import { resolveRuntimePaths } from '../runtime/paths.js';
import { currentRequestContext, runWithRequestContext } from '../runtime/requestScope.js';
import { createRequestContext } from '../runtime/requestContext.js';

export const JUDGE_TIMEOUT_MS = 4000;
const MAX_CANDIDATES = 3;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
const observations = new Map();
const answers = new Map();
const labels = { intent: ['factual', 'creative', 'coding', 'high-stakes', 'casual'], addressal: ['yes', 'no'] };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const put = (map, key, value, max = 256) => {
  map.delete(key); map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
};

// Only models saved in connections participate. A provider catalog advertises
// availability; it does not authorize guessing another model or endpoint.
export function judgeCandidates(config = {}) {
  const profiles = Object.entries(config.llmProfiles || {}).sort(([a], [b]) =>
    Number(b === config.activeLlmProfileId) - Number(a === config.activeLlmProfileId));
  const source = config.activeLlmProfileId ? profiles : [['current', { ...config, name: '当前连接' }], ...profiles];
  const seen = new Set();
  return source.flatMap(([id, profile]) => {
    if (!profile?.model || !profile.baseUrl || !['codex', 'local', 'api-key'].includes(profile.authMode)) return [];
    if (profile.authMode === 'api-key' && !profile.apiKey) return [];
    if (profile.authMode === 'codex' && config.codexAuth?.loggedIn === false) return [];
    if (profile.authMode === 'codex' && profile.baseUrl.replace(/\/+$/, '') !== 'https://chatgpt.com/backend-api') return [];
    const connection = { authMode: profile.authMode, apiProtocol: profile.apiProtocol || 'chat-completions',
      baseUrl: profile.baseUrl, apiKey: profile.apiKey || '', model: profile.model };
    const identity = digest(connection);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ id, name: profile.name || id, connection, key: digest([identity, profile.revision || 0]),
      active: id === config.activeLlmProfileId || id === 'current' }];
  });
}

function hint(candidate) {
  // A starting preference, never presented as a measured speed or price.
  if (/(?:mini|nano|luna|haiku|flash|lite)/i.test(candidate.connection.model)) return 0;
  return candidate.active ? 1 : 2;
}
const observationKey = (home, candidate, task) => JSON.stringify([home, candidate.key, task]);
function measurement(config, home, candidate, task, now) {
  const runtime = observations.get(observationKey(home, candidate, task));
  const stored = config.extraFast?.measurements?.[candidate.key]?.[task];
  const latest = !runtime ? stored : !stored || runtime.at >= stored.at ? runtime : stored;
  return latest && Number.isFinite(latest.at) && now - latest.at < MAX_AGE_MS ? latest : null;
}

export function rankJudgeCandidates(config, task, { home = resolveRuntimePaths().home, now = Date.now() } = {}) {
  return judgeCandidates(config).map(candidate => ({ ...candidate, measurement: measurement(config, home, candidate, task, now) }))
    .filter(candidate => !candidate.measurement?.retryAt || candidate.measurement.retryAt <= now)
    .sort((a, b) => {
      const am = a.measurement, bm = b.measurement;
      if (am?.ok && bm?.ok) return am.latencyMs - bm.latencyMs;
      if (am?.ok !== bm?.ok) return am?.ok ? -1 : bm?.ok ? 1 : 0;
      return hint(a) - hint(b) || a.id.localeCompare(b.id);
    });
}

function publicChoice(candidate) {
  if (!candidate) return null;
  const m = candidate.measurement;
  return { profileId: candidate.id, name: candidate.name, model: candidate.connection.model,
    basis: m?.ok ? 'measured' : 'preference', latencyMs: m?.ok ? m.latencyMs : null,
    reportedModel: m?.ok ? m.reportedModel || '' : '', measuredAt: m?.ok ? new Date(m.at).toISOString() : null };
}

export function publicExtraFast(config = {}, options = {}) {
  return { enabled: config.extraFast?.enabled === true, revision: config.extraFast?.revision || 0,
    candidateCount: judgeCandidates(config).length, timeoutMs: JUDGE_TIMEOUT_MS,
    assignments: Object.fromEntries(Object.keys(labels).map(task => [task,
      config.extraFast?.enabled === true ? publicChoice(rankJudgeCandidates(config, task, options)[0]) : null])) };
}

async function requestLabel(candidate, { task, systemPrompt, messages, signal, reply, timeoutMs }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  let timer, rejectAbort;
  const interrupted = new Promise((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason || new Error('判断已中断'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    timer = setTimeout(() => controller.abort(new Error('判断超时')), timeoutMs);
  });
  let receipt;
  try {
    const text = await Promise.race([interrupted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return reply({ ...candidate.connection, systemPrompt, messages, signal: controller.signal,
        providerProfile: 'fast', maxTokens: 1024, nativeWebSearchEnabled: false,
        nativeImageGenerationEnabled: false, workspacePath: null,
        onProviderResponse: value => { receipt = value; }, cacheScope: `extra-fast:${task}` });
    })]);
    const label = String(text || '').trim().toLowerCase();
    if (!labels[task]?.includes(label)) throw new Error('判断格式不正确');
    if (receipt?.simulated) throw new Error('模拟请求不计入实际分配');
    return { label, reportedModel: String(receipt?.reportedModel || '').slice(0, 200), usage: receipt?.usage || null,
      transport: receipt?.transport || '' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

// One bounded request, no fan-out or retry chain on the conversation path.
// Failure returns a conservative rule result, never a fabricated confidence.
export async function judgeFast({ config, task, systemPrompt, messages, fallback, signal,
  onDecision, home = resolveRuntimePaths().home, reply = createOpenAICompatibleReply,
  timeoutMs = JUDGE_TIMEOUT_MS, now = Date.now } = {}) {
  if (config?.extraFast?.enabled !== true) return null;
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext({ home, signal }), () =>
    judgeFast({ config, task, systemPrompt, messages, fallback, signal, onDecision, home, reply, timeoutMs, now }));
  signal ||= currentRequestContext()?.signal;
  signal?.throwIfAborted();
  const candidate = rankJudgeCandidates(config, task, { home, now: now() })[0];
  const emit = value => { try { onDecision?.(value); } catch { /* diagnostic only */ } };
  if (!candidate) { emit({ task, source: 'fallback', reason: 'no-available-connection' }); return fallback; }
  const key = digest([home, candidate.key, task, systemPrompt, messages]);
  const cached = answers.get(key);
  if (cached && now() - cached.at < COOLDOWN_MS) {
    emit({ task, source: 'cache', model: candidate.connection.model, profileId: candidate.id });
    return cached.label;
  }
  const start = now();
  try {
    const result = await requestLabel(candidate, { task, systemPrompt, messages, signal, reply, timeoutMs });
    const sample = { ok: true, at: now(), latencyMs: Math.max(0, now() - start), reportedModel: result.reportedModel };
    put(observations, observationKey(home, candidate, task), sample);
    put(answers, key, { label: result.label, at: now() });
    emit({ task, source: 'model', profileId: candidate.id, model: candidate.connection.model, ...sample,
      usage: result.usage, transport: result.transport });
    return result.label;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    put(observations, observationKey(home, candidate, task), { ok: false, at: now(), retryAt: now() + COOLDOWN_MS });
    emit({ task, source: 'fallback', profileId: candidate.id, model: candidate.connection.model, latencyMs: Math.max(0, now() - start), reason: 'failed-or-timeout' });
    return fallback;
  }
}

// Synthetic text only. At most three configured models × two short requests;
// these smoke tests check routing/output and latency, not classifier accuracy.
export async function probeJudges(config, { signal, reply = createOpenAICompatibleReply,
  home = resolveRuntimePaths().home, timeoutMs = JUDGE_TIMEOUT_MS, now = Date.now } = {}) {
  if (config.extraFast?.enabled !== true) return {};
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext({ home, signal }), () =>
    probeJudges(config, { signal, reply, home, timeoutMs, now }));
  // An explicit re-test must be allowed to recover a connection in cooldown.
  const candidates = judgeCandidates(config).sort((a, b) => hint(a) - hint(b) || a.id.localeCompare(b.id)).slice(0, MAX_CANDIDATES);
  const measurements = {};
  await Promise.all(candidates.map(async candidate => {
    const samples = {};
    for (const task of ['intent', 'addressal']) {
      signal?.throwIfAborted();
      const start = now();
      try {
        const result = await requestLabel(candidate, { task, signal, reply, timeoutMs,
          systemPrompt: task === 'intent'
            ? 'Classify into factual, creative, coding, high-stakes, casual. Output exactly one label. Medical dosage advice is high-stakes.'
            : 'Decide if a group message addresses the bot Melo. Output yes or no. Messages addressed to another human are no.',
          messages: [{ role: 'user', content: task === 'intent' ? 'Should I double my medication dosage today?' : '@Alice, shall we meet for dinner at seven?' }] });
        if (result.label !== (task === 'intent' ? 'high-stakes' : 'no')) throw new Error('基础判断未通过');
        samples[task] = { ok: true, at: now(), latencyMs: Math.max(0, now() - start), reportedModel: result.reportedModel };
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        samples[task] = { ok: false, at: now(), retryAt: now() + COOLDOWN_MS };
      }
    }
    measurements[candidate.key] = samples;
  }));
  return measurements;
}
