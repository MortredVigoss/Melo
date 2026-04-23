/**
 * Phase 3D — background skill-proposal clustering.
 *
 * This module scans recent chat / task activity and proposes candidate
 * skills the user might want to save. It is intentionally offline,
 * synchronous, and free of I/O — the job scheduler calls it with a window
 * of activity, it returns an array of proposals, and the caller persists
 * them into an in-memory store. A `/api/skill-proposals` route can then
 * serve the store to the UI.
 *
 * Why regex / keyword heuristics instead of embeddings?
 *   - We run per-turn in the polling loop; can't afford a 200ms embedding
 *     call per message.
 *   - The threshold the user asked for is coarse: "tool_call count >= 3
 *     AND (involves external connectors OR file writes)". That is already
 *     a structural signal; similarity clustering is a nice-to-have.
 *   - LLM drafting happens *after* clustering (via
 *     draftSkillFromConversation), so the heuristic just needs to be
 *     precise enough to avoid noisy suggestions.
 */

import {
  UPGRADE_SIMILARITY_THRESHOLD,
  computeSkillCandidateSimilarity,
  buildUpgradeProposal,
} from './skillUpgrade.js';

const DEFAULT_MIN_TOOL_CALLS = 3;
const DEFAULT_MAX_TURNS_SCANNED = 200;
const DEFAULT_CLUSTER_SIMILARITY = 0.5;

// Heuristic lists — kept inline so adjustments don't fan out across files.
// The match is substring-based (case-insensitive) on the tool id.
const CONNECTOR_TOOL_HINTS = [
  'telegram',
  'slack',
  'gmail',
  'calendar',
  'notion',
  'linear',
  'github',
  'jira',
  'discord',
  'mcp:', // any MCP tool
  'connector',
  'webhook',
];

const FILE_WRITE_TOOL_HINTS = [
  'file_write',
  'write_file',
  'save_file',
  'create_artifact',
  'apply_artifact',
  'save_workspace_file',
  'docx',
  'xlsx',
  'pdf',
  'pptx',
];

function toolIdMatchesAny(toolId, hints) {
  if (!toolId) return false;
  const lc = String(toolId).toLowerCase();
  return hints.some(h => lc.includes(h));
}

/**
 * Extract tool invocations from a list of messages. We accept the two
 * shapes the pipeline actually produces:
 *   - A message with `role:'tool'` and a `toolName` field (our parser
 *     output).
 *   - An assistant message whose content contains `<tool_call>…</tool_call>`
 *     blocks with a `"name"` field.
 *
 * Returns an array of `{ turnIndex, toolId, args }`.
 */
export function extractToolCallsFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool' && m.toolName) {
      out.push({ turnIndex: i, toolId: String(m.toolName), args: m.args || null });
      continue;
    }
    if ((m.role === 'assistant' || m.role === 'user') && typeof m.content === 'string') {
      const re = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
      let match;
      while ((match = re.exec(m.content)) !== null) {
        try {
          const parsed = JSON.parse(match[1]);
          if (parsed && typeof parsed.name === 'string') {
            out.push({ turnIndex: i, toolId: parsed.name, args: parsed.arguments || null });
          }
        } catch {
          // Swallow parse failures — a malformed <tool_call> block is not
          // strong evidence of a skill candidate.
        }
      }
    }
  }
  return out;
}

/**
 * Compute a rough similarity score between two tool-call sequences.
 * Score is Jaccard over the multiset of tool ids — 0 means disjoint,
 * 1 means identical distribution. Order-insensitive by design; a sequence
 * that uses the same tools in a different order is still a reasonable
 * cluster candidate.
 */
