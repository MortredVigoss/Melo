// Protocol adapter layer for function calling (design audit 2026-10-17, E1).
//
// One protocol-neutral intermediate representation (IR) of a tool turn:
//
//   assistant turn  { role:'assistant', text, toolCalls:[{ id, name, arguments }] }
//   results turn    { role:'tool',      toolResults:[{ callId, name, output }] }
//
// `name` is the wire function name the model saw (`functionName(tool.id)`),
// `arguments` is the raw JSON string the model produced and `output` is the
// model-facing JSON string from `toolOutput()`. The adapters below turn the IR
// into each provider's request shape and parse each provider's reply back into
// the IR. The loop message list keeps one message per IR turn:
//
//   responses        { role:'assistant', content, responseItems }            (byte-identical to the pre-E1 chain)
//                    { role:'user', content:'', isToolResult, functionCallOutputs }
//   anthropic /      { role:'assistant', content, toolCalls:[{ id, name, arguments, raw? }] }
//   chat-completions { role:'user', content:'', isToolResult, toolResults:[{ callId, name, output }] }
//   xml              plain text messages (parser.js)
//
// Pure module: no I/O, no registry access, no request-scope reads except the
// optional `env` passed to `resolveToolProtocol`.
import { formatToolResultsMessage } from './parser.js';

export const TOOL_PROTOCOLS = Object.freeze(['responses', 'chat-completions', 'anthropic', 'xml']);

const RESPONSES_HOSTS = /^api\.openai\.com$/i;
const ANTHROPIC_HOSTS = /^api\.anthropic\.com$/i;

function hostOf(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname; } catch { return ''; }
}

/**
 * Decide which tool protocol a connection speaks.
 *
 *   - `toolCalling:'legacy'`                        → 'xml' (always wins)
 *   - Codex OAuth / `apiProtocol:'responses'` /
 *     api.openai.com with a non-local auth mode    → 'responses'
 *   - `apiProtocol:'anthropic'` / api.anthropic.com → 'anthropic'
 *   - chat-completions (DeepSeek / Qwen / Ollama / local, anything else)
 *                                                  → 'chat-completions' only when opted in
 *                                                    (`toolCalling:'native'` or env MELO_CHAT_TOOLS=1),
 *                                                    otherwise 'xml' (default: local-model quality varies)
 *
 * The audio / realtime / gpt-3.5 exclusion from the old boolean is kept for the
 * OpenAI host so those models stay on the XML protocol.
 */
export function resolveToolProtocol(config = {}, env = {}) {
  if (config.toolCalling === 'legacy') return 'xml';
  if (config.authMode === 'codex' || config.apiProtocol === 'responses') return 'responses';
  const host = hostOf(config.baseUrl);
  if (config.apiProtocol === 'anthropic' || (!config.apiProtocol && ANTHROPIC_HOSTS.test(host))) return 'anthropic';
  if (/audio|realtime|gpt-3\.5/i.test(config.model || '')) return 'xml';
  if (config.authMode !== 'local' && RESPONSES_HOSTS.test(host)) return 'responses';
  const optedIn = config.toolCalling === 'native' || String(env?.MELO_CHAT_TOOLS || '') === '1';
  return optedIn ? 'chat-completions' : 'xml';
}

// ─── Definitions ─────────────────────────────────────────────────────────────

/**
 * Render compiled tools (`compileFunctionTool`) into the definition shape of
 * one protocol. Responses keeps the strict schema; Anthropic and
 * chat-completions receive the original (loose) schema because those
 * providers do not enforce strict mode and local models routinely omit
 * optional fields.
 */
export function toolDefinitionsForProtocol(compiledTools = [], protocol) {
  if (protocol === 'xml') return [];
  return compiledTools.map(entry => {
    const strict = entry.definition;
    const loose = entry.looseDefinition || strict;
    if (protocol === 'responses') return strict;
    if (protocol === 'anthropic') return { name: loose.name, description: loose.description, input_schema: loose.parameters };
    if (protocol === 'chat-completions') return { type: 'function', function: { name: loose.name, description: loose.description, parameters: loose.parameters } };
    throw new Error(`Unknown tool protocol: ${protocol}`);
  });
}

/** Apply Anthropic's prompt-cache breakpoint to the last tool definition. */
export function withAnthropicToolCache(tools = [], breakpoint = { type: 'ephemeral' }) {
  if (!tools.length) return tools;
  return tools.map((tool, index) => index === tools.length - 1 ? { ...tool, cache_control: breakpoint } : tool);
}

// ─── Parsing provider replies into the IR ────────────────────────────────────

