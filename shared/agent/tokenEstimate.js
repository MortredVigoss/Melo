// Conservative estimates, not a provider tokenizer. Never count base64 as prose.
//
// Non-Latin (CJK etc.) weight: 1.0 raw token per character. Callers pad raw
// estimates by 4/3, so the effective rate is ~1.33 tokens/char — between the
// o200k family (~0.7–1.0 for Chinese) and Claude (~1.2–1.6). The previous
// 1.5 raw (2.0 effective) overestimated Chinese by about 2× and halved the
// usable window for Chinese conversations (2026-10-17 audit C-10).
export const NON_LATIN_TOKENS_PER_CHAR = 1.0;

// Count code points above U+024F without allocating a match array. The old
// `text.match(/[^\u0000-\u024f]/gu)` built an array with one entry per CJK
// character — on a 150k-token Chinese context that was tens of thousands of
// allocations per estimate, and the request fitter estimates every message
// on every tool-loop iteration (2026-10-17 tool-path optimisation).
function countNonLatin(text) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x024f) {
      count += 1;
      // A surrogate pair is one code point: skip its low half.
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) index += 1;
      }
    }
  }
  return count;
}

export function estimateTextTokens(value = '') {
  const text = String(value);
  const nonLatin = countNonLatin(text);
  return Math.ceil((text.length - nonLatin) / 4 + nonLatin * NON_LATIN_TOKENS_PER_CHAR);
}

// Per-message estimates are memoised on the message object: the tool loop
// re-fits the same history objects on every iteration, and protocol messages
// had their items JSON-stringified each time. The memo is only reused while
// the message's content-bearing references (and item array lengths) are
// unchanged, so in-place edits still re-estimate.
const messageCostCache = new WeakMap();

function costFingerprint(message) {
  const items = message.responseItems || message.functionCallOutputs || message.toolCalls || message.toolResults;
  return {
    content: message.content,
    items,
    itemsLength: Array.isArray(items) ? items.length : -1,
    attachments: message.attachments,
    attachmentsLength: Array.isArray(message.attachments) ? message.attachments.length : -1,
    extractedMedia: message.extractedMedia,
    extractedMediaLength: Array.isArray(message.extractedMedia) ? message.extractedMedia.length : -1,
  };
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return computeMessageTokens(message);
  const fingerprint = costFingerprint(message);
  const cached = messageCostCache.get(message);
  if (cached && cached.content === fingerprint.content && cached.items === fingerprint.items && cached.itemsLength === fingerprint.itemsLength
    && cached.attachments === fingerprint.attachments && cached.attachmentsLength === fingerprint.attachmentsLength
    && cached.extractedMedia === fingerprint.extractedMedia && cached.extractedMediaLength === fingerprint.extractedMediaLength) {
    return cached.cost;
  }
  const cost = computeMessageTokens(message);
  messageCostCache.set(message, { ...fingerprint, cost });
  return cost;
}

function computeMessageTokens(message) {
  // Responses items, or the protocol-neutral toolCalls/toolResults IR
  // (Anthropic / chat-completions tool turns, design audit E1).
  const protocolItems = message?.responseItems || message?.functionCallOutputs || message?.toolCalls || message?.toolResults;
  if (Array.isArray(protocolItems)) {
    // Include opaque encrypted state conservatively; never log or truncate it.
    const textCost = !message.responseItems && Array.isArray(message.toolCalls) && typeof message.content === 'string' ? estimateTextTokens(message.content) : 0;
    return 6 + estimateTextTokens(JSON.stringify(protocolItems)) + textCost;
  }
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
  const suffixTokens = estimateTextTokens(suffix);
  if (suffixTokens >= budget) return '';
  // Single forward pass instead of a binary search over string slices (each
  // slice used to be re-estimated from scratch): find the longest prefix whose
  // estimate plus the suffix fits. Raw cost is tracked in quarter-tokens so
  // the prefix check matches estimateTextTokens' ceil() exactly.
  // The suffix is ASCII, so its cost folds into the Latin unit count; this keeps
  // the cut identical to estimating `prefix + suffix` as one string.
  let latinUnits = suffix.length;
  let nonLatin = 0;
  let cut = 0;
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    let width = 1;
    if (code > 0x024f) {
      nonLatin += 1;
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) width = 2;
      }
      latinUnits += width - 1;
    } else {
      latinUnits += 1;
    }
    const tokens = Math.ceil(latinUnits / 4 + nonLatin * NON_LATIN_TOKENS_PER_CHAR);
    if (tokens > budget) break;
    index += width;
    cut = index;
  }
  // Avoid leaving a lone high surrogate at the cut boundary.
  if (cut && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut -= 1;
  return text.slice(0, cut) + suffix;
}
