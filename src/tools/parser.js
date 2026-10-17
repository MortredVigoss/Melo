/**
 * Tool call parser for ReAct/XML format.
 *
 * The model emits tool calls as XML blocks inside its text output:
 *
 *   <tool_call>
 *   {"id":"call_001","name":"bash","arguments":{"command":"ls -la"}}
 *   </tool_call>
 *
 * This module extracts those blocks, parses the JSON, and returns structured
 * ToolCallRequest objects.  Any text outside <tool_call> blocks is returned as
 * the "thinking" / prose portion of the model response.
 *
 * Design goals:
 *   - Works with plain text output from any model (codex, api-key, local)
 *   - Tolerates partial or malformed JSON with graceful fallback
 *   - Handles multiple tool calls in a single response
 */

import { toolCodeHint } from './toolResult.js';
import { randomUUID } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ToolCallRequest
 * @property {string} id        - unique call id (from model or generated)
 * @property {string} name      - tool id / name
 * @property {Object} arguments - parsed argument object
 * @property {string} raw       - original matched block text (for debugging)
 */

/**
 * @typedef {Object} ParsedModelResponse
 * @property {string}            thinking   - prose text with <tool_call> blocks removed
 * @property {ToolCallRequest[]} toolCalls  - extracted and parsed tool calls
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a raw model response string into prose + structured tool calls.
 *
 * @param {string} text  - raw model output
 * @returns {ParsedModelResponse}
 */
export function parseModelResponse(text = '') {
  const toolCalls = [];
  const blocks = [];

  let match;
  // Reset lastIndex in case the regex was used before
  TOOL_CALL_RE.lastIndex = 0;

  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    blocks.push({ start: match.index, end: match.index + match[0].length });
    const inner = match[1].trim();
    const parsed = safeParseToolCall(inner);
    if (parsed) {
      toolCalls.push({
        id: parsed.id || generateCallId(),
        name: normalizeToolName(parsed.name || parsed.tool || ''),
        arguments: parsed.arguments ?? parsed.args ?? {},
        raw: inner,
      });
    }
  }

  // Remove all <tool_call>…</tool_call> spans from the text to get prose
  let thinking = text;
  if (blocks.length) {
    const parts = [];
    let cursor = 0;
    for (const { start, end } of blocks) {
      parts.push(text.slice(cursor, start));
      cursor = end;
    }
    parts.push(text.slice(cursor));
    thinking = parts.join('').trim();
  }

  return { thinking, toolCalls };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Attempt to parse tool call JSON.
 * Falls back to key extraction for slightly malformed JSON.
 */
function safeParseToolCall(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract the name at minimum so we can report the failed call
    const nameMatch = raw.match(/"(?:name|tool)"\s*:\s*"([^"]+)"/);
    if (nameMatch) {
      return { name: nameMatch[1], arguments: {}, _parseError: true };
    }
    return null;
  }
}

/**
 * Normalise tool names: lowercase, replace spaces/hyphens with underscores.
 */
function normalizeToolName(name) {
  return name.toLowerCase().replace(/[\s-]+/g, '_');
}

function generateCallId() {
  return `call_${randomUUID().slice(0, 8)}`;
}

// ─── Result formatter ─────────────────────────────────────────────────────────

/**
 * Format one evidenceTrail item as compact human text the LLM can parse.
 * Examples:
 *   `jina: ok (220ms)`
 *   `jina: fail (timeout, 3500ms)`
 *   `direct: skip`
 *   `yt-dlp: fail (http-403)`
 * Drops the trailing `()` when there's no reason / latency to report.
 */
function _formatEvidenceTrailItem(item) {
  if (!item || typeof item !== 'object') return '';
  const tier = String(item.tier || '?');
  const outcome = String(item.outcome || '?');
  const parts = [];
  if (item.reason) parts.push(String(item.reason));
  if (typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs)) {
    parts.push(`${Math.round(item.latencyMs)}ms`);
  }
  return parts.length
    ? `${tier}: ${outcome} (${parts.join(', ')})`
    : `${tier}: ${outcome}`;
}

