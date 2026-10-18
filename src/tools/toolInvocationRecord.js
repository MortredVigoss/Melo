// Tool invocation record (2026-10-17 design audit T-D / option D1).
//
// One object per tool call, built in the runner's tool loop once the model-
// facing output string is known, and projected three ways from the same
// record: the `tool_calls_start` / `tool_calls_done` SSE events (UI), the
// persisted `assistantMessage.toolResults` entry (history / compaction) and
// the execution scene operation (observeTool). Records are appended to
// `<home>/desktop/execution-scenes/<runId>.tools.jsonl` (0o600) so a
// cancelled or failed turn can be replayed as a text trace (D2) and so
// devtools can see exactly what the model saw.
//
// Pure except for the jsonl writer/reader; no imports from services/state.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordFailure } from '../runtime/failureCounters.js';
import { toolCodeHint } from './toolResult.js';
import { formatToolResult } from './parser.js';
import { redactSecretsInText } from './secretRedaction.js';

export const MAX_MODEL_FACING_OUTPUT_CHARS = 8000;
export const MAX_REDACTED_STRING_CHARS = 400;
const MAX_META_JSON_CHARS = 2000;
const MAX_OUTPUT_PREVIEW_CHARS = 500;
const MAX_ARRAY_ITEMS = 100;
const MAX_DEPTH = 8;
const SENSITIVE_KEY = /key|token|secret|password|authorization|cookie/i;
const DATA_URL = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/;
const CANONICAL_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const VALID_RUN_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function redactValue(value, depth, seen, maxString) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    const data = DATA_URL.exec(value);
    if (data) {
      const payload = data[3];
      const bytes = /;base64/i.test(data[2] || '') ? Math.floor(payload.length * 3 / 4) : payload.length;
      return `data:${data[1] || 'application/octet-stream'} (${bytes} bytes)`;
    }
    // Bug audit T6: secrets inside values (Bearer …, ?token=, KEY=sk-…) are
    // redacted too, not only secret-looking keys.
    const text = redactSecretsInText(value);
    return text.length > maxString ? `${text.slice(0, maxString)}…` : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => redactValue(item, depth + 1, seen, maxString));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…(+${value.length - MAX_ARRAY_ITEMS} items)`);
    return items;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(item, depth + 1, seen, maxString);
  }
  return out;
}

/**
 * Deep copy of tool arguments that is safe to show, send over SSE and write
 * to disk: secret-looking keys become '[redacted]', long strings are cut,
 * data: URLs become `data:<mime> (<n> bytes)`.
 */
export function redactToolArgs(args, { maxString = MAX_REDACTED_STRING_CHARS } = {}) {
  if (!args || typeof args !== 'object') return {};
  const redacted = redactValue(args, 0, new WeakSet(), maxString);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted) ? redacted : {};
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return JSON.stringify(`[binary ${value.byteLength}]`);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** sha256 of the canonical JSON of the raw args, first 16 hex characters. */
export function hashToolArgs(args) {
  let text;
  try { text = canonicalJson(args && typeof args === 'object' ? args : {}); }
  catch { text = '{}'; }
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Short `key=value` digest of (redacted) args for traces and pills:
 * scalars only, first `maxEntries` keys, each value cut to `maxValue`.
 */
export function toolArgsDigest(args, { maxEntries = 3, maxValue = 60, maxChars = 120 } = {}) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    parts.push(`${key}=${text.length > maxValue ? `${text.slice(0, maxValue)}…` : text}`);
    if (parts.length >= maxEntries) break;
  }
  const digest = parts.join(', ');
  return digest.length > maxChars ? `${digest.slice(0, maxChars)}…` : digest;
}

const toIso = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
};

function envelopeOf(result) {
  const ok = result?.ok === true;
  const status = ['ok', 'empty', 'error'].includes(result?.status) ? result.status : ok ? 'ok' : 'error';
  const rawCode = result?.code || (status === 'error' ? result?.error : undefined);
  const code = CANONICAL_CODE.test(String(rawCode || '')) ? String(rawCode) : status === 'error' ? 'UNKNOWN' : undefined;
  const envelope = { ok, status, ...(code ? { code } : {}) };
  const hint = toolCodeHint(code);
  if (hint) envelope.hint = hint;
  const preview = typeof result?.output === 'string' ? redactSecretsInText(result.output.replace(/\s+/g, ' ').trim()).slice(0, MAX_OUTPUT_PREVIEW_CHARS) : '';
  if (preview) envelope.outputPreview = preview;
  if (result?.meta && typeof result.meta === 'object') {
    const meta = redactToolArgs(result.meta, { maxString: 200 });
    let json = '';
    try { json = JSON.stringify(meta); } catch { json = ''; }
    if (json && json.length <= MAX_META_JSON_CHARS) envelope.meta = meta;
    else if (json) envelope.meta = { truncated: true, keys: Object.keys(meta).slice(0, 20) };
  }
  return envelope;
}

/**
 * @param {Object} input
 * @param {string} input.runId
 * @param {number} input.iteration            tool-loop iteration (0-based)
 * @param {{id:string,name:string,arguments?:Object}} input.call  parsed model call
 * @param {Object} [input.args]               raw args (defaults to call.arguments)
 * @param {Object} input.result               finalised executor envelope
 * @param {string} [input.modelFacingOutput]  exact string sent back to the model
 * @param {number|string} [input.startedAt]
 * @param {number|string} [input.finishedAt]
 * @param {number|null} [input.parallelGroup]
 */
export function buildToolInvocationRecord({ runId, iteration, call, args, result, modelFacingOutput, startedAt, finishedAt, parallelGroup } = {}) {
  const rawArgs = args && typeof args === 'object' ? args : call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const startedIso = toIso(startedAt) || new Date().toISOString();
  const finishedIso = toIso(finishedAt) || startedIso;
  const durationMs = Math.max(0, Date.parse(finishedIso) - Date.parse(startedIso));
  // T6: the jsonl line keeps what the model saw, minus secret values.
  const output = typeof modelFacingOutput === 'string' ? redactSecretsInText(modelFacingOutput) : '';
  const record = {
    version: 1,
    runId: typeof runId === 'string' ? runId : '',
    iteration: Number.isInteger(iteration) ? iteration : 0,
    callId: typeof call?.id === 'string' ? call.id : '',
    toolId: typeof call?.name === 'string' ? call.name : '',
    argsRedacted: redactToolArgs(rawArgs),
    argsHash: hashToolArgs(rawArgs),
    resultEnvelope: envelopeOf(result),
    modelFacingOutput: output.length > MAX_MODEL_FACING_OUTPUT_CHARS ? output.slice(0, MAX_MODEL_FACING_OUTPUT_CHARS) : output,
    startedAt: startedIso,
    finishedAt: finishedIso,
    durationMs,
    parallelGroup: Number.isInteger(parallelGroup) ? parallelGroup : null,
  };
  if (output.length > MAX_MODEL_FACING_OUTPUT_CHARS) record.modelFacingOutputTruncated = true;
  return record;
}

/**
 * Map call id → the exact output string the tool-result message carries for
 * it. Native (Responses) messages carry one `function_call_output` per call;
 * the legacy XML message is rebuilt per call with the same formatter and
 * options `createFunctionCallingSession().append` uses, so the bytes match.
 */
export function modelFacingOutputsFor(toolResultMessage, pairs = [], { maxOutputChars = MAX_MODEL_FACING_OUTPUT_CHARS } = {}) {
  const outputs = new Map();
  if (Array.isArray(toolResultMessage?.functionCallOutputs)) {
    for (const item of toolResultMessage.functionCallOutputs) {
      if (item && typeof item.call_id === 'string') outputs.set(item.call_id, String(item.output ?? ''));
    }
    return outputs;
  }
  // Anthropic / chat-completions IR results (design audit E1) carry the same
  // model-facing envelope JSON under `toolResults[].output`.
  if (Array.isArray(toolResultMessage?.toolResults)) {
    for (const item of toolResultMessage.toolResults) {
      if (item && typeof item.callId === 'string') outputs.set(item.callId, String(item.output ?? ''));
    }
    return outputs;
  }
  for (const { call, result } of pairs) {
    if (!call || typeof call.id !== 'string') continue;
    try { outputs.set(call.id, formatToolResult(call, result || {}, { maxOutputChars })); } catch {}
  }
  return outputs;
}

export function toolRecordsPath(home, runId) {
  if (!home || !VALID_RUN_ID.test(String(runId || ''))) return null;
  return join(home, 'desktop', 'execution-scenes', `${runId}.tools.jsonl`);
}

let writeFailureLogged = false;

/** Append one JSON line. Never throws: failures are counted, not raised. */
export function appendToolInvocationRecord(record, { home } = {}) {
  try {
    const file = toolRecordsPath(home, record?.runId);
    if (!file) throw new Error(`Invalid tool record target (home=${home ? 'set' : 'missing'}, runId=${record?.runId})`);
    mkdirSync(join(home, 'desktop', 'execution-scenes'), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    recordFailure('tool:invocation-record', error, { log: !writeFailureLogged });
    writeFailureLogged = true;
    return false;
  }
}

/** Records of one run, oldest first. Missing file or bad id → []. */
export async function readToolInvocationRecords(runId, { home } = {}) {
  const file = toolRecordsPath(home, runId);
  if (!file) return [];
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && record.runId === runId) records.push(record);
    } catch {}
  }
  return records;
}