function argumentString(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  try { return JSON.stringify(value); } catch { return ''; }
}

/**
 * Parse a provider reply object into `{ text, toolCalls:[{ id, name, arguments, raw }] }`.
 * Throws when the reply does not carry the requested protocol.
 */
export function parseAssistantResponse(raw, protocol) {
  if (!raw || typeof raw !== 'object' || raw.protocol !== protocol) throw new Error('Invalid model tool response.');
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (protocol === 'responses') {
    if (!Array.isArray(raw.responseItems)) throw new Error('Invalid model tool response.');
    const toolCalls = raw.responseItems.filter(item => item?.type === 'function_call')
      .map(item => ({ id: item.call_id, name: item.name, arguments: argumentString(item.arguments), raw: item }));
    return { text, toolCalls, responseItems: raw.responseItems };
  }
  if (protocol === 'chat-completions') {
    const message = raw.message && typeof raw.message === 'object' ? raw.message : null;
    if (!message) throw new Error('Invalid model tool response.');
    const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
      .filter(item => item && (item.type === 'function' || !item.type))
      .map(item => ({ id: item.id, name: item.function?.name, arguments: argumentString(item.function?.arguments), raw: item }));
    return { text, toolCalls, message };
  }
  if (protocol === 'anthropic') {
    if (!Array.isArray(raw.content)) throw new Error('Invalid model tool response.');
    const toolCalls = raw.content.filter(block => block?.type === 'tool_use')
      .map(block => ({ id: block.id, name: block.name, arguments: argumentString(block.input), raw: block }));
    return { text, toolCalls, content: raw.content };
  }
  throw new Error(`Unknown tool protocol: ${protocol}`);
}

// ─── Loop messages ───────────────────────────────────────────────────────────

export function isToolProtocolMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return (message.role === 'assistant' && Array.isArray(message.toolCalls))
    || (message.isToolResult === true && Array.isArray(message.toolResults));
}

/** Build the two loop messages for one IR turn in the given protocol. */
export function toLoopMessages({ text = '', toolCalls = [], toolResults = [] }, protocol, { responseItems } = {}) {
  if (protocol === 'responses') {
    const items = Array.isArray(responseItems) ? responseItems : [
      ...(text ? [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] : []),
      ...toolCalls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })),
    ];
    return [
      { role: 'assistant', content: text, responseItems: items },
      { role: 'user', content: '', isToolResult: true,
        functionCallOutputs: toolResults.map(result => ({ type: 'function_call_output', call_id: result.callId, output: result.output })) },
    ];
  }
  if (protocol === 'anthropic' || protocol === 'chat-completions') {
    return [
      { role: 'assistant', content: text, toolCalls: toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments, ...(call.raw ? { raw: call.raw } : {}) })) },
      { role: 'user', content: '', isToolResult: true, toolResults: toolResults.map(result => ({ callId: result.callId, name: result.name, output: result.output })) },
    ];
  }
  if (protocol === 'xml') {
    const blocks = toolCalls.map(call => {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { args = {}; }
      return `<tool_call>\n${JSON.stringify({ id: call.id, name: call.name, arguments: args })}\n</tool_call>`;
    });
    const pairs = toolResults.map(result => {
      let parsed = {};
      try { parsed = JSON.parse(result.output || '{}'); } catch { parsed = { ok: false, output: result.output }; }
      return { call: { id: result.callId, name: result.name || '' }, result: { ok: parsed.ok === true, status: parsed.status, code: parsed.code, error: parsed.error, output: String(parsed.output ?? '') } };
    });
    return [
      { role: 'assistant', content: [text, ...blocks].filter(Boolean).join('\n') },
      { role: 'user', content: formatToolResultsMessage(pairs), isToolResult: true },
    ];
  }
  throw new Error(`Unknown tool protocol: ${protocol}`);
}

