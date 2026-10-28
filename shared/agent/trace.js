import { AGENT_LOOP_CONTRACT, contractRegExp } from './loopContract.js';
import { startTurn, advanceTurn } from './turn.js';

export const TRACE_LIMITS = Object.freeze({ maxEvents: 10000, maxRunBytes: 64 * 1024 * 1024, maxEventBytes: 64 * 1024, maxArtifactBytes: 4 * 1024 * 1024, maxQueue: 128, flushMs: 100, retentionDays: 30, maxRuns: 200, maxBytes: 500 * 1024 * 1024 });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const patterns = AGENT_LOOP_CONTRACT.redaction.patterns.map(entry => [contractRegExp(entry, 'g'), entry.replacement]);
const sensitive = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|proxy[_-]?authorization|cookie|set-cookie|password|client[_-]?secret|secret|x-api-key)$/iu;
const hidden = /^(?:encrypted_content|reasoning_content|thinking|b64_json|image_base64|base64|jpeg)$/iu;
export function traceText(value) {
  let out = String(value);
  for (const [pattern, replacement] of patterns) out = out.replace(pattern, replacement);
  out = out.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/gu, (match, separator, key) => {
    let decoded = key; try { decoded = decodeURIComponent(key); } catch {}
    return /token|key|secret|password|auth|signature/iu.test(decoded) ? separator + key + '=[redacted]' : match;
  });
  return out;
}
export function traceSnapshot(value) {
  let nodes = 0, truncated = false, mediaOmitted = false, redacted = false;
  const seen = new Set();
  function clean(value, depth = 0, key = '', kind = 'data', secretDefinition = false) {
    if (++nodes > 50000 || depth > 32) { truncated = true; return '[truncated]'; }
    if (sensitive.test(key) && kind !== 'schema-property' || secretDefinition && ['default','example','examples','enum','const'].includes(key)) { redacted = true; return '[redacted]'; }
    if (hidden.test(key)) { mediaOmitted ||= /base64|jpeg|b64/iu.test(key); redacted = true; return '[omitted]'; }
    if (value == null) return null;
    if (typeof value === 'string') {
      if (/^data:[^,]*,/iu.test(value)) { mediaOmitted = true; return '[media omitted]'; }
      if (value.length > 1048576) { truncated = true; value = value.slice(0, 1048576); }
      // Tool argument/output strings often contain encoded JSON. Sanitize the
      // structured value as well, not just its outer property name.
      if (/^\s*[\[{]/u.test(value) && /[\]}]\s*$/u.test(value)) {
        try { return JSON.stringify(clean(JSON.parse(value), depth + 1)); } catch {}
      }
      const next = traceText(value); if (next !== value) redacted = true;
      return next;
    }
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'object') return '[unsupported]';
    if (seen.has(value)) { truncated = true; return '[circular]'; }
    seen.add(value);
    let next;
    if (Array.isArray(value)) {
      if (value.length > 10000) truncated = true;
      next = value.slice(0, 10000).map(item => clean(item, depth + 1, '', kind, secretDefinition));
    } else if (value.type === 'thinking' || value.type === 'redacted_thinking') {
      redacted = true; next = { type: value.type, omitted: true };
    } else if (['image_url', 'input_image', 'image', 'input_video'].includes(value.type)) {
      mediaOmitted = true; next = { type: value.type, omitted: true };
    } else if (value.type === 'reasoning') {
      next = Object.fromEntries(['type', 'id', 'status', 'summary'].filter(k => Object.hasOwn(value, k)).map(k => [k, clean(value[k], depth + 1, k)]));
    } else {
      const keys = Object.keys(value).sort();
      if (keys.length > 2048) truncated = true;
      next = Object.fromEntries(keys.slice(0, 2048).map(k => {
        const schema = kind !== 'data';
        const schemaRoot = ['parameters','input_schema'].includes(k) && value[k]?.type === 'object' && value[k]?.properties && typeof value[k].properties === 'object';
        const childKind = kind === 'property-map' ? 'schema-property' : schema && k === 'properties' ? 'property-map' : schema || schemaRoot ? 'schema' : 'data';
        return [k, clean(value[k], depth + 1, k, childKind, secretDefinition || kind === 'schema-property' && sensitive.test(key))];
      }));
    }
    seen.delete(value); return next;
  }
  let content = clean(value);
  let json = JSON.stringify(content);
  if (json.length > 1048576) { truncated = true; content = { truncated: true, preview: json.slice(0, 1000000) }; json = JSON.stringify(content); }
  return { json, truncated, mediaOmitted, redacted };
}
function invalid(message) { throw Object.assign(new Error(message), { code: 'INVALID_TRACE' }); }
export function traceOperation(input) {
  if (input.action === 'limits') return TRACE_LIMITS;
  if (input.action === 'create') {
    const context = input.context || {};
    if (!id(context.traceId) || !id(context.runId) || !Number.isFinite(input.now)) invalid('Invalid trace identity/clock.');
    return { trace: { schemaVersion: 1, ...context, sequence: 0, startedMono: input.now, lastMono: input.now, closed: false, truncated: false,
      maxEvents: Number.isInteger(input.maxEvents) ? Math.max(1, Math.min(TRACE_LIMITS.maxEvents, input.maxEvents)) : TRACE_LIMITS.maxEvents }, record: null, artifact: null };
  }
  const previous = input.trace, event = input.event;
  if (previous?.schemaVersion !== 1 || !id(previous.traceId) || !event || !/^[a-z][a-z0-9_.-]{1,80}$/u.test(event.type || '') || !Number.isFinite(input.now) || input.now < previous.lastMono) invalid('Invalid trace event or non-monotonic clock.');
  if (previous.closed) return { trace: previous, record: null, artifact: null };
  const context = { ...previous, ...(input.context || {}) };
  if (!id(context.runId) || context.traceId !== previous.traceId) invalid('Trace scope changed root identity.');
  const rootFinished = event.type === 'run.finished' && context.runId === previous.runId;
  if (previous.truncated && !rootFinished) return { trace: previous, record: null, artifact: null };
  const over = previous.sequence >= previous.maxEvents && !rootFinished;
  const type = over ? 'trace.truncated' : event.type;
  const sequence = previous.sequence + 1;
  const metadata = traceSnapshot(over ? { reason: 'event_limit' } : event.data || {});
  const artifact = Object.hasOwn(event, 'payload') && !over ? traceSnapshot(event.payload) : null;
  const small = metadata.json.length > 8000 ? { truncated: true, preview: metadata.json.slice(0, 8000) } : JSON.parse(metadata.json);
  const record = { schemaVersion: 1, eventId: previous.traceId + '/' + sequence, traceId: previous.traceId, runId: context.runId,
    parentRunId: context.parentRunId || null, scopeId: context.scopeId || 'loop', spanId: event.spanId || context.spanId || context.runId,
    parentSpanId: event.parentSpanId || context.parentSpanId || null, sequence, round: Number.isInteger(event.round) ? event.round : null,
    attempt: Number.isInteger(event.attempt) ? event.attempt : null, type,
    at: typeof input.at === 'string' ? input.at : null, elapsedMs: input.now - previous.startedMono, data: small,
    capture: { truncated: over || metadata.truncated || metadata.json.length > 8000 || artifact?.truncated === true, mediaOmitted: metadata.mediaOmitted || artifact?.mediaOmitted === true, redacted: metadata.redacted || artifact?.redacted === true } };
  return { trace: { ...previous, sequence, lastMono: input.now, closed: rootFinished, truncated: previous.truncated || over }, record, artifact };
}
const summary = state => ({ status: state.status, reason: state.reason, round: state.rounds, errors: state.errors, pending: state.pending, permitted: state.permitted, awaitingModel: state.awaitingModel, stagnant: state.stagnant, deviceProgress: state.deviceProgress || null, limits: state.limits });
export function tracedStart(turn) {
  const state = startTurn(turn);
  return { state, events: [{ type: 'loop.transition', data: { from: null, to: summary(state) } }, { type: 'capabilities.snapshot', payload: { allowedTools: state.allowedTools, requiredTools: state.requiredTools, toolDependencies: state.toolDependencies }, data: { source: 'loop-admission', toolSchemaCaptured: false } }] };
}
export function tracedAdvance(previous, event, now) {
  const state = advanceTurn(previous, event, now);
  const events = [{ type: 'loop.transition', round: state.rounds, data: { event: event.type, from: summary(previous), to: summary(state) } }];
  if (event.type === 'calls') for (const call of event.calls) {
    const fields = { round: state.rounds, spanId: 'tool:' + call.id, data: { callId: call.id, name: call.name } };
    events.push({ ...fields, type: 'tool.requested', payload: call.arguments });
    events.push({ ...fields, type: state.permitted.includes(call.id) ? 'tool.admitted' : 'tool.rejected', data: { ...fields.data, reason: state.rejections?.[call.id] || null, effectState: 'not_started' } });
  }
  if (event.type === 'result') events.push({ type: 'loop.receipt', round: state.rounds, data: { callId: event.callId, ok: event.ok, code: event.code || null, captureLevel: 'reducer-summary' } });
  return { state, events };
}
