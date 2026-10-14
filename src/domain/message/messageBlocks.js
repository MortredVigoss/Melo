import { replyPlainText } from '../../shared/replyDocument.js';
// ─── Message blocks service ──────────────────────────────────────────────────
// Pure string / regex helpers for the "message blocks" representation used by
// the conversation view and the Telegram/Discord/voice mirrors. A message
// block is either `{ type: 'text', text }` or `{ type: 'code', language, text }`.
// These helpers parse raw assistant/user content into blocks, strip or
// normalize Markdown for different channels (desktop vs remote vs Telegram),
// and serialize blocks back to a wire-ready string.
//
// This module owns:
//   - parseMessageBlocksFromContent(raw)          — code-fence → blocks
//   - normalizeMessageBlock(block)                — shape-coerce one block
//   - normalizeMessageBlocks(blocks, fallback)    — list form; rebuilds from
//                                                   fallback if blocks empty
//   - stripMarkdownDecoratorsForConversation(v)   — light strip; desktop UI
//   - aggressivelyStripMarkdownForPlainText(v)    — strong strip; remote/TTS
//   - stripMarkdownLinksForPlainText(v)           — links → "text url"
//   - stripAllMarkdownForTelegram(v)              — Telegram-specific strip
//   - normalizeConversationTextBlockForStorage    — routes to light/aggressive
//                                                   based on channelKind
//   - serializeMessageBlocks(blocks)              — blocks → raw markdown
//   - normalizeAssistantReplyForConversation      — parse+normalize+serialize
//   - normalizePreviewPlainText(v)                — one-line preview
//   - visibleTextFromBlocks(blocks, fallback)     — plain text for search/TTS
//   - messageVisibleText(message)                 — convenience: visible text
//                                                   of a message record
//
// Extracted from desktopStore.js in the Phase 9d refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no external dependencies
// at all; every helper takes a string/array and returns a string/array.

