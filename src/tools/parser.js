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
 * Format a tool result back into the assistant message format expected by the model.
 *
 * The model will see:
 *   <tool_result id="call_001" name="bash" ok="true">
 *   <output>...</output>
 *   </tool_result>
 *
 * @param {ToolCallRequest} call
 * @param {import('./tool.js').ToolResult} result
 * @returns {string}
 */
export function formatToolResult(call, result) {
  const okAttr = result.ok ? 'true' : 'false';
  const lines = [
    `<tool_result id="${call.id}" name="${call.name}" ok="${okAttr}">`,
    `<output>${escapeXml(result.output ?? '')}</output>`,
  ];
  if (!result.ok && result.error) {
    lines.push(`<error>${escapeXml(result.error)}</error>`);
  }
  lines.push('</tool_result>');
  return lines.join('\n');
}

/**
 * Format multiple tool results into a single user-role message content string.
 * @param {Array<{ call: ToolCallRequest, result: import('./tool.js').ToolResult }>} pairs
 * @returns {string}
 */
export function formatToolResultsMessage(pairs) {
  return pairs.map(({ call, result }) => formatToolResult(call, result)).join('\n\n');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
