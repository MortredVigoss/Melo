// Conservative estimates, not a provider tokenizer. Never count base64 as prose.
export function estimateTextTokens(value = '') {
  const text = String(value);
  const nonLatin = (text.match(/[^\u0000-\u024f]/gu) || []).length;
  return Math.ceil((text.length - nonLatin) / 4 + nonLatin * 1.5);
}

export function estimateMessageTokens(message) {
  const content = message?.content;
  let cost = 6;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'image_url' || part?.type === 'input_image') cost += 2048;
      else if (typeof part?.text === 'string') cost += estimateTextTokens(part.text);
      else if (/audio|video/.test(part?.type || '')) cost += 2048;
    }
  } else {
    cost += estimateTextTokens(content || '');
    for (const media of message?.extractedMedia || []) cost += estimateTextTokens(media?.text || '');
    for (const attachment of message?.attachments || []) {
      if (attachment?.kind === 'image') cost += 2048;
      else cost += estimateTextTokens(attachment?.title || attachment?.fileName || '');
    }
  }
  return cost;
}

export function estimateMessagesTokens(messages = []) {
  return Math.ceil(messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) * (4 / 3));
}

export function truncateToTokens(text, budget) {
  if (estimateTextTokens(text) <= budget) return text;
  const suffix = '\n[Context excerpt truncated to fit request budget.]';
  if (estimateTextTokens(suffix) >= budget) return '';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextTokens(text.slice(0, mid) + suffix) <= budget) lo = mid;
    else hi = mid - 1;
  }
  // Avoid leaving a lone high surrogate at the cut boundary.
  if (lo && /[\uD800-\uDBFF]/.test(text[lo - 1])) lo -= 1;
  return text.slice(0, lo) + suffix;
}
