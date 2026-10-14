// Messages API only: no Anthropic agent runtime, shell, or provider tool loop.
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

function completed(reason) {
  if (!['end_turn', 'stop_sequence'].includes(reason)) throw new Error(`模型未完成回复（${String(reason || '缺少结束状态').slice(0, 60)}）。`);
}

export async function requestAnthropicReply({ baseUrl, apiKey, model, systemPrompt, messages, signal, onDelta, onModelMetadata, maxTokens = 8192, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/messages`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, system: systemPrompt || '', max_tokens: Math.max(1, Math.min(8192, Math.floor(maxTokens) || 8192)),
      messages: messages.filter(m => ['user', 'assistant'].includes(m.role)).map(m => ({ role: m.role, content: anthropicContent(m.content) })),
      stream: typeof onDelta === 'function',
    }),
  });
  if (!response.ok) {
    let detail = ''; try { detail = (await response.json()).error?.message || ''; } catch {}
    throw new Error(`Anthropic 请求失败（${response.status}）：${detail.slice(0, 400)}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await response.json();
    completed(data.stop_reason);
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (!text.trim()) throw new Error('模型没有返回文字内容。');
    onModelMetadata?.({ reportedModel: data.model || '', responseId: data.id || '', usage:data.usage, transport: 'anthropic-messages' });
    if (onDelta) await onDelta({ delta: text, text });
    return text;
  }
  let buffer = '', text = '', reason = '', stopped = false, count = 0;
  let usage = {};
  const decoder = new TextDecoder();
  const consume = async block => {
    const raw = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!raw) return;
    const event = JSON.parse(raw);
    if (event.type === 'error') throw new Error(`模型流返回错误：${String(event.error?.message || '未知错误').slice(0, 400)}`);
    if (event.type === 'message_start') usage = {...(event.message?.usage || {})};
    if (event.type === 'message_delta' && event.usage) usage = {...usage,...event.usage};
    if (event.type === 'message_start') onModelMetadata?.({ reportedModel: event.message?.model || '', responseId: event.message?.id || '', transport: 'anthropic-messages' });
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') throw new Error('模型返回了未请求的工具调用。');
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const delta = event.delta.text || ''; text += delta; await onDelta?.({ delta, text });
    }
    if (event.type === 'message_delta' && event.delta?.stop_reason) reason = event.delta.stop_reason;
    if (event.type === 'message_stop') { completed(reason); stopped = true; }
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
    if (!text.trim()) throw new Error('模型没有返回文字内容。');
    onModelMetadata?.({usage});
    return text;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
