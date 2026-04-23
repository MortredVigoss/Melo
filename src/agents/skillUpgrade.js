/**
 * Phase 3.4.2 — Skill self-upgrade.
 *
 * When the pattern-detection scanner (proposeSkillsFromActivity) sees a
 * workflow that is already covered by an existing skill, it shouldn't
 * propose a brand-new one — it should propose an *upgrade* to the
 * existing skill, adding freshly-observed triggers, a short appendix to
 * the system prompt, and a reference file capturing the recent sample.
 *
 * This module provides:
 *   - computeSkillCandidateSimilarity(skill, candidate) → 0..1
 *   - buildUpgradeProposal(skill, candidate, options)   → upgrade proposal
 *
 * `candidate` here is the internal cluster shape built by
 * proposeSkillsFromActivity: { chatId, toolCalls[], samples[], ... }.
 * For convenience we also accept the externally-facing proposal shape
 * ({ sampleMessages, occurrences, ... }).
 */

import { tokenizeForMatch } from './skillMatcher.js';

// If a candidate's similarity to an existing skill is at least this,
// we prefer emitting an upgrade proposal rather than a create proposal.
// 0.45 was chosen empirically in tests — high enough that
// "trigger/tool overlap is real", low enough that the scanner actually
// upgrades skills rather than always creating new ones.
export const UPGRADE_SIMILARITY_THRESHOLD = 0.45;

// ─── Similarity ─────────────────────────────────────────────────────────────
//
// A blend of three signals:
//   - trigger-keyword overlap  (does the candidate text mention the skill's
//                               own triggers? high-confidence signal)
//   - tool-id overlap          (do the tools used in the candidate match
//                               the skill's allowed-tools or the tools
//                               mentioned in its description/prompt?)
//   - token overlap            (how many of the candidate's keywords show
//                               up in the skill's description/system
//                               prompt? weakest but useful tie-breaker)
//
// Weights: triggers 0.45, tools 0.35, tokens 0.20. Triggers are
// human-authored intent so we weight them heaviest; tokens are noisy so
// we cap their contribution.

export function computeSkillCandidateSimilarity(skill, candidate) {
  if (!skill) return 0;
  const messages = extractSampleMessages(candidate);
  const candidateText = messages.map(m => String(m.content || '')).join(' ');
  if (!candidateText.trim()) return 0;

  const candidateTokens = new Set(tokenizeForMatch(candidateText));
  const candidateToolIds = extractToolIds(candidate);

  // Trigger signal
  const triggers = Array.isArray(skill.triggers) ? skill.triggers : [];
  const hay = candidateText.toLowerCase();
  let triggerHits = 0;
  for (const t of triggers) {
    const needle = String(t || '').toLowerCase().trim();
    if (!needle) continue;
    if (hay.includes(needle)) triggerHits += 1;
  }
  const triggerScore = triggers.length > 0
    ? Math.min(1, triggerHits / Math.min(triggers.length, 4))
    : 0;

  // Tool signal
  const skillTools = new Set(
    (Array.isArray(skill.toolWhitelist) ? skill.toolWhitelist : [])
      .map(t => String(t).toLowerCase()),
  );
  let toolScore = 0;
  if (candidateToolIds.size > 0) {
    if (skillTools.size > 0) {
      let hits = 0;
      for (const id of candidateToolIds) {
        for (const st of skillTools) {
          if (id === st || id.includes(st) || st.includes(id)) {
            hits += 1;
            break;
          }
        }
      }
      toolScore = hits / Math.max(candidateToolIds.size, skillTools.size);
    } else {
      // No allow-list on the skill — fall back to checking if tool names
      // (or their bare prefix, e.g. "slack" from "slack.send") appear in
      // the skill's description or system prompt.
      const haystack = (
        String(skill.description || '') + ' ' + String(skill.systemPrompt || '')
      ).toLowerCase();
      let hits = 0;
      for (const id of candidateToolIds) {
        const bare = String(id).split(/[._-]/)[0];
        if (bare && haystack.includes(bare)) hits += 1;
      }
      toolScore = hits / candidateToolIds.size;
    }
  }

  // Token signal
  const skillTokens = new Set([
    ...tokenizeForMatch(skill.description || ''),
    ...tokenizeForMatch(skill.systemPrompt || ''),
    ...(Array.isArray(skill.tags) ? skill.tags.flatMap(t => tokenizeForMatch(String(t))) : []),
  ]);
  let overlap = 0;
  for (const tok of candidateTokens) {
    if (skillTokens.has(tok)) overlap += 1;
  }
  // Normalize against the smaller of the two sets, but cap the denominator
  // so a tiny candidate with one incidental overlap doesn't score 1.0.
  const tokenScore = candidateTokens.size > 0
    ? Math.min(1, overlap / Math.max(6, Math.min(candidateTokens.size, 40)))
    : 0;

  return 0.45 * triggerScore + 0.35 * toolScore + 0.20 * tokenScore;
}

// ─── Upgrade proposal builder ───────────────────────────────────────────────

