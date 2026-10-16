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
    origin: artifact?.origin || (artifact?.kind === 'result' ? 'assistant-code' : 'user'),
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

/**
 * Predicate for "this artifact is live" — i.e. it exists and hasn't
 * been soft-deleted (`deletedAt` set by `deleteArtifact` until either
 * `restoreArtifact` clears it or `purgeStaleSoftDeletes` evicts the
 * row).  Every read path that surfaces artifact content to the UI,
 * the model, search results, or connectors MUST funnel through this
 * helper (or `visibleArtifacts` below).  Centralised so a new
 * reader can't silently leak a tombstoned row — Codex audit
 * 2026-04-27 caught four call sites that had been doing it ad-hoc.
 *
 * @param {Object|null|undefined} artifact
 * @returns {boolean}
 */
export function isLiveArtifact(artifact) {
  return Boolean(artifact) && !artifact.deletedAt;
}

/**
 * Filter helper: returns only the live (non-soft-deleted) entries.
 * Defensively coerces non-array input to `[]` so a partial state load
 * doesn't crash readers.
 *
 * @param {Array|null|undefined} artifacts
 * @returns {Array}
 */
export function visibleArtifacts(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).filter(isLiveArtifact);
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
      kind: 'result',
      origin: 'assistant-code',
      language,
      content: trimmed,
      createdAt: nowIso(),
    });
    index += 1;
  }

  return results;
}

export function isKnowledgeArtifact(artifact) { return isLiveArtifact(artifact) && artifact.kind !== 'result'; }
export function migrateLegacyResults(artifacts=[],chats=[]) {
  return artifacts.map(raw=>{
    if (raw.origin || raw.kind!=='code' || !raw.chatId || !/ snippet \d+$/.test(raw.title || '')) return normalizeArtifact(raw);
    const chat=chats.find(c=>c.id===raw.chatId);
    const matches=(chat?.messages || []).filter(m=>m.role==='assistant').some(m=>extractArtifacts(m.content || '',chat).some(a=>a.content===raw.content&&a.language===(raw.language||'text')));
    return normalizeArtifact(matches?{...raw,kind:'result',origin:'assistant-code'}:raw);
  });
}