/**
 * Decide whether to surface the evidenceTrail in the model prompt.
 *
 * The trail is most useful for *self-correction*: an agent that sees
 * "last call walked tier1→tier2→fail" can pick a different tool or
 * widen the query next time.  Surfacing it on every successful single-
 * tier call is noise.  So we include it only when:
 *   - the tool reported failure (`ok === false`), OR
 *   - the trail has ≥ 2 entries (a fallback happened — informative even
 *     if the final result was OK, since the agent learns which tiers
 *     are flaky for this domain).
 *
 * Exported for tests + future callers that want the same heuristic.
 */
export function _shouldEmitEvidenceTrail(result) {
  if (!result || !Array.isArray(result.evidenceTrail) || result.evidenceTrail.length === 0) {
    return false;
  }
  if (result.ok === false) return true;
  return result.evidenceTrail.length >= 2;
}

/**
 * Format a tool result back into the assistant message format expected by the model.
 *
 * The model will see:
 *   <tool_result id="call_001" name="bash" ok="true">
 *   <output>...</output>
 *   <evidence_trail>jina: fail (timeout, 3500ms) → direct: ok (220ms)</evidence_trail>
 *   </tool_result>
 *
 * The `<evidence_trail>` block is included only when it's informative
 * (failure path OR multi-tier fallback — see `_shouldEmitEvidenceTrail`).
 * Tools that never populate `evidenceTrail` see no change.
 *
 * @param {ToolCallRequest} call
 * @param {import('./tool.js').ToolResult} result
 * @returns {string}
 */
export function formatToolResult(call, result, { maxOutputChars = Infinity } = {}) {
  const okAttr = result.ok ? 'true' : 'false';
  const raw = String(result.output ?? '');
  const output = raw.length > maxOutputChars
    ? `${raw.slice(0, maxOutputChars)}\n[Tool output truncated; request a narrower excerpt if needed.]`
    : raw;
  const status = result.status || (result.ok ? 'ok' : 'error');
  const code = result.code || (status === 'error' ? String(result.error || 'UNKNOWN') : '');
  const lines = [
    `<tool_result id="${escapeXml(call.id).replace(/"/g, '&quot;')}" name="${escapeXml(call.name).replace(/"/g, '&quot;')}" ok="${okAttr}" status="${status}"${code ? ` code="${escapeXml(code).replace(/"/g, '&quot;')}"` : ''}>`,
    `<output>${escapeXml(output)}</output>`,
  ];
  if (!result.ok && (result.error || code)) {
    lines.push(`<error>${escapeXml(code || result.error)}${result.meta?.detail ? `: ${escapeXml(String(result.meta.detail).slice(0, 300))}` : ''}</error>`);
  }
  const hint = toolCodeHint(code);
  if (hint && status !== 'ok') lines.push(`<hint>${escapeXml(hint)}</hint>`);
  if (_shouldEmitEvidenceTrail(result)) {
    const items = result.evidenceTrail
      .map(_formatEvidenceTrailItem)
      .filter(Boolean);
    if (items.length) {
      // " → " separator visually mirrors the chain semantics and is easy
      // for an LLM to tokenize back into ordered steps.
      lines.push(`<evidence_trail>${escapeXml(items.join(' → '))}</evidence_trail>`);
    }
  }
  lines.push('</tool_result>');
  return lines.join('\n');
}

/**
 * Format multiple tool results into a single user-role message content string.
 * @param {Array<{ call: ToolCallRequest, result: import('./tool.js').ToolResult }>} pairs
 * @returns {string}
 */
export function formatToolResultsMessage(pairs, options) {
  return pairs.map(({ call, result }) => formatToolResult(call, result, options)).join('\n\n');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
