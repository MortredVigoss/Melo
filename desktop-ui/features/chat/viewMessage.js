// Chat message renderers (architecture plan P2c, 2026-10-19): message blocks
// and rich text, web source citations, attachment cards, the viz mount, the
// read-aloud action and persisted tool results. Moved out of desktop-ui/app.js
// byte-for-byte first; they now read the feature's own state and the TTS
// speaking state through the context. DOM, classes, data-attributes, ids and
// action names are unchanged. renderTextBlock / renderInlineText stay in app.js (the artifacts
// page renders documents with them too) and arrive through the context.
import { ui } from '../../i18n.js';
import { replyPlainText } from '../../replyDocument.js';
import { renderAttachmentCards } from '../../attachmentCards.js';
import { describeAudioExtractionStatus, describeVideoExtractionStatus } from '../../videoStatus.js';
import { renderVizMountHtml } from '../../viz/vizRenderer.js';
import { isToolTraceMessage } from '../../messageToolTrace.js';
import { renderMessageToolResults as _renderMessageToolResultsFromModule } from '../../messageToolResults.js';
import { speakingState, escapeHtml, truncate, icon, renderTextBlock, extractTextUrls } from './context.js';
import { chatState } from './state.js';
import { attachmentLabel, isPdfAttachment } from './controller.js';

