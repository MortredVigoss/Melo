import { observeNativeItem } from '../tools/executionObservation.js';
import { requestEnvironment } from '../runtime/requestScope.js';
import { extractResponsesText, extractChatCompletionDelta, extractProviderErrorMessage } from './responseText.js';
import { createResponseItemCollector } from './responseItems.js';

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000;

const CODEX_EVENT_TYPES = Object.freeze({
  OUTPUT_DELTA: 'response.output_text.delta',
  COMPLETED: 'response.completed',
  DONE: 'response.done',
  INCOMPLETE: 'response.incomplete',
  ERROR: 'error',
  FAILED: 'response.failed',
});

function resolveStreamIdleTimeoutMs() {
  const configured = Number.parseInt(requestEnvironment().MELO_STREAM_IDLE_TIMEOUT_MS || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function parseCodexSseEvent(block) {
  const lines = block
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function parseChatCompletionsSseEvent(block) {
  const lines = block
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  const dataLines = lines
    .filter(line => line && !line.startsWith(':'))
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart());

  if (!dataLines.length) {
    return null;
  }

  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') {
    return null;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function extractCodexEventError(event) {
  if (!event || typeof event !== 'object') {
    return 'Codex OAuth request failed.';
  }

  if (event.type === 'error') {
    return (
      event.error?.message ||
      event.error?.code ||
      event.message ||
      event.code ||
      'Codex OAuth request failed.'
    );
  }

  if (event.type === 'response.failed') {
    return (
      event.error?.message ||
      event.error?.code ||
      event.response?.error?.message ||
      event.response?.error?.code ||
      event.response?.incomplete_details?.reason ||
      'Codex response failed.'
    );
  }

  return 'Codex OAuth request failed.';
}

function isCodexReasoningDeltaEvent(eventType = '') {
  return eventType === 'response.reasoning_summary_text.delta';
}

function extractCodexReasoningDelta(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }

  if (typeof event.delta === 'string') {
    return event.delta;
  }

  if (typeof event.text === 'string') {
    return event.text;
  }

  if (typeof event.summary === 'string') {
    return event.summary;
  }

  if (event?.text && typeof event.text?.value === 'string') {
    return event.text.value;
  }

  return '';
}

async function cleanupReader(reader) {
  try {
    await reader.cancel();
  } catch {}

  try {
    reader.releaseLock();
  } catch {}
}

function buildStreamStalledError(idleTimeoutMs) {
  return new Error(
    `Model stopped producing output for ${Math.round(
      idleTimeoutMs / 1000,
    )} seconds. The request was cancelled because the stream stalled, not because the task was too long.`,
  );
}

async function drainSseBuffer(buffer, onBlock, { includeTrailing = false } = {}) {
  let remaining = buffer;

  while (true) {
    const separatorIndex = remaining.search(/\r?\n\r?\n/);
    if (separatorIndex === -1) {
      break;
    }

    const separatorLength = remaining.startsWith('\r\n\r\n', separatorIndex) ? 4 : 2;
    const block = remaining.slice(0, separatorIndex);
    remaining = remaining.slice(separatorIndex + separatorLength);
    await onBlock(block);
  }

  if (includeTrailing && remaining.trim()) {
    await onBlock(remaining);
    remaining = '';
  }

  return remaining;
}

async function readSseStream(
  response,
  {
    missingBodyMessage,
    idleTimeoutMs = resolveStreamIdleTimeoutMs(),
    processEventBlock,
  },
) {
  if (!response.body) {
    throw new Error(missingBodyMessage);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastActivityAt = Date.now();
  let stalled = false;
  let normalCompletion = false;
  const stallChecker = setInterval(() => {
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      stalled = true;
      void reader.cancel().catch(() => {});
      clearInterval(stallChecker);
    }
  }, 5000);
  stallChecker.unref?.();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        normalCompletion = true;
        break;
      }

      lastActivityAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      buffer = await drainSseBuffer(buffer, processEventBlock);
    }

    buffer += decoder.decode();
    buffer = await drainSseBuffer(buffer, processEventBlock, { includeTrailing: true });
  } catch (error) {
    if (stalled && !normalCompletion) {
      throw buildStreamStalledError(idleTimeoutMs);
    }
    throw error;
  } finally {
    clearInterval(stallChecker);
    await cleanupReader(reader);
  }
}

