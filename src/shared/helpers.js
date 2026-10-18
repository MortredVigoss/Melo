// ─── Shared pure helpers ─────────────────────────────────────────────────────
// Tiny pure utilities used across the desktopStore layer, the service layer,
// and anything that needs to keep ID / timestamp / attachment normalization
// consistent. No state, no I/O, no imports from desktopStore.
//
// This module owns:
//   - nowIso — ISO 8601 "right now" timestamp
//   - normalizeAgentStorageId — "Main Lane!!" → "main-lane", used as the
//     storage partition key for agent-scoped data (chats, skills, memory…)
//   - normalizeMessageAttachments — coerce + cap + de-noise the attachment
//     array shape carried on each chat message (always <= 8 entries, every
//     entry has a stable `id` + known-good `kind`)
//
// Extracted in the Phase 5c refactor (see
// `src/_refactor-backup/REFACTOR_PLAN.md`). Keep this file minimal — it is
// intentionally a leaf in the dep graph.
//
// Intentionally NOT here: anything that touches MELO_HOME, file I/O, network,
// or desktopStore state. Those go in `src/services/*` or stay in
// `src/desktopStore.js`.

import { randomUUID } from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Best-effort ISO date coerce: accept a stringish or Date value, parse it,
 * return the ISO string. Falls back to `fallback` (defaulting to nowIso())
 * when the input is empty or unparseable. Used everywhere a state blob
 * carries a `createdAt`/`updatedAt` that may have been hand-edited.
 */
export function coerceIso(value, fallback = nowIso()) {
  if (!value) {
    return fallback;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

/**
 * Human-readable "N hours/days ago" label built from an ISO string. Used in
 * lots of small summarizers (chats, artifacts, tasks, etc.). Falls back to
 * "Recently updated" when the input is not a valid date.
 */
export function formatUpdatedAt(isoString) {
  const parsed = Date.parse(isoString);
  if (Number.isNaN(parsed)) {
    return 'Recently updated';
  }

  const diffMs = Math.max(0, Date.now() - parsed);
  const diffHours = Math.max(1, Math.round(diffMs / (1000 * 60 * 60)));

  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

export function normalizeAgentStorageId(agentId = 'main') {
  const normalized = String(agentId || 'main')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'main';
}

/**
 * Normalize markdown content for on-disk storage: CRLF → LF and strip any
 * trailing whitespace. Used by every place we round-trip a markdown body
 * (agent identity / soul files, notes, etc.) so the persisted form is
 * stable across platforms.
 */
export function normalizeMarkdownContent(value = '') {
  return String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
}

/**
 * Simple "Title Case" helper. Converts `-` and `_` to spaces and capitalizes
 * each word's first character. Used for attachment kinds and default
 * profile names, so the input is always short + ASCII-ish.
 */
export function titleCase(value) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, match => match.toUpperCase());
}

/**
 * Cap a string at `max` characters. If the input is longer than `max`,
 * returns the first `max - 1` characters followed by an ellipsis so the
 * total length never exceeds `max`. Used for channel preview blurbs,
 * artifact / run summaries, and similar UI slots.
 */
export function truncateText(value = '', max = 180) {
  const normalized = String(value || '');
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function normalizeMessageAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map(attachment => {
      const kind = ['image', 'video', 'audio', 'link'].includes(attachment?.kind)
        ? attachment.kind
        : 'link';
      const url = typeof attachment?.url === 'string' ? attachment.url.trim() : '';
      if (!url) {
        return null;
      }

      return {
        id: attachment?.id || randomUUID(),
        kind,
        url,
        title: typeof attachment?.title === 'string' ? attachment.title : '',
        mimeType: typeof attachment?.mimeType === 'string' ? attachment.mimeType : '',
        fileName: typeof attachment?.fileName === 'string' ? attachment.fileName : '',
        sizeLabel: typeof attachment?.sizeLabel === 'string' ? attachment.sizeLabel : '',
        // Externalized attachments (src/media/attachments.js) record where the
        // bytes live; the keys only appear when set so inline attachments keep
        // their historical shape.
        ...(attachment?.storage === 'file' ? { storage: 'file' } : {}),
        ...(Number.isFinite(Number(attachment?.byteSize)) && Number(attachment.byteSize) > 0
          ? { byteSize: Number(attachment.byteSize) }
          : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}