function parseRenderableMessageBlocks(value = '') {
  const blocks = [];
  const source = String(value || '');
  const pattern = /```([\w.+-]+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(source))) {
    const [raw, language = '', block = ''] = match;
    const before = source.slice(lastIndex, match.index);
    if (before.trim()) {
      blocks.push({ type: 'text', value: before });
    }
    blocks.push({ type: 'code', language, value: block.trim() });
    lastIndex = match.index + raw.length;
  }

  const tail = source.slice(lastIndex);
  if (tail.trim() || !blocks.length) {
    blocks.push({ type: 'text', value: tail || source });
  }

  return blocks;
}

function normalizeDisplayConversationText(value = '') {
  // Defense-in-depth: the backend's extractVizSpec() strips the trailer
  // before persisting, but if one ever slips through (old messages, a
  // provider that returned partial text, etc.) we still don't want the
  // raw <viz-spec>…</viz-spec> JSON blob rendered in the chat bubble.
  const preStripped = String(value || '').replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, '');
  const normalized = preStripped.replace(/\r\n/g, '\n');
  const strippedLines = normalized
    .split('\n')
    .map(line =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/^\s*---+\s*$/, ''),
    )
    .join('\n');

  return strippedLines
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(
      /(^|[\s([{"'“‘（【《「『])\*([^*\n]+)\*(?=$|[\s)\]}.,!?;:'"”’）】》」』，。！？；：、])/gu,
      '$1$2',
    )
    .replace(
      /(^|[\s([{"'“‘（【《「『])_([^_\n]+)_(?=$|[\s)\]}.,!?;:'"”’）】》」』，。！？；：、])/gu,
      '$1$2',
    )
    .replace(/(^|[\s([{"'“‘（【《「『])([*_#~]{1,3})(?=[\p{L}\p{N}\p{Script=Han}])/gu, '$1')
    .replace(/(?<=[\p{L}\p{N}\p{Script=Han}])([*_#~]{1,3})(?=$|[\s)\]}.,!?;:'"”’）】》」』，。！？；：、])/gu, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderRichText(value = '') {
  return parseRenderableMessageBlocks(value)
    .map(block => {
      if (block.type === 'code') {
        return ui`
          <div
            class="message-code-block"
            data-copyable-surface
            data-copy-text="${escapeHtml(block.value)}"
          >
            ${
              block.language
                ? ui`<div class="message-code-label">${escapeHtml(block.language)}</div>`
                : ''
            }
            <pre><code data-language="${escapeHtml(block.language)}">${escapeHtml(block.value)}</code></pre>
          </div>
        `;
      }

      return renderTextBlock(block.value);
    })
    .join('');
}

function normalizeRenderableMessageBlock(block) {
  if (!block || typeof block !== 'object') {
    return null;
  }

  const type = block.type === 'code' ? 'code' : 'text';
  const text =
    typeof block.text === 'string'
      ? block.text
      : typeof block.value === 'string'
        ? block.value
        : '';

  if (!String(text).trim()) {
    return null;
  }

  return {
    type,
    language:
      type === 'code'
        ? String(block.language || '').trim()
        : '',
    text,
  };
}

function messageBlocksForRender(message) {
  const persistedBlocks = Array.isArray(message?.blocks)
    ? message.blocks
        .map(normalizeRenderableMessageBlock)
        .filter(Boolean)
    : [];

  if (persistedBlocks.length) {
    return persistedBlocks;
  }

  return parseRenderableMessageBlocks(message?.content || '')
    .map(block => ({
      type: block.type === 'code' ? 'code' : 'text',
      language: block.type === 'code' ? String(block.language || '').trim() : '',
      text: String(block.value || ''),
    }))
    .map(normalizeRenderableMessageBlock)
    .filter(Boolean);
}

function renderMessageBlocks(message) {
  const blocks = messageBlocksForRender(message);
  if (!blocks.length) {
    return '';
  }

  // Collect citations from all text blocks in assistant messages
  const isAssistant = message?.role === 'assistant';
  const allCitations = [];

  const renderedBlocks = blocks
    .map(block => {
      if (block.type === 'code') {
        return ui`
          <div
            class="message-code-block"
            data-copyable-surface
            data-copy-text="${escapeHtml(block.text)}"
          >
            ${
              block.language
                ? ui`<div class="message-code-label">${escapeHtml(block.language)}</div>`
                : ''
            }
            <pre><code data-language="${escapeHtml(block.language)}">${escapeHtml(
              block.text,
            )}</code></pre>
          </div>
        `;
      }

      let textForDisplay = block.text;
      if (isAssistant) {
        const { citations, cleanText } = extractSourceCitations(block.text);
        citations.forEach(c => allCitations.push(c));
        textForDisplay = cleanText;
      }

      const displayText = textForDisplay.trim();
      if (!displayText) {
        return '';
      }

      return ui`
        <div
          class="message-bubble"
          data-copyable-surface
          data-copy-text="${escapeHtml(replyPlainText(displayText))}"
        >
          ${renderTextBlock(displayText)}
        </div>
      `;
    })
    .join('');

  return ui`
    <div class="message-block-stack">
      ${renderedBlocks}
      ${isAssistant ? renderSourceCitationCards(allCitations) : ''}
    </div>
  `;
}

// ─── Web source citation helpers ───────────────────────────────────────────────

/**
 * Extract [source: url] citation markers from text.
 * Returns { citations: [{url, via?}], cleanText }.
 */
function extractSourceCitations(text = '') {
  const citations = [];
  const seen = new Set();
  // Match [source: url] and optional [via: method] following it
  const pattern = /\[source:\s*(https?:\/\/[^\]]+)\](?:\s*\[via:\s*([^\]]+)\])?/gi;
  const cleanText = text.replace(pattern, (_match, url, via) => {
    const trimmedUrl = url.trim();
    if (!seen.has(trimmedUrl)) {
      seen.add(trimmedUrl);
      citations.push({ url: trimmedUrl, via: (via || '').trim() });
    }
    return '';
  }).trim();
  return { citations, cleanText };
}

/**
 * Try to extract a readable hostname label from a URL.
 */
function citationHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Render citation source cards for web search / fetch_url results.
 */
function renderSourceCitationCards(citations) {
  if (!citations.length) return '';
  return ui`
    <div class="source-citation-strip">
      ${citations.map(({ url, via }) => ui`
        <a
          class="source-citation-card"
          href="${escapeHtml(url)}"
          target="_blank"
          rel="noreferrer"
          title="${escapeHtml(url)}"
        >
          <span class="citation-icon">🔗</span>
          <span class="citation-host">${escapeHtml(citationHostname(url))}</span>
          ${via ? ui`<span class="citation-via">${escapeHtml(via)}</span>` : ''}
        </a>
      `).join('')}
    </div>
  `;
}

function renderMessageAttachments(message) {
  return renderAttachmentCards(message, { savedVideoKnowledge: chatState.savedVideoKnowledge || {}, escapeHtml, truncate, icon, attachmentLabel, isPdfAttachment, describeAudioExtractionStatus, describeVideoExtractionStatus, extractTextUrls });
}

// Render a placeholder mount point for the viz block attached to an
// assistant message (if any). The real renderer is instantiated AFTER
// the DOM is swapped, in syncVizBlocks(). Keeping the scaffold in the
// static HTML means the viz block participates in the normal message
// layout flow (spacing, scroll anchoring, etc.).
function renderAssistantVizMount(message) {
  if (!message || message.role !== 'assistant') return '';
  const viz = message.viz;
  if (!viz || typeof viz !== 'object') return '';
  return renderVizMountHtml(message.id, viz);
}

function renderMessageActions(message) {
  // Bug audit U12: a tool-trace record has nothing to read aloud.
  if (message.role !== 'assistant' || isToolTraceMessage(message)) return '';
  const isSpeaking = speakingState().messageId === message.id;
  const isLoading = !isSpeaking && speakingState().loadingId === message.id;
  return ui`
    <div class="message-actions">
      <button
        class="message-action-btn ${isSpeaking ? 'is-speaking' : ''} ${isLoading ? 'is-tts-loading' : ''}"
        type="button"
        data-action="speak-message"
        data-message-id="${escapeHtml(message.id)}"
        title="${isSpeaking ? 'Stop speaking' : 'Read aloud'}"
        aria-label="${isSpeaking ? 'Stop speaking' : 'Read aloud'}"
      >
        <span class="toolbar-icon">${isSpeaking ? icon.speakOff : icon.speak}</span>
      </button>
    </div>
  `;
}

// G-1d slice 2 (2026-05-12): renders persisted tool execution metadata
// under assistant messages in chat history.  Extracted to
// `./messageToolResults.js` (same pattern as activeToolCallsStrip.js)
// so the pure-string renderer is testable without a DOM.
function renderMessageToolResults(message) {
  return _renderMessageToolResultsFromModule(message, escapeHtml);
}

export { parseRenderableMessageBlocks, normalizeDisplayConversationText, renderRichText, normalizeRenderableMessageBlock, messageBlocksForRender, renderMessageBlocks, extractSourceCitations, citationHostname, renderSourceCitationCards, renderMessageAttachments, renderAssistantVizMount, renderMessageActions, renderMessageToolResults };