function parseArguments(call) {
  try {
    const parsed = JSON.parse(call.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/**
 * Render one IR loop message (assistant-with-toolCalls or tool results) into
 * the provider's request messages. Returns `null` for ordinary messages so
 * callers can fall back to their normal content handling.
 */
export function renderToolMessage(message, protocol) {
  if (!isToolProtocolMessage(message)) return null;
  const text = typeof message.content === 'string' ? message.content : '';
  if (protocol === 'chat-completions') {
    if (message.role === 'assistant') {
      // Echo the assistant message exactly as received (`raw`), falling back
      // to a synthesized tool_call for rebuilt history.
      return [{ role: 'assistant', content: text,
        tool_calls: message.toolCalls.map(call => call.raw || { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }) }];
    }
    return message.toolResults.map(result => ({ role: 'tool', tool_call_id: result.callId, content: result.output }));
  }
  if (protocol === 'anthropic') {
    if (message.role === 'assistant') {
      return [{ role: 'assistant', content: [
        ...(text.trim() ? [{ type: 'text', text }] : []),
        ...message.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name,
          input: call.raw?.input && typeof call.raw.input === 'object' && !Array.isArray(call.raw.input) ? call.raw.input : parseArguments(call) })),
      ] }];
    }
    return [{ role: 'user', content: message.toolResults.map(result => ({ type: 'tool_result', tool_use_id: result.callId, content: result.output })) }];
  }
  if (protocol === 'responses' || protocol === 'xml') {
    // Re-render through the IR so a chain recorded by another protocol can
    // continue here.
    const ir = message.role === 'assistant'
      ? { text, toolCalls: message.toolCalls, toolResults: [] }
      : { text: '', toolCalls: [], toolResults: message.toolResults };
    const [assistant, results] = toLoopMessages(ir, protocol);
    return [message.role === 'assistant' ? assistant : results];
  }
  throw new Error(`Unknown tool protocol: ${protocol}`);
}

/** Render a whole loop message list for one protocol (plain messages pass through). */
export function toRequestMessages(messages = [], protocol) {
  return messages.flatMap(message => renderToolMessage(message, protocol) || [message]);
}

// ─── Persistence (protocol-neutral tool chain on the assistant message) ──────

export const TOOL_CHAIN_VERSION = 1;
const DEFAULT_CHAIN_OUTPUT_CHARS = 1500;
const DEFAULT_CHAIN_ARG_CHARS = 2000;
const DEFAULT_CHAIN_MAX_CHARS = 24000;
const CHAIN_TRUNCATED = '\n[Earlier tool output condensed for history; call the tool again for the full result.]';

function truncateOutput(output, maxChars) {
  const raw = String(output ?? '');
  if (raw.length <= maxChars) return raw;
  try {
    const parsed = JSON.parse(raw);
    const text = String(parsed.output ?? '');
    return JSON.stringify({ ...parsed, output: text.slice(0, Math.max(0, maxChars - 200)) + CHAIN_TRUNCATED });
  } catch {
    return raw.slice(0, maxChars) + CHAIN_TRUNCATED;
  }
}

/**
 * Bounded IR of every tool turn of one reply, persisted on the assistant
 * message (`metadata.toolChain`) so the chain can be rebuilt for any protocol
 * later. Arguments are expected to be redacted by the caller. Call ids stay
 * inside the chat that produced them.
 */
export function buildToolChainRecord(turns = [], { protocol, maxOutputChars = DEFAULT_CHAIN_OUTPUT_CHARS, maxArgChars = DEFAULT_CHAIN_ARG_CHARS, maxChars = DEFAULT_CHAIN_MAX_CHARS } = {}) {
  const rendered = turns.map(turn => ({
    text: String(turn.text ?? '').slice(0, 4000),
    toolCalls: (turn.toolCalls || []).map(call => {
      const args = argumentString(call.arguments);
      return { id: String(call.id), name: String(call.name), arguments: args.length > maxArgChars ? '{}' : args };
    }),
    toolResults: (turn.toolResults || []).map(result => ({ callId: String(result.callId), name: String(result.name || ''), output: truncateOutput(result.output, maxOutputChars) })),
  }));
  // Oldest turns are dropped first when the whole record would be too large.
  let kept = rendered;
  while (kept.length > 1 && JSON.stringify(kept).length > maxChars) kept = kept.slice(1);
  if (kept.length === 1 && JSON.stringify(kept).length > maxChars) {
    kept = [{ ...kept[0], toolResults: kept[0].toolResults.map(result => ({ ...result, output: truncateOutput(result.output, 300) })) }];
  }
  return { version: TOOL_CHAIN_VERSION, protocol: protocol || 'unknown', turns: kept, truncated: kept.length !== rendered.length };
}

/** Rebuild loop messages for `protocol` from a persisted tool chain record. */
export function toolChainToMessages(toolChain, protocol) {
  if (!toolChain || !Array.isArray(toolChain.turns)) return [];
  return toolChain.turns.flatMap(turn => toLoopMessages({
    text: String(turn.text ?? ''),
    toolCalls: (turn.toolCalls || []).map(call => ({ id: String(call.id), name: String(call.name), arguments: argumentString(call.arguments) })),
    toolResults: (turn.toolResults || []).map(result => ({ callId: String(result.callId), name: String(result.name || ''), output: String(result.output ?? '') })),
  }, protocol));
}
