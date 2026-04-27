// ─── Artifact service ────────────────────────────────────────────────────────
// Pure shape helpers for the "artifact" record kind — the Melo UI's term for
// a code snippet, document, or other shareable chunk surfaced from a chat
// reply. These are not chat messages; they're a separate, project-scoped
// collection rendered in a side panel.
//
// This module owns:
//   - normalizeArtifact(raw) — canonicalize a record loaded from disk (or
//     posted by the UI) into the on-state shape, filling missing ids and
//     coercing createdAt. Safe against partial/legacy blobs.
//   - summarizeArtifact(artifact) — decorate with `createdLabel` for the UI;
//     called at serialization time, never mutates the stored artifact.
//   - extractArtifacts(reply, chat) — scan a model reply for fenced code
//     blocks and emit one artifact per non-empty block. The chat's id +
//     projectId become the artifact's owner refs; language comes from the
//     fence info string (``` language). Empty blocks are skipped.
//
// Extracted from desktopStore.js in the Phase 7b refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — only imports the shared
// date helpers.

import { randomUUID } from 'node:crypto';
import { nowIso, coerceIso, formatUpdatedAt } from '../../shared/helpers.js';

export function normalizeArtifact(artifact) {
  const out = {
    id: artifact?.id || randomUUID(),
    chatId: artifact?.chatId || null,
    projectId: artifact?.projectId || null,
    title: artifact?.title || 'Untitled artifact',
    kind: artifact?.kind || 'note',
    language: artifact?.language || 'text',
    content: typeof artifact?.content === 'string' ? artifact.content : '',
    createdAt: coerceIso(artifact?.createdAt),
  };
  // Preserve the soft-delete tombstone if it's a parseable ISO string.
  // Anything malformed gets dropped so a corrupt state.json can't keep
  // a row hidden forever.
  if (typeof artifact?.deletedAt === 'string' && Number.isFinite(Date.parse(artifact.deletedAt))) {
    out.deletedAt = artifact.deletedAt;
  }
  return out;
}

export function summarizeArtifact(artifact) {
  return {
    ...artifact,
    createdLabel: formatUpdatedAt(artifact.createdAt),
  };
}

/**
 * Scan a reply string for ```fence``` blocks and emit one artifact per
 * non-empty block. The chat supplies id + projectId; each artifact gets a
 * sequential "… snippet N" title to help disambiguate in the list.
 */
export function extractArtifacts(reply, chat) {
  const results = [];
  const codeBlockPattern = /```([\w.+-]+)?\n([\s\S]*?)```/g;
  let match;
  let index = 1;

  while ((match = codeBlockPattern.exec(reply))) {
    const [, language = 'text', content = ''] = match;
    const trimmed = content.trim();
    if (!trimmed) {
      continue;
    }

    results.push({
      id: randomUUID(),
      chatId: chat.id,
      projectId: chat.projectId || null,
      title: `${chat.title || 'Untitled chat'} snippet ${index}`,
      kind: 'code',
      language,
      content: trimmed,
      createdAt: nowIso(),
    });
    index += 1;
  }

  return results;
}