function toolCallSimilarity(a, b) {
  const toSet = arr => new Set(arr.map(tc => tc.toolId.toLowerCase()));
  const A = toSet(a);
  const B = toSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Group an activity log into per-chat sequences. We treat a chat id as a
 * natural cluster boundary — the user's intent is usually consistent
 * within one chat, while two different chats probably represent two
 * different workflows.
 */
function groupByChat(activities) {
  const out = new Map();
  for (const a of activities) {
    const key = a.chatId || a.taskId || '__unscoped__';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(a);
  }
  return out;
}

/**
 * Build a human-readable summary of a sequence — used as the proposal's
 * title until the user asks for a full LLM draft.
 */
function summarizeSequence(sequence) {
  const counts = new Map();
  for (const tc of sequence.toolCalls) {
    counts.set(tc.toolId, (counts.get(tc.toolId) || 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => (n > 1 ? `${id} ×${n}` : id));
  return `Uses ${parts.join(', ')}`;
}

/**
 * Core proposal heuristic.
 *
 * Input: an array of "activity" records — `{ chatId, messages, taskId }`.
 * Output: an array of skill proposals, newest first.
 *
 * A proposal is emitted when a single activity has:
 *   - at least `minToolCalls` tool invocations, AND
 *   - at least one external connector call OR at least one file-writing
 *     tool call (the "external effect" gate the user asked for).
 *
 * When multiple activities match and their tool-call sets are similar
 * (Jaccard ≥ clusterSimilarity), we merge them into a single proposal
 * carrying multiple sample turn-windows. That's the "clustering" piece.
 */
/**
 * Skills that Melo ships itself (source === 'melo-bundle') — and any
 * built-in skills — are considered read-only to the upgrade flow: they
 * can only be modified by backend code / a new install, never via a
 * user-facing upgrade proposal. Keeping them out of the candidate set
 * means that when a user's activity strongly resembles a bundled skill,
 * we fall through to a "create a new (user-owned) skill" proposal and
 * future evolution happens on that new user skill instead.
 */
function isUpgradableSkill(skill) {
  if (!skill) return false;
  if (skill.source === 'melo-bundle') return false;
  // Built-in skills are in-memory only and not in customSkills anyway,
  // but guard here too so accidental inclusion is safe.
  if (skill.origin === 'built-in') return false;
  return true;
}

/**
 * Given a cluster built during proposal clustering, find the existing
 * skill it most closely resembles. Returns `{ skill, score }` when the
 * best match clears `threshold`, otherwise null.
 *
 * Bundled / built-in skills are filtered out before matching so the
 * upgrade flow never targets them.
 */
function pickBestMatchingSkill(cluster, existingSkills, threshold) {
  if (!Array.isArray(existingSkills) || existingSkills.length === 0) return null;
  let best = null;
  for (const skill of existingSkills) {
    if (!isUpgradableSkill(skill)) continue;
    const score = computeSkillCandidateSimilarity(skill, cluster);
    if (score >= threshold && (best === null || score > best.score)) {
      best = { skill, score };
    }
  }
  return best;
}

export function proposeSkillsFromActivity(activities, {
  minToolCalls = DEFAULT_MIN_TOOL_CALLS,
  clusterSimilarity = DEFAULT_CLUSTER_SIMILARITY,
  maxTurnsScanned = DEFAULT_MAX_TURNS_SCANNED,
  // Phase 3.4.2: when provided, clusters that strongly resemble an
  // existing skill are emitted as upgrade proposals instead of create
  // proposals. Empty/undefined means "always create" (the old behavior).
  existingSkills = [],
  upgradeThreshold = UPGRADE_SIMILARITY_THRESHOLD,
  nowFn = () => Date.now(),
} = {}) {
  if (!Array.isArray(activities)) return [];

  // Step 1: per-activity extraction.
  const candidates = [];
  for (const activity of activities) {
    const msgs = Array.isArray(activity?.messages) ? activity.messages.slice(-maxTurnsScanned) : [];
    if (msgs.length === 0) continue;
    const toolCalls = extractToolCallsFromMessages(msgs);
    if (toolCalls.length < minToolCalls) continue;
    const involvesConnectors = toolCalls.some(tc => toolIdMatchesAny(tc.toolId, CONNECTOR_TOOL_HINTS));
    const involvesWrites = toolCalls.some(tc => toolIdMatchesAny(tc.toolId, FILE_WRITE_TOOL_HINTS));
    if (!involvesConnectors && !involvesWrites) continue;
    candidates.push({
      chatId: activity.chatId || null,
      taskId: activity.taskId || null,
      toolCalls,
      messages: msgs,
      involvesConnectors,
      involvesWrites,
    });
  }
  if (candidates.length === 0) return [];

  // Step 2: per-chat clustering so repeated workflows in the same chat
  // collapse into a single proposal.
  const byChat = groupByChat(candidates);
  const proposals = [];
  for (const [chatId, seqs] of byChat.entries()) {
    const clusters = [];
    for (const seq of seqs) {
      let placed = false;
      for (const cl of clusters) {
        if (toolCallSimilarity(cl.toolCalls, seq.toolCalls) >= clusterSimilarity) {
          cl.samples.push(seq);
          cl.toolCalls = cl.toolCalls.concat(seq.toolCalls);
          placed = true;
          break;
        }
      }
      if (!placed) {
        clusters.push({
          chatId,
          toolCalls: seq.toolCalls.slice(),
          samples: [seq],
        });
      }
    }
    for (const cl of clusters) {
      // Phase 3.4.2: if this cluster strongly resembles an existing
      // skill, emit an upgrade proposal targeting that skill. Otherwise
      // fall back to the original "create new skill" proposal path.
      const match = pickBestMatchingSkill(cl, existingSkills, upgradeThreshold);
      if (match) {
        const upgrade = buildUpgradeProposal(match.skill, cl, { nowFn });
        if (upgrade) {
          upgrade.similarityScore = match.score;
          proposals.push(upgrade);
          continue;
        }
      }
      proposals.push({
        seedId: `proposal-${cl.chatId || 'unscoped'}-${nowFn()}-${proposals.length}`,
        kind: 'create',
        chatId: cl.chatId,
        occurrences: cl.samples.length,
        toolCallCount: cl.toolCalls.length,
        involvesConnectors: cl.samples.some(s => s.involvesConnectors),
        involvesWrites: cl.samples.some(s => s.involvesWrites),
        summary: summarizeSequence(cl),
        sampleMessages: cl.samples[0].messages,
        createdAt: nowFn(),
      });
    }
  }

  // Step 3: newest first (a proposal derived from today is more relevant
  // than one from a week ago).
  proposals.sort((a, b) => b.createdAt - a.createdAt);
  return proposals;
}

// ─── In-memory proposal store for /api/skill-proposals ───────────────────────
//
// The server wires this as a singleton and exposes it read-only. Dismissed
// proposals are remembered by `dismissedIds` so the polling job doesn't
// keep resuggesting them.

export function createSkillProposalStore({
  maxEntries = 50,
  nowFn = () => Date.now(),
} = {}) {
  const proposals = new Map(); // seedId -> proposal
  const dismissed = new Set(); // seedId

  function prune() {
    if (proposals.size <= maxEntries) return;
    // Drop the oldest by createdAt until we fit.
    const sorted = Array.from(proposals.values()).sort((a, b) => a.createdAt - b.createdAt);
    const toDrop = sorted.length - maxEntries;
    for (let i = 0; i < toDrop; i++) proposals.delete(sorted[i].seedId);
  }

  return {
    addMany(batch) {
      let added = 0;
      for (const p of batch) {
        if (!p?.seedId) continue;
        if (dismissed.has(p.seedId)) continue;
        if (proposals.has(p.seedId)) continue; // dedupe by seedId
        proposals.set(p.seedId, { ...p, persistedAt: nowFn() });
        added++;
      }
      prune();
      return added;
    },
    list() {
      return Array.from(proposals.values()).sort((a, b) => b.createdAt - a.createdAt);
    },
    get(seedId) {
      return proposals.get(seedId) || null;
    },
    dismiss(seedId) {
      if (!seedId) return false;
      dismissed.add(seedId);
      return proposals.delete(seedId);
    },
    clear() {
      proposals.clear();
      dismissed.clear();
    },
    size() {
      return proposals.size;
    },
    isDismissed(seedId) {
      return dismissed.has(seedId);
    },
  };
}

export const defaultSkillProposalStore = createSkillProposalStore();

// ─── Test exports ───────────────────────────────────────────────────────────
export const __internals__ = {
  CONNECTOR_TOOL_HINTS,
  FILE_WRITE_TOOL_HINTS,
  toolIdMatchesAny,
  toolCallSimilarity,
  summarizeSequence,
  isUpgradableSkill,
  pickBestMatchingSkill,
};