export function buildUpgradeProposal(skill, candidate, {
  nowFn = () => Date.now(),
  seedId = null,
  maxTriggersToAdd = 4,
  maxSampleMessages = 8,
} = {}) {
  if (!skill || !skill.id) return null;

  const messages = extractSampleMessages(candidate);
  const toolIds = [...extractToolIds(candidate)];
  const chatId = candidate?.chatId || candidate?.samples?.[0]?.chatId || null;
  const occurrences = candidate?.occurrences
    || (Array.isArray(candidate?.samples) ? candidate.samples.length : 1);

  // Propose new trigger keywords derived from high-frequency user tokens
  // that aren't already in the skill's trigger list.
  const existing = new Set(
    (Array.isArray(skill.triggers) ? skill.triggers : [])
      .map(t => String(t).toLowerCase()),
  );
  const userText = messages
    .filter(m => !m.role || m.role === 'user')
    .map(m => String(m.content || ''))
    .join(' ');
  const freq = new Map();
  for (const tok of tokenizeForMatch(userText)) {
    if (tok.length < 2) continue;
    freq.set(tok, (freq.get(tok) || 0) + 1);
  }
  const triggersToAdd = [...freq.entries()]
    .filter(([tok, count]) => count >= 2 && !existing.has(tok) && !isStopwordish(tok))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTriggersToAdd)
    .map(([tok]) => tok);

  // Short appendix the user will see attached to the skill's systemPrompt
  // on apply. Kept terse — the value is "here's recent evidence", not
  // a full rewrite.
  const dateStr = new Date(nowFn()).toISOString().slice(0, 10);
  const systemPromptAppendix = [
    '',
    `## Recent pattern (observed ${dateStr})`,
    `- Chat: ${chatId || '(unscoped)'} — ${occurrences} recent run${occurrences === 1 ? '' : 's'}`,
    `- Tools: ${toolIds.slice(0, 6).join(', ') || '(none captured)'}`,
    triggersToAdd.length
      ? `- New trigger hints: ${triggersToAdd.join(', ')}`
      : '- No new trigger hints extracted.',
  ].join('\n');

  // Reference markdown — goes into skill's references/ folder on apply.
  const referenceDraft = renderReferenceDraft({
    skill,
    chatId,
    occurrences,
    toolIds,
    triggersToAdd,
    messages: messages.slice(0, maxSampleMessages),
    dateStr,
  });

  return {
    seedId: seedId || `upgrade-${skill.id}-${nowFn()}`,
    kind: 'upgrade',
    targetSkillId: skill.id,
    targetSkillName: skill.name || skill.id,
    chatId,
    occurrences,
    toolCallCount: (candidate?.toolCalls?.length) ?? toolIds.length,
    triggersToAdd,
    systemPromptAppendix,
    referenceFileName: `${dateStr}.md`,
    referenceDraft,
    summary: triggersToAdd.length > 0
      ? `Upgrade "${skill.name || skill.id}" — add ${triggersToAdd.length} trigger${triggersToAdd.length === 1 ? '' : 's'} + 1 reference`
      : `Upgrade "${skill.name || skill.id}" — add reference sample`,
    sampleMessages: messages.slice(0, 6),
    createdAt: nowFn(),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractSampleMessages(candidate) {
  if (!candidate) return [];
  if (Array.isArray(candidate.sampleMessages)) return candidate.sampleMessages;
  if (Array.isArray(candidate.samples) && candidate.samples.length > 0) {
    const first = candidate.samples[0];
    if (Array.isArray(first?.messages)) return first.messages;
  }
  if (Array.isArray(candidate.messages)) return candidate.messages;
  return [];
}

function extractToolIds(candidate) {
  const ids = new Set();
  const toolCalls = Array.isArray(candidate?.toolCalls) ? candidate.toolCalls : [];
  for (const tc of toolCalls) {
    if (tc?.toolId) ids.add(String(tc.toolId).toLowerCase());
  }
  // Also check samples[].toolCalls if present (clustering shape).
  if (Array.isArray(candidate?.samples)) {
    for (const s of candidate.samples) {
      if (Array.isArray(s?.toolCalls)) {
        for (const tc of s.toolCalls) {
          if (tc?.toolId) ids.add(String(tc.toolId).toLowerCase());
        }
      }
    }
  }
  return ids;
}

// A tiny stop-word filter so we don't propose "the/and/that" as triggers.
// English + a handful of high-frequency Chinese tokens that tokenizeForMatch
// will pick up on its own.
const STOPWORDISH = new Set([
  'the', 'and', 'for', 'but', 'are', 'that', 'this', 'with', 'from',
  'you', 'your', 'into', 'not', 'was', 'can', 'will', 'has', 'have',
  '的', '了', '和', '是', '在', '我', '你', '他', '她', '它', '这', '那',
  '一', '一个', '请', '帮', '给', '把', '又', '也', '都', '很',
]);
function isStopwordish(tok) {
  return STOPWORDISH.has(tok);
}

function renderReferenceDraft({
  skill, chatId, occurrences, toolIds, triggersToAdd, messages, dateStr,
}) {
  const lines = [
    `# Upgrade evidence (${dateStr})`,
    '',
    `Collected from chat \`${chatId || '(unscoped)'}\` as evidence that the \`${skill.id}\` pattern is still active.`,
    `Observed ${occurrences} recent run${occurrences === 1 ? '' : 's'}.`,
    '',
    '## Tools seen',
    toolIds.slice(0, 10).map(t => `- \`${t}\``).join('\n') || '- (none captured)',
    '',
    '## Suggested new triggers',
    triggersToAdd.length
      ? triggersToAdd.map(t => `- \`${t}\``).join('\n')
      : '- (no additions proposed)',
    '',
    '## Sample messages',
  ];
  for (const m of messages) {
    const role = m.role || 'user';
    const raw = String(m.content || '').replace(/\s+/g, ' ').trim();
    const text = raw.length > 500 ? raw.slice(0, 500) + '…' : raw;
    lines.push(`- **${role}**: ${text || '(empty)'}`);
  }
  return lines.join('\n') + '\n';
}