// Exported for tests: lets the unit test feed a mocked SSE stream directly
// without faking the full createCodexResponsesReply credential / fetch path.
export async function readCodexSseResponse(
  response,
  {
    onDelta,
    onReasoningDelta,
    onInlineImage,
    onInlineImagePreview,
    onNativeSearch,
    onExecutionEvent,
    onModelMetadata,
    returnToolResponse = false,
    idleTimeoutMs = resolveStreamIdleTimeoutMs(),
  } = {},
) {
  let deltaText = '';
  let reasoningText = '';
  let completedResponse = null;
  const responseItems = returnToolResponse ? createResponseItemCollector() : null;
  // attemptedImageIds — dedup so we don't re-invoke onInlineImage for a
  // single image_generation_call that the stream surfaces twice (once
  // via response.output_item.done, again inside response.completed).
  // A failed callback still gets recorded here — same item, same crash,
  // no point retrying within one response.
  const attemptedImageIds = new Set();
  // injectedImageSnippets — the markdown URL strings we actually appended
  // into deltaText. The final-text branch uses this list to verify that
  // whichever text we end up returning (deltaText or canonical
  // completedText) carries every image we generated. Codex review round 2
  // (2026-04-29) caught two failure modes a Set-of-ids couldn't pin:
  //   • SET-only: completed-only path produced deltaText="<image markdown
  //     only>", emittedImageIds.size > 0 → returned deltaText, dropping
  //     the canonical text the model emitted in the response.completed
  //     payload.
  //   • SET-only: a save failure flipped emittedImageIds.size to 0 even
  //     though we'd already streamed the markdown to onDelta — but UI
  //     can't take it back.
  // Tracking the snippets themselves lets us implement the contract
  // verbatim: the returned text must contain (a) all canonical prose AND
  // (b) every image markdown we successfully injected.
  const injectedImageSnippets = [];
  const observedSearchIds = new Set();
  const observedItems = new Set();
  const observeItem = (item, status) => {
    const event = observeNativeItem(item, status);
    if (!event) return;
    const key = `${event.id}:${status}:${JSON.stringify(item.action || {})}`;
    if (observedItems.has(key)) return;
    observedItems.add(key);
    // A completed generation is only successful after its bytes are saved.
    if (item.type === 'image_generation_call' && status === 'completed') return;
    try { onExecutionEvent?.(event); } catch {}
  };
  const observeSearch = async item => {
    if (item?.type !== 'web_search_call' || item.status !== 'completed' || typeof onNativeSearch !== 'function') return;
    const id = item.id || 'completed-search';
    if (observedSearchIds.has(id)) return;
    observedSearchIds.add(id);
    try { await onNativeSearch(); } catch {}
  };

  // When an inline image lands, emit it as a markdown URL into the
  // streamed reply text. The snippet is appended to deltaText so the URL
  // survives the final return path AND streamed via onDelta so the
  // desktop UI can render it inline before completion.
  const emitInlineImage = async item => {
    if (typeof onInlineImage !== 'function') return;
    if (!item || typeof item !== 'object') return;
    const id = String(item.id || `${Date.now()}-${attemptedImageIds.size}`);
    if (attemptedImageIds.has(id)) return;
    attemptedImageIds.add(id);
    let snippet;
    try {
      snippet = await onInlineImage(item);
    } catch {
      // Save / sign failures must never break the chat reply — we just
      // skip the image. The model's prose still streams normally, and
      // injectedImageSnippets stays untouched so the final-text branch
      // does not append a markdown URL we never wrote.
      return;
    }
    if (typeof snippet !== 'string' || !snippet) return;
    injectedImageSnippets.push(snippet);
    deltaText += snippet;
    if (typeof onDelta === 'function') {
      await onDelta({ delta: snippet, text: deltaText });
    }
  };

  const processEventBlock = async block => {
    const event = parseCodexSseEvent(block);
    if (!event) {
      return;
    }
    responseItems?.accept(event);
    if(event.type === 'response.image_generation_call.partial_image') await onInlineImagePreview?.(event);
    if (event.type === 'response.output_item.added') observeItem(event.item, 'running');
    if (event.type === 'response.output_item.done') {
      observeItem(event.item, event.item?.status === 'failed' ? 'failed' : event.item?.status === 'cancelled' ? 'cancelled' : event.item?.status === 'incomplete' ? 'interrupted' : 'completed');
      await observeSearch(event.item);
      if (event.item?.type === 'reasoning' && !reasoningText) {
        const summary = (event.item.summary || []).filter(p => p.type === 'summary_text').map(p => p.text || '').join('\n');
        if (summary) { reasoningText = summary; await onReasoningDelta?.({ delta: summary, text: summary, eventType: 'response.reasoning_summary_text.delta' }); }
      }
    }

    if (
      event.type === CODEX_EVENT_TYPES.OUTPUT_DELTA &&
      typeof event.delta === 'string'
    ) {
      deltaText += event.delta;
      if (typeof onDelta === 'function') {
        await onDelta({
          delta: event.delta,
          text: deltaText,
        });
      }
      return;
    }

    if (isCodexReasoningDeltaEvent(event.type)) {
      const delta = extractCodexReasoningDelta(event);
      if (delta) {
        reasoningText += delta;
        if (typeof onReasoningDelta === 'function') {
          await onReasoningDelta({
            delta,
            text: reasoningText,
            eventType: event.type,
          });
        }
      }
      return;
    }

    // Streaming-path success signal for the built-in image_generation tool.
    // Same shape as codexImageEngine (which uses this endpoint standalone).
    if (
      event.type === 'response.output_item.done' &&
      event.item?.type === 'image_generation_call' &&
      typeof event.item.result === 'string' &&
      event.item.result
    ) {
      await emitInlineImage(event.item);
      return;
    }

    if (
      event.type === CODEX_EVENT_TYPES.COMPLETED ||
      event.type === CODEX_EVENT_TYPES.DONE ||
      event.type === CODEX_EVENT_TYPES.INCOMPLETE
    ) {
      completedResponse = event.response || completedResponse;
      // Fallback: under heavy load, some output_item.done events arrive
      // out-of-order or are merged into the terminal response payload.
      // Walk the completed output once for any image_generation_call we
      // haven't emitted yet so the user still sees the image.
      const output = completedResponse?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item?.type === 'reasoning' && !reasoningText) {
            const summary = (item.summary || []).filter(p => p.type === 'summary_text').map(p => p.text || '').join('\n');
            if (summary) { reasoningText = summary; await onReasoningDelta?.({ delta: summary, text: summary, eventType: 'response.reasoning_summary_text.delta' }); }
          }
          observeItem(item, item.status === 'failed' ? 'failed' : item.status === 'cancelled' ? 'cancelled' : item.status === 'incomplete' ? 'interrupted' : 'completed');
          await observeSearch(item);
          if (
            item &&
            item.type === 'image_generation_call' &&
            typeof item.result === 'string' &&
            item.result
          ) {
            await emitInlineImage(item);
          }
        }
      }
      return;
    }

    if (
      event.type === CODEX_EVENT_TYPES.ERROR ||
      event.type === CODEX_EVENT_TYPES.FAILED
    ) {
      throw new Error(extractCodexEventError(event));
    }
  };

  await readSseStream(response, {
    missingBodyMessage: 'Codex OAuth request returned no response body.',
    idleTimeoutMs,
    processEventBlock,
  });

  const outputItems = responseItems?.complete();
  const finish = text => returnToolResponse ? { protocol: 'responses', text, responseItems: outputItems } : text;

  // Final-text contract (Codex review round 2, 2026-04-29):
  //
  //   1. Canonical text — `extractResponsesText(completedResponse)` is
  //      authoritative when present; it's the model's own final
  //      answer assembled by the server from all output_text items.
  //      `deltaText` is just our running concatenation of streamed
  //      delta chunks plus any image markdown we appended.
  //
  //   2. Image markdown — every successfully injected snippet must
  //      appear in the returned text. Otherwise downstream
  //      `extractUrlAttachmentsFromText` won't see the .png URL and
  //      every generated image silently disappears from the assistant
  //      message.
  //
  // Failure modes we MUST NOT regress (each pinned by a test):
  //   • Pure text reply → return canonical completedText; no behaviour
  //     change vs pre-image-feature path.
  //   • Streamed text + image → completedText alone misses the image;
  //     deltaText already contains both, so return deltaText.
  //   • Completed-only payload (no text deltas) + image → completedText
  //     has the prose, deltaText has only the image markdown. Combine.
  //   • Save failure for one of N images → injectedImageSnippets only
  //     lists the ones that landed; we don't re-inject failed ones.
  let completedText = extractResponsesText(completedResponse);
  const annotations = (completedResponse?.output || []).flatMap(item => item.type === 'message' ? (item.content || []).flatMap(c => c.annotations || []) : [])
    .filter(a => a.type === 'url_citation' && /^https?:\/\//.test(a.url || ''));
  const links = [...new Map(annotations.map(a => [a.url, a])).values()];
  if (links.length) {
    try { onExecutionEvent?.({ kind: 'sources', sources: links.map(a => ({ url: a.url, title: a.title, reading: 'unknown' })) }); } catch {}
    const missing = links.filter(a => !completedText.includes(a.url));
    if (missing.length) completedText += '\n\n' + missing.map(a => `[source: ${a.url}]`).join(' ');
  }
  onModelMetadata?.({ reportedModel: completedResponse?.model || '', responseId: completedResponse?.id || '', usage: completedResponse?.usage });
  const trimmedDelta = deltaText.trim();
  const baseText = completedText || trimmedDelta;

  if (!injectedImageSnippets.length) {
    if (baseText || outputItems?.some(item => item.type === 'function_call')) return finish(baseText);
    throw new Error('Codex OAuth request completed without returning a final reply.');
  }

  // Pick whichever base text already contains every image snippet —
  // that's the version that actually flowed through onDelta to the UI
  // in real time (so the user has already seen it inline). When neither
  // contains them all, append the missing snippets to the canonical
  // text so the final return matches the streamed UI state.
  const allInDelta = injectedImageSnippets.every(s => deltaText.includes(s));
  if (allInDelta && trimmedDelta) {
    // deltaText already has prose + images interleaved in the stream
    // order the user saw. Prefer it when completedText is absent OR
    // its prose is already a substring of deltaText.
    if (!completedText || deltaText.includes(completedText)) {
      return finish(trimmedDelta);
    }
    // completedText carries prose deltaText didn't catch (e.g. a chunk
    // arrived as part of the terminal payload, not as an output_text
    // delta). Append images to canonical text — see contract case 3.
  }

  if (completedText) {
    const missing = injectedImageSnippets.filter(s => !completedText.includes(s));
    if (!missing.length) return finish(completedText);
    // Snippets are wrapped with leading+trailing blank lines so a
    // simple concat keeps the markdown URL parseable by
    // extractUrlAttachmentsFromText without further glue.
    return finish([completedText, ...missing].join('').trimEnd());
  }

  if (trimmedDelta) return finish(trimmedDelta);
  throw new Error('Codex OAuth request completed without returning a final reply.');
}

