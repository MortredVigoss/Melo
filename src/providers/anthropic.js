// Messages API only: no Anthropic agent runtime, shell, or provider tool loop.
import { renderToolMessage, withAnthropicToolCache } from '../tools/toolProtocol.js';

export function anthropicContent(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const url = part.image_url?.url || '';
      const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
      return { type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } };
    }
    throw new Error('此 Anthropic 通道不支持该附件类型。');
  });
}

function completed(reason, { allowToolUse = false } = {}) {
  const accepted = allowToolUse ? ['end_turn', 'stop_sequence', 'tool_use'] : ['end_turn', 'stop_sequence'];
  if (!accepted.includes(reason)) throw new Error(`模型未完成回复（${String(reason || '缺少结束状态').slice(0, 60)}）。`);
}

function isCompleted(reason, allowToolUse) {
  return ['end_turn', 'stop_sequence', ...(allowToolUse ? ['tool_use'] : [])].includes(reason);
}

// Prompt caching (2026-10-17 audit C-5): the system prompt is now the
// cache-stable prefix (per-turn context rides in the latest user message), so
// one breakpoint at the end of the system block and one at the end of the
// history before the current turn let Anthropic reuse both across turns.
// Tool protocol (design audit E1): `tools` are `{name, description,
// input_schema}` (built by toolProtocol.js from the same compiled schemas),
// `tool_choice` defaults to auto, the last definition carries a third cache
// breakpoint (tools precede `system` in Anthropic's cache prefix order), and
// the loop's protocol-neutral toolCalls/toolResults messages are rendered as
// `tool_use` / `tool_result` blocks.
const CACHE_BREAKPOINT = { type: 'ephemeral' };
export function anthropicRequestBody({ model, systemPrompt, messages, maxTokens = 8192, stream = false, promptCache = true, tools = null, toolChoice = null }) {
  const turns = messages.filter(m => ['user', 'assistant'].includes(m.role))
    .flatMap(m => renderToolMessage(m, 'anthropic') || [{ role: m.role, content: anthropicContent(m.content) }]);
  if (promptCache) {
    // Last assistant turn = end of the reusable history prefix.
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index].role !== 'assistant') continue;
      const content = turns[index].content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      if (blocks.length) {
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE_BREAKPOINT };
        turns[index] = { role: 'assistant', content: blocks };
      }
      break;
    }
  }
  const system = systemPrompt
    ? (promptCache ? [{ type: 'text', text: systemPrompt, cache_control: CACHE_BREAKPOINT }] : systemPrompt)
    : '';
  const toolList = Array.isArray(tools) && tools.length ? (promptCache ? withAnthropicToolCache(tools, CACHE_BREAKPOINT) : tools) : null;
  return { model, system, max_tokens: Math.max(1, Math.min(8192, Math.floor(maxTokens) || 8192)), messages: turns, stream,
    ...(toolList ? { tools: toolList, tool_choice: toolChoice || { type: 'auto' } } : {}) };
}

