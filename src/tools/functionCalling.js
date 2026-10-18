import { compileFunctionTool } from './functionSchema.js';
import { toolCodeHint } from './toolResult.js';
import { parseModelResponse, formatToolResultsMessage, _shouldEmitEvidenceTrail } from './parser.js';
import { resolveToolProtocol, toolDefinitionsForProtocol, parseAssistantResponse, toLoopMessages } from './toolProtocol.js';
import { requestEnvironment } from '../runtime/requestScope.js';

export const MAX_FUNCTION_CALLS_PER_RESPONSE = 32;

// Protocol adapter (design audit E1): the old boolean is now derived from the
// resolved protocol. `supportsResponsesFunctions` keeps its historical meaning
// ("this connection speaks the OpenAI Responses function protocol").
export function supportsResponsesFunctions(config = {}) {
  return resolveToolProtocol(config, requestEnvironment()) === 'responses';
}

/** Resolved tool protocol for a connection: 'responses' | 'chat-completions' | 'anthropic' | 'xml'. */
export function toolProtocolFor(config = {}) {
  return resolveToolProtocol(config, requestEnvironment());
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
    if (Array.isArray(message.toolResults)) {
      // Anthropic / chat-completions IR results carry the same envelope JSON.
      const outputs = message.toolResults.map(item => ({ ...item, output: condenseOutput(String(item.output ?? ''), maxOutputChars) }));
      if (outputs.some((item, i) => item.output !== message.toolResults[i].output)) { changed = true; return { ...message, toolResults: outputs }; }
      return message;
    }
    const content = typeof message.content === 'string' ? message.content : '';
    if (content.length > maxOutputChars) { changed = true; return { ...message, content: content.slice(0, maxOutputChars) + '\n' + CONDENSED_MARKER }; }
    return message;
  });
  return { messages: next, changed };
}

// One instance per loop. Aliases and call identities never leak between chats,
// roles or skills. Native protocol data lives only in this turn's transient
// messages (plus the bounded, protocol-neutral `toolChain` record the runner
// persists on the assistant message — see toolProtocol.js).
export function createFunctionCallingSession(config, tools = []) {
  const protocol = toolProtocolFor(config);
  const native = protocol !== 'xml';
  const strictArgs = protocol === 'responses';
  const byName = new Map();
  if (native) for (const tool of tools) {
    const compiled = compileFunctionTool(tool);
    if (compiled.schemaError) throw new Error(`Tool ${tool.id} has an invalid or unsupported parameter schema; no model request was sent.`);
    if (byName.has(compiled.definition.name)) throw new Error('Tool function names collide.');
    byName.set(compiled.definition.name, { tool, ...compiled });
  }
  const seenCallIds = new Set();
  const definitions = toolDefinitionsForProtocol([...byName.values()], protocol);
  return {
    protocol,
    get native() { return protocol !== 'xml'; },
    definitions,
    requestOptions() {
      return native ? { functionTools: this.definitions, toolProtocol: protocol } : {};
    },
    parse(reply) {
      if (typeof reply === 'string') {
        // Legacy transports and injected offline fixtures still return strings.
        const parsed = parseModelResponse(reply);
        return { text: reply, ...parsed };
      }
      if (!native) throw new Error('Invalid model tool response.');
      const ir = parseAssistantResponse(reply, protocol);
      const calls = ir.toolCalls;
      if (calls.length > MAX_FUNCTION_CALLS_PER_RESPONSE) throw new Error('Model exceeded the per-response tool call limit. No calls in this batch were executed.');
      const ids = new Set();
      // Validate the entire batch before releasing any side effects.
      for (const item of calls) {
        if (typeof item.id !== 'string' || !item.id || item.id.length > 256 || ids.has(item.id) || seenCallIds.has(item.id)) {
          throw new Error('Missing or duplicate function call_id. No calls in this batch were executed.');
        }
        ids.add(item.id);
      }
      const toolCalls = calls.map(item => {
        const entry = byName.get(item.name);
        const parsed = entry?.parse(item.arguments, { strict: strictArgs });
        const error = !entry ? { error: 'UNKNOWN_TOOL', output: 'This function is not available in the current role and turn.' }
          : parsed.error ? parsed : null;
        return { id: item.id, name: entry?.tool.id || item.name, arguments: parsed?.args || {},
          ...(error ? { rejectedResult: { ok: false, error: error.error, output: error.output } } : {}) };
      });
      ids.forEach(id => seenCallIds.add(id));
      const text = modelReplyText(reply);
      // `protocolCalls` keeps the wire name / raw arguments the model produced so
      // the turn can be re-rendered for any protocol (persisted tool chain).
      const protocolCalls = calls.map(item => ({ id: item.id, name: item.name, arguments: item.arguments, raw: item.raw }));
      if (protocol === 'responses') return { text, thinking: text, toolCalls, responseItems: ir.responseItems, protocolCalls };
      return { text, thinking: text, toolCalls, protocol, protocolCalls };
    },
    append(messages, turn, results, { maxOutputChars = 8000 } = {}) {
      if (turn.responseItems) {
        return [...messages,
          { role: 'assistant', content: turn.text, responseItems: turn.responseItems },
          { role: 'user', content: '', isToolResult: true,
            functionCallOutputs: results.map(({ call, result }) => ({ type: 'function_call_output', call_id: call.id, output: toolOutput(result, maxOutputChars) })) },
        ];
      }
      if (turn.protocol === 'anthropic' || turn.protocol === 'chat-completions') {
        const wireNames = new Map((turn.protocolCalls || []).map(call => [call.id, call.name]));
        return [...messages, ...toLoopMessages({
          text: turn.text,
          toolCalls: turn.protocolCalls || [],
          toolResults: results.map(({ call, result }) => ({ callId: call.id, name: wireNames.get(call.id) || call.name, output: toolOutput(result, maxOutputChars) })),
        }, turn.protocol)];
      }
      return [...messages, { role: 'assistant', content: turn.text },
        { role: 'user', content: formatToolResultsMessage(results, { maxOutputChars }), isToolResult: true }];
    },
    /**
     * Protocol-neutral IR of one executed tool turn, for the persisted
     * `toolChain` record. `argumentsFor(call)` lets the caller substitute
     * redacted arguments.
     */
    turnRecord(turn, results, { maxOutputChars = 8000, argumentsFor } = {}) {
      const wireCalls = new Map((turn.protocolCalls || []).map(call => [call.id, call]));
      return {
        text: turn.text || '',
        toolCalls: (turn.toolCalls || []).map(call => {
          const wire = wireCalls.get(call.id);
          const args = typeof argumentsFor === 'function' ? argumentsFor(call) : call.arguments;
          return { id: call.id, name: wire?.name || call.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
        }),
        // The IR output is always the envelope JSON, whatever protocol ran the
        // turn; the XML renderer rebuilds <tool_result> from it.
        toolResults: results.map(({ call, result }) => ({ callId: call.id, name: wireCalls.get(call.id)?.name || call.name,
          output: toolOutput(result, maxOutputChars) })),
      };
    },
  };
}