export async function readChatCompletionsSseResponse(
  response,
  { onDelta, onModelMetadata, idleTimeoutMs = resolveStreamIdleTimeoutMs() } = {},
) {
  let fullText = '';
  let metadata = {};
  let completed = false;

  const processEventBlock = async block => {
    if (block.split(/\r?\n/).some(line => /^data:\s*\[DONE\]\s*$/.test(line))) {
      completed = true;
      return;
    }
    const event = parseChatCompletionsSseEvent(block);
    if (!event) {
      return;
    }

    if (event?.error) {
      throw new Error(extractProviderErrorMessage(event, 'Streaming provider request failed.'));
    }
    if (event.model) metadata = { ...metadata, reportedModel: event.model, responseId: event.id || '' };
    if (event.usage) metadata.usage = event.usage;
    const finishReason = event.choices?.[0]?.finish_reason;
    if (finishReason && finishReason !== 'stop') {
      // Partial text must not be saved as a successful reply after a token
      // limit, content filter or unsupported native tool-only completion.
      throw new Error(`Provider response incomplete (finish_reason: ${String(finishReason).slice(0, 60)}).`);
    }
    if (finishReason === 'stop') completed = true;

    const delta = extractChatCompletionDelta(event);
    if (delta) {
      fullText += delta;
      if (typeof onDelta === 'function') {
        await onDelta({
          delta,
          text: fullText,
        });
      }
    }
  };

  await readSseStream(response, {
    missingBodyMessage: 'Streaming request returned no response body.',
    idleTimeoutMs,
    processEventBlock,
  });

  if (!completed) throw new Error('Provider stream ended before a completion event; the reply is incomplete.');
  if (fullText.trim()) {
    onModelMetadata?.(metadata);
    return fullText.trim();
  }

  throw new Error('Streaming request completed without returning a final reply.');
}