// When `tools` is supplied the reply is `{ protocol:'anthropic', text, content, stopReason }`
// (text-only turns included) so the function-calling session can parse
// `tool_use` blocks; without tools the reply stays a plain string.
export async function requestAnthropicReply({ baseUrl, apiKey, model, systemPrompt, messages, signal, onDelta, onModelMetadata, maxTokens = 8192, fetchImpl = fetch, promptCache = true, tools = null, toolChoice = null }) {
  const withTools = Array.isArray(tools);
  const finish = (text, content, stopReason) => withTools ? { protocol: 'anthropic', text, content, stopReason } : text;
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/messages`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(anthropicRequestBody({ model, systemPrompt, messages, maxTokens, stream: typeof onDelta === 'function', promptCache, tools: withTools ? tools : null, toolChoice })),
  });
  if (!response.ok) {
    let detail = ''; try { detail = (await response.json()).error?.message || ''; } catch {}
    throw new Error(`Anthropic 请求失败（${response.status}）：${detail.slice(0, 400)}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await response.json();
    onModelMetadata?.({ reportedModel: data.model, responseId: data.id, usage: data.usage, transport: 'anthropic-messages', finishReason: data.stop_reason, responseStatus: isCompleted(data.stop_reason, withTools) ? 'completed' : 'incomplete' });
    completed(data.stop_reason, { allowToolUse: withTools });
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter(c => c.type === 'text').map(c => c.text).join('');
    const hasToolUse = withTools && blocks.some(c => c.type === 'tool_use');
    if (!text.trim() && !hasToolUse) throw new Error('模型没有返回文字内容。');
    onModelMetadata?.({ reportedModel: data.model || '', responseId: data.id || '', usage:data.usage, transport: 'anthropic-messages' });
    if (onDelta && text) await onDelta({ delta: text, text });
    return finish(text, blocks, data.stop_reason);
  }
  let buffer = '', text = '', reason = '', stopped = false, count = 0;
  let usage = {};
  // Streaming tool_use blocks: `content_block_start` opens the block, the
  // `input_json_delta` events carry partial JSON, `content_block_stop` closes
  // it. Text blocks are kept too so the assembled `content` mirrors the
  // non-streaming reply.
  const openBlocks = new Map();
  const blocks = [];
  const decoder = new TextDecoder();
  const consume = async block => {
    const raw = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!raw) return;
    const event = JSON.parse(raw);
    if (event.type === 'error') throw new Error(`模型流返回错误：${String(event.error?.message || '未知错误').slice(0, 400)}`);
    if (event.type === 'message_start') usage = {...(event.message?.usage || {})};
    if (event.type === 'message_delta' && event.usage) usage = {...usage,...event.usage};
    if (event.type === 'message_start') onModelMetadata?.({ reportedModel: event.message?.model || '', responseId: event.message?.id || '', transport: 'anthropic-messages', usage, responseStatus: 'in_progress' });
    if (event.type === 'content_block_start') {
      const started = event.content_block || {};
      if (started.type === 'tool_use') {
        if (!withTools) throw new Error('模型返回了未请求的工具调用。');
        openBlocks.set(event.index, { type: 'tool_use', id: started.id, name: started.name, partialJson: '', input: started.input });
      } else if (started.type === 'text') {
        openBlocks.set(event.index, { type: 'text', text: started.text || '' });
      }
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const delta = event.delta.text || ''; text += delta; await onDelta?.({ delta, text });
      const open = openBlocks.get(event.index); if (open?.type === 'text') open.text += delta;
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const open = openBlocks.get(event.index);
      if (open?.type === 'tool_use') {
        open.partialJson += event.delta.partial_json || '';
        if (open.partialJson.length > 256 * 1024) throw new Error('模型工具参数超过容量限制。');
      }
    }
    if (event.type === 'content_block_stop') {
      const open = openBlocks.get(event.index);
      if (open) {
        openBlocks.delete(event.index);
        if (open.type === 'tool_use') {
          let input = open.input;
          if (open.partialJson.trim()) { try { input = JSON.parse(open.partialJson); } catch { input = undefined; } }
          // Unparseable arguments reach the session as a raw string so the
          // model gets an INVALID_TOOL_ARGUMENTS result instead of a crash.
          blocks.push({ type: 'tool_use', id: open.id, name: open.name, input: input === undefined ? (open.partialJson || {}) : (input ?? {}) });
        } else {
          blocks.push({ type: 'text', text: open.text });
        }
      }
    }
    if (event.type === 'message_delta' && event.delta?.stop_reason) reason = event.delta.stop_reason;
    if (event.type === 'message_stop') { onModelMetadata?.({ usage, finishReason: reason, responseStatus: isCompleted(reason, withTools) ? 'completed' : 'incomplete' }); completed(reason, { allowToolUse: withTools }); stopped = true; }
  };
  const reader = response.body.getReader();
  try {
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > 16 * 1024 * 1024) throw new Error('模型响应超过容量限制。');
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const separator = buffer.slice(split).match(/^\r?\n\r?\n/)[0];
        await consume(buffer.slice(0, split)); buffer = buffer.slice(split + separator.length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && !stopped) await consume(buffer);
    if (!stopped) throw new Error('模型连接提前结束，未收到完整回复。');
    const hasToolUse = withTools && blocks.some(block => block.type === 'tool_use');
    if (!text.trim() && !hasToolUse) throw new Error('模型没有返回文字内容。');
    onModelMetadata?.({usage});
    // Text blocks only streamed as deltas (no content_block_start) still count.
    const content = blocks.length ? blocks : (text ? [{ type: 'text', text }] : []);
    return finish(text, content, reason);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
