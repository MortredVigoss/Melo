import { compileFunctionTool } from './functionSchema.js';
import { toolCodeHint } from './toolResult.js';
import { parseModelResponse, formatToolResultsMessage, _shouldEmitEvidenceTrail } from './parser.js';

export const MAX_FUNCTION_CALLS_PER_RESPONSE = 32;

export function supportsResponsesFunctions(config = {}) {
  if (config.toolCalling === 'legacy') return false;
  if (config.authMode === 'codex' || config.apiProtocol === 'responses') return true;
  if (config.apiProtocol === 'anthropic' || /audio|realtime|gpt-3\.5/i.test(config.model || '')) return false;
  try { return config.authMode !== 'local' && new URL(config.baseUrl).hostname === 'api.openai.com'; }
  catch { return false; }
}

export function modelReplyText(reply) {
  return typeof reply === 'string' ? reply : typeof reply?.text === 'string' ? reply.text : '';
}

function toolOutput(result, maxOutputChars) {
  const raw = String(result.output ?? '');
  const status = result.status || (result.ok === true ? 'ok' : 'error');
  const code = result.code || (status === 'error' ? String(result.error || 'UNKNOWN').slice(0, 64) : undefined);
  const hint = toolCodeHint(code);
  return JSON.stringify({ ok: result.ok === true, status,
    ...(code ? { code, ...(status === 'error' ? { error: code } : {}) } : {}),
    output: raw.length > maxOutputChars ? raw.slice(0, maxOutputChars) + '\n[Tool output truncated; request a narrower excerpt if needed.]' : raw,
    ...(hint ? { hint } : {}),
    ...(result.meta?.detail ? { detail: String(result.meta.detail).slice(0, 300) } : {}),
    ...(_shouldEmitEvidenceTrail(result) ? { evidenceTrail: result.evidenceTrail.slice(0, 20).map(item => ({
      tier: String(item?.tier || '').slice(0, 100), outcome: String(item?.outcome || '').slice(0, 100),
      ...(item?.reason ? { reason: String(item.reason).slice(0, 300) } : {}),
      ...(Number.isFinite(item?.latencyMs) ? { latencyMs: item.latencyMs } : {}),
    })) } : {}),
  });
}

const CONDENSED_MARKER = '[Earlier tool output condensed to fit the context budget; call the tool again for the full result.]';

function condenseOutput(outputJson, maxChars) {
  try {
    const parsed = JSON.parse(outputJson);
    const text = String(parsed.output ?? '');
    if (text.length <= maxChars) return outputJson;
    return JSON.stringify({ ...parsed, output: text.slice(0, maxChars) + '\n' + CONDENSED_MARKER });
  } catch {
    return outputJson.length > maxChars ? outputJson.slice(0, maxChars) + '\n' + CONDENSED_MARKER : outputJson;
  }
}

/**
 * Shrink older tool results inside the current turn's chain so a long tool
 * loop can keep going instead of failing with CONTEXT_BUDGET_EXCEEDED after
 * the tools already ran (2026-10-17 audit C-8). The newest `keepRecentResults`
 * result messages are left intact; call ids are never touched so the
 * Responses chain stays valid.
 */
export function compactToolChain(messages = [], { keepRecentResults = 2, maxOutputChars = 600 } = {}) {
  const resultIndices = [];
  messages.forEach((message, index) => { if (message?.isToolResult) resultIndices.push(index); });
  const protect = new Set(resultIndices.slice(-keepRecentResults));
  let changed = false;
  const next = messages.map((message, index) => {
    if (!message?.isToolResult || protect.has(index)) return message;
    if (Array.isArray(message.functionCallOutputs)) {
      const outputs = message.functionCallOutputs.map(item => ({ ...item, output: condenseOutput(String(item.output ?? ''), maxOutputChars) }));
      if (outputs.some((item, i) => item.output !== message.functionCallOutputs[i].output)) { changed = true; return { ...message, functionCallOutputs: outputs }; }
      return message;
    }
    const content = typeof message.content === 'string' ? message.content : '';
    if (content.length > maxOutputChars) { changed = true; return { ...message, content: content.slice(0, maxOutputChars) + '\n' + CONDENSED_MARKER }; }
    return message;
  });
  return { messages: next, changed };
}

// One instance per loop. Aliases and call identities never leak between chats,
// roles or skills. Native protocol data lives only in this turn's transient messages.
export function createFunctionCallingSession(config, tools = []) {
  const native = supportsResponsesFunctions(config);
  const byName = new Map();
  if (native) for (const tool of tools) {
    const compiled = compileFunctionTool(tool);
    if (compiled.schemaError) throw new Error(`Tool ${tool.id} has an invalid or unsupported parameter schema; no model request was sent.`);
    if (byName.has(compiled.definition.name)) throw new Error('Tool function names collide.');
    byName.set(compiled.definition.name, { tool, ...compiled });
  }
  const seenCallIds = new Set();
  return {
    native,
    definitions: [...byName.values()].map(entry => entry.definition),
    requestOptions() {
      return native ? { functionTools: this.definitions } : {};
    },
    parse(reply) {
      if (typeof reply === 'string') {
        // Legacy transports and injected offline fixtures still return strings.
        const parsed = parseModelResponse(reply);
        return { text: reply, ...parsed };
      }
      if (!native || reply?.protocol !== 'responses' || !Array.isArray(reply.responseItems)) {
        throw new Error('Invalid model tool response.');
      }
      const calls = reply.responseItems.filter(item => item.type === 'function_call');
      if (calls.length > MAX_FUNCTION_CALLS_PER_RESPONSE) throw new Error('Model exceeded the per-response tool call limit. No calls in this batch were executed.');
      const ids = new Set();
      // Validate the entire batch before releasing any side effects.
      for (const item of calls) {
        if (typeof item.call_id !== 'string' || !item.call_id || item.call_id.length > 256 || ids.has(item.call_id) || seenCallIds.has(item.call_id)) {
          throw new Error('Missing or duplicate function call_id. No calls in this batch were executed.');
        }
        ids.add(item.call_id);
      }
      const toolCalls = calls.map(item => {
        const entry = byName.get(item.name);
        const parsed = entry?.parse(item.arguments);
        const error = !entry ? { error: 'UNKNOWN_TOOL', output: 'This function is not available in the current role and turn.' }
          : parsed.error ? parsed : null;
        return { id: item.call_id, name: entry?.tool.id || item.name, arguments: parsed?.args || {},
          ...(error ? { rejectedResult: { ok: false, error: error.error, output: error.output } } : {}) };
      });
      ids.forEach(id => seenCallIds.add(id));
      return { text: modelReplyText(reply), thinking: modelReplyText(reply), toolCalls, responseItems: reply.responseItems };
    },
    append(messages, turn, results, { maxOutputChars = 8000 } = {}) {
      if (turn.responseItems) {
        return [...messages,
          { role: 'assistant', content: turn.text, responseItems: turn.responseItems },
          { role: 'user', content: '', isToolResult: true,
            functionCallOutputs: results.map(({ call, result }) => ({ type: 'function_call_output', call_id: call.id, output: toolOutput(result, maxOutputChars) })) },
        ];
      }
      return [...messages, { role: 'assistant', content: turn.text },
        { role: 'user', content: formatToolResultsMessage(results, { maxOutputChars }), isToolResult: true }];
    },
  };
}