export function parseMessageBlocksFromContent(content = '') {
  const raw = String(content || '');
  if (!raw.trim()) {
    return [];
  }

  const blocks = [];
  const codeFencePattern = /```([\w.+-]+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeFencePattern.exec(raw))) {
    const [fullMatch, language = '', code = ''] = match;
    const before = raw.slice(lastIndex, match.index);
    if (before.trim()) {
      blocks.push({
        type: 'text',
        text: before.trim(),
      });
    }

    if (String(code).trim()) {
      blocks.push({
        type: 'code',
        language: String(language || '').trim() || 'text',
        text: String(code).replace(/\s+$/u, ''),
      });
    }

    lastIndex = match.index + fullMatch.length;
  }

  const trailing = raw.slice(lastIndex);
  if (trailing.trim()) {
    blocks.push({
      type: 'text',
      text: trailing.trim(),
    });
  }

  if (!blocks.length && raw.trim()) {
    blocks.push({
      type: 'text',
      text: raw.trim(),
    });
  }

  return blocks;
}

export function normalizeMessageBlock(block) {
  const type = block?.type === 'code' ? 'code' : 'text';
  const text = typeof block?.text === 'string' ? block.text : '';
  if (!text.trim()) {
    return null;
  }

  return {
    type,
    language:
      type === 'code'
        ? String(block?.language || 'text').trim() || 'text'
        : '',
    text,
  };
}

export function normalizeMessageBlocks(blocks, fallbackContent = '') {
  const sourceBlocks =
    Array.isArray(blocks) && blocks.length
      ? blocks
      : parseMessageBlocksFromContent(fallbackContent);

  return sourceBlocks
    .map(normalizeMessageBlock)
    .filter(Boolean);
}

export function stripMarkdownDecoratorsForConversation(value = '') {
  const normalized = String(value || '').replace(/\r\n/g, '\n');
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
    .replace(/(?<=[\p{L}\p{N}\p{Script=Han}])([*_#~]{1,3})(?=$|[\s)\]}.,!?;:'"”’）】》」』，。！？；：、])/gu, '');
}

export function aggressivelyStripMarkdownForPlainText(value = '') {
  let text = String(value || '').replace(/\r\n/g, '\n');

  text = text
    .split('\n')
    .map(line => {
      let normalizedLine = line;
      normalizedLine = normalizedLine.replace(/^\s{0,3}#{1,6}\s*/, '');
      normalizedLine = normalizedLine.replace(/^\s*>+\s?/, '');
      normalizedLine = normalizedLine.replace(/^\s*[-*+]\s+/, '');
      normalizedLine = normalizedLine.replace(/^\s*\d+[.)]\s+/, '');
      if (/^\s*[-*_]{3,}\s*$/.test(normalizedLine)) {
        normalizedLine = '';
      }
      return normalizedLine;
    })
    .join('\n');

  text = text
    .replace(/\*\*\*([^\n*]+?)\*\*\*/g, '$1')
    .replace(/___([^\n_]+?)___/g, '$1')
    .replace(/\*\*([^\n*]+?)\*\*/g, '$1')
    .replace(/__([^\n_]+?)__/g, '$1')
    .replace(/~~([^\n~]+?)~~/g, '$1')
    .replace(/(?<!\*)\*(?!\s)([^\n*]+?)(?<!\s)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_(?!\s)([^\n_]+?)(?<!\s)_(?!_)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*{2,}/g, '')
    .replace(/(^|\s)#+(?=\s|$)/g, '$1')
    .replace(/[*_#~]+\s*$/gm, '');

  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export function stripMarkdownLinksForPlainText(value = '') {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '$1 $2')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 $2');
}

export function stripAllMarkdownForTelegram(value = '') {
  return stripMarkdownLinksForPlainText(String(value || ''))
    .replace(/```[\w.+-]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '$1')
    .replace(/___([\s\S]+?)___/g, '$1')
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/__([\s\S]+?)__/g, '$1')
    .replace(/~~([\s\S]+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export function normalizeConversationTextBlockForStorage(value = '', { channelKind = 'desktop' } = {}) {
  // Preserve structure and code literals for the reading renderer; plain-text channels keep their own projection.
  if (channelKind !== 'remote') return String(value || '').replace(/\r\n/g, '\n').trim();
  const normalizedValue =
    channelKind === 'remote'
      ? aggressivelyStripMarkdownForPlainText(value)
      : stripMarkdownDecoratorsForConversation(value);

  return normalizedValue
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function serializeMessageBlocks(blocks = []) {
  return blocks
    .map(block => {
      if (block.type === 'code') {
        const language = block.language ? `${block.language}\n` : '';
        return `\`\`\`${language}${block.text}\n\`\`\``;
      }

      return block.text;
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function normalizeAssistantReplyForConversation(reply = '', { channelKind = 'desktop' } = {}) {
  const normalizedBlocks = normalizeMessageBlocks([], reply)
    .map(block => {
      if (block.type === 'code') {
        return block;
      }

      return {
        ...block,
        text: normalizeConversationTextBlockForStorage(block.text, { channelKind }),
      };
    })
    .filter(block => block?.text?.trim());

  if (!normalizedBlocks.length) {
    return {
      content: '',
      blocks: [],
    };
  }

  return {
    content: serializeMessageBlocks(normalizedBlocks),
    blocks: normalizedBlocks,
  };
}

export function normalizePreviewPlainText(value = '') {
  return replyPlainText(value)
    .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function visibleTextFromBlocks(blocks = [], fallbackContent = '') {
  return normalizeMessageBlocks(blocks, fallbackContent)
    .map(block => {
      if (block.type === 'code') {
        return `${block.language ? `${block.language}\n` : ''}${block.text}`;
      }

      return aggressivelyStripMarkdownForPlainText(block.text);
    })
    .filter(Boolean)
    .join('\n');
}

export function messageVisibleText(message) {
  return visibleTextFromBlocks(message?.blocks || [], message?.content || '');
}
