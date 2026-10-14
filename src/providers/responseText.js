// Provider payload decoding. Function bodies ported byte-for-byte.
export function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      return '';
    })
    .join('')
    .trim();
}

export function extractChatCompletionsText(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;

  return normalizeMessageContent(content);
}

export function extractResponsesText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];

  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (typeof content?.text === 'string' && content.text.trim()) {
        parts.push(content.text);
      } else if (
        content?.text &&
        typeof content.text === 'object' &&
        typeof content.text.value === 'string' &&
        content.text.value.trim()
      ) {
        parts.push(content.text.value);
      }
    }
  }

  return parts.join('\n').trim();
}

export function extractAssistantText(payload) {
  const finishReason = payload?.choices?.[0]?.finish_reason;
  if (finishReason && finishReason !== 'stop') {
    throw new Error(`Provider response incomplete (finish_reason: ${String(finishReason).slice(0, 60)}).`);
  }
  const responseText = extractResponsesText(payload);
  if (responseText) {
    return responseText;
  }

  const chatText = extractChatCompletionsText(payload);
  if (chatText) {
    return chatText;
  }

  throw new Error('Provider returned an empty response without a final reply.');
}

export function extractChatCompletionDelta(payload) {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta) {
    return '';
  }

  if (typeof delta.content === 'string') {
    return delta.content;
  }

  if (!Array.isArray(delta.content)) {
    return '';
  }

  return delta.content
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      if (item?.text && typeof item.text?.value === 'string') return item.text.value;
      return '';
    })
    .join('');
}

export function extractProviderErrorMessage(payload, fallback = 'Provider request failed.') {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  return (
    payload?.error?.message ||
    payload?.message ||
    payload?.detail ||
    fallback
  );
}
