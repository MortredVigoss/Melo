// Agent memory-context system-prompt block — sub-phase 7d-5γ commit 4 of
// the desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Composes the per-turn memory-recall block that gives the agent visible
// access to: prior speaker memories/facts, group-participant facts (in
// Telegram supergroups), past self-corrections, prompt/approval/task
// memories, and a fallback path that reads from raw state when no
// recalled memories were available. Also marks recalled memory ids as
// `used` so the dreaming gate scorer can compute a goodOutcomes ratio.
//
// Bundled with the function: `latestUserMessageRecord`, a 5-line private
// helper used only inside `buildAgentMemoryNodeContext` to find the most
// recent user message in a chat. Same packaging pattern as commit 1
// (`COMMAND_TEMPLATES` + `commandTemplateDescriptor`) — keep tightly
// coupled helpers together rather than splitting them across files.
//
// All other upstream deps live in dedicated leaf modules already.

import { buildSpeakerMemoryNamespace } from '../../state/memorySnapshot.js';
import { recallMemories, markMemoriesUsed } from '../../memory/store.js';
import { atticEnabled, injectHotAttic } from '../../memory/attic.js';
import {
  buildIdentityLine,
  buildSpeakerProfileBlock,
  shouldCompactSpeakerFacts,
} from '../../memory/speakerProfile.js';
import { normalizeConversationSnippet } from '../../memory/heuristics.js';
import { normalizePromptHistory } from '../activity/activityLog.js';
import { normalizeApprovals } from '../approval/approvalService.js';
import { normalizeTasks } from '../task/taskService.js';

function latestUserMessageRecord(chat) {
  return [...(Array.isArray(chat?.messages) ? chat.messages : [])]
    .reverse()
    .find(message => message?.role === 'user') || null;
}

export function buildAgentMemoryNodeContext({
  state,
  chat,
  latestUserMessage = '',
  activeAgentProfile,
  project,
  queryEmbedding = null,
}) {
  const namespaces = [chat?.id ? `chat:${chat.id}` : '', project?.id ? `project:${project.id}` : '', activeAgentProfile?.id ? `agent:${activeAgentProfile.id}` : ''].filter(Boolean);
  const currentSpeakerMessage = latestUserMessageRecord(chat);
  const currentSpeakerNamespace = buildSpeakerMemoryNamespace({
    chat,
    message: currentSpeakerMessage,
    agentId: activeAgentProfile?.id,
  });
  const currentSpeakerLabel =
    currentSpeakerMessage?.senderName ||
    currentSpeakerMessage?.senderUsername ||
    currentSpeakerMessage?.senderId ||
    'Current speaker';
  const speakerMemories = currentSpeakerNamespace
    ? recallMemories({
        namespaces: [currentSpeakerNamespace],
        kinds: ['prompt'],
        query: latestUserMessage,
        queryEmbedding,
        limit: 10,
      }).filter(entry =>
        entry.metadata?.messageId !== currentSpeakerMessage?.id &&
        (!entry.metadata?.chatId || entry.metadata?.chatId === chat?.id)
      )
    : [];
  const speakerFacts = currentSpeakerNamespace
    ? recallMemories({
        namespaces: [currentSpeakerNamespace],
        kinds: ['fact'],
        query: latestUserMessage,
        queryEmbedding,
        limit: 8,
      })
    : [];

  // In group chats, also load facts for OTHER participants so the bot knows
  // who each person is when someone refers to a group member by name.
  const isGroupChat =
    chat?.chatType === 'group' || chat?.chatType === 'supergroup';
  const otherParticipantFacts = (() => {
    if (!isGroupChat || !activeAgentProfile?.id) return [];
    const agentId = activeAgentProfile.id;
    const otherNamespaces = (Array.isArray(chat?.messages) ? chat.messages : [])
      .filter(msg => {
        if (msg?.role !== 'user') return false;
        const senderId = String(msg?.senderId || '').trim();
        if (!senderId) return false;
        // Exclude the current speaker — their facts are already in speakerFacts
        const ns = buildSpeakerMemoryNamespace({ chat, message: msg, agentId });
        return ns && ns !== currentSpeakerNamespace;
      })
      .reduce((acc, msg) => {
        const ns = buildSpeakerMemoryNamespace({ chat, message: msg, agentId });
        if (ns && !acc.has(ns)) acc.set(ns, msg?.senderName || msg?.senderUsername || msg?.senderId);
        return acc;
      }, new Map());

    const results = [];
    for (const [ns, label] of otherNamespaces) {
      const facts = recallMemories({
        namespaces: [ns],
        kinds: ['fact'],
        query: latestUserMessage,
        queryEmbedding,
        limit: 3,
      });
      if (facts.length) {
        results.push({ label, facts });
      }
    }
    return results;
  })();

  // Past self-corrections: query from agent namespace so mistakes accumulate
  // across all chats and don't repeat in future turns.
  const pastCorrections = activeAgentProfile?.id
    ? recallMemories({
        namespaces: [`agent:${activeAgentProfile.id}`],
        kinds: ['verification-correction', 'session-fact'],
        query: latestUserMessage,
        queryEmbedding,
        limit: 6,
      })
    : [];

  const promptHistory = recallMemories({
    namespaces,
    kinds: ['prompt'],
    query: latestUserMessage,
    queryEmbedding,
    limit: 12,
  }).filter(entry =>
    !entry.metadata?.chatId || entry.metadata?.chatId === chat?.id
  );
  const relatedApprovals = recallMemories({
    namespaces,
    kinds: ['approval'],
    query: latestUserMessage,
    queryEmbedding,
    limit: 6,
  }).filter(entry =>
    !entry.metadata?.chatId ||
    entry.metadata?.chatId === chat?.id ||
    (project?.id && entry.metadata?.projectId === project.id)
  );
  const relatedTasks = recallMemories({
    namespaces,
    kinds: ['task'],
    query: latestUserMessage,
    queryEmbedding,
    limit: 6,
  }).filter(entry =>
    !entry.metadata?.chatId ||
    entry.metadata?.chatId === chat?.id ||
    (project?.id && entry.metadata?.projectId === project.id)
  );
  const blocks = [];

  // Track which memory rows actually end up rendered into a prompt block.
  // We feed these ids to markMemoriesUsed() at the tail of this function so
  // that the dreaming gate scorer sees a real `goodOutcomes / hits` ratio.
  const usedIds = new Set();
  const markUsed = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      const id = entry?.id;
      if (id) usedIds.add(id);
    }
  };

  // Hot attic — the always-on memory block that stays visible even when
  // downstream blocks get trimmed.  Keeps corrections, decisions, and
  // frequently-used facts at the top of the prompt.
  if (atticEnabled()) {
    const hotBlock = injectHotAttic({ namespaces });
    if (hotBlock) blocks.push(hotBlock);
  }

  if (speakerFacts.length) {
    markUsed(speakerFacts);
    // L0 identity line — always emitted when any singleton fact is known.
    // This is the cheapest memory layer (~50 tokens) and survives even when
    // the full facts block is later suppressed for token-budget reasons.
    const identityLine = buildIdentityLine(speakerFacts, {
      label: currentSpeakerLabel,
    });
    if (identityLine) {
      blocks.push(`Speaker identity: ${identityLine}`);
    }

    // Long Telegram DMs accumulate many speaker facts.  Once the relevant
    // recall window is mostly full (≥ SPEAKER_PROFILE_COMPACT_THRESHOLD),
    // swap the enumerated bulleted list for a condensed category-grouped
    // profile block that preserves the same signal in ~half the tokens.
    if (shouldCompactSpeakerFacts(speakerFacts)) {
      const condensed = buildSpeakerProfileBlock(speakerFacts, {
        label: currentSpeakerLabel,
      });
      if (condensed) {
        blocks.push(condensed);
      }
    } else {
      blocks.push(
        `Current speaker fact nodes (${currentSpeakerLabel}):\n${speakerFacts
          .map(entry => {
            const sourceText = normalizeConversationSnippet(entry.metadata?.sourceText || '', 140);
            return `- ${entry.text}${sourceText ? ` :: from "${sourceText}"` : ''}`;
          })
          .join('\n')}`,
      );
    }
  }

  if (speakerMemories.length) {
    markUsed(speakerMemories);
    blocks.push(
      `Current speaker memory nodes (${currentSpeakerLabel}):\n${speakerMemories
        .map(entry => {
          const snippet = normalizeConversationSnippet(entry.text, 180);
          const chatTitle = normalizeConversationSnippet(entry.metadata?.chatTitle || '', 80);
          return `- ${snippet}${chatTitle ? ` :: from ${chatTitle}` : ''}`;
        })
        .join('\n')}`,
    );
  }

  // Inject known facts for other group participants so the bot can recognise
  // and correctly attribute statements about them made by the current speaker.
  if (otherParticipantFacts.length) {
    for (const { label, facts } of otherParticipantFacts) {
      markUsed(facts);
      if (shouldCompactSpeakerFacts(facts)) {
        const condensed = buildSpeakerProfileBlock(facts, { label });
        if (condensed) {
          blocks.push(condensed.replace(
            /^Speaker profile/,
            'Group participant profile',
          ));
        }
      } else {
        blocks.push(
          `Known facts about group participant (${label}):\n${facts
            .map(entry => {
              const sourceText = normalizeConversationSnippet(entry.metadata?.sourceText || '', 120);
              return `- ${entry.text}${sourceText ? ` :: from "${sourceText}"` : ''}`;
            })
            .join('\n')}`,
        );
      }
    }
  }

  if (pastCorrections.length) {
    markUsed(pastCorrections);
    blocks.push(
      `Past self-corrections (facts I previously got wrong and corrected):\n${pastCorrections
        .map(entry => `- ${normalizeConversationSnippet(entry.text, 200)}`)
        .join('\n')}`,
    );
  }

  if (promptHistory.length) {
    markUsed(promptHistory);
    blocks.push(
      `Prompt memory nodes:\n${promptHistory
        .map(entry => `- ${normalizeConversationSnippet(entry.text, 180)}`)
        .join('\n')}`,
    );
  }

  if (relatedApprovals.length) {
    markUsed(relatedApprovals);
    blocks.push(
      `Approval memory nodes:\n${relatedApprovals
        .map(entry => {
          const title = entry.metadata?.title || entry.text;
          const status = entry.metadata?.status || 'unknown';
          const resultSummary = entry.metadata?.resultSummary || '';
          return `- ${title} [${status}]${resultSummary ? ` :: ${resultSummary}` : ''}`;
        })
        .join('\n')}`,
    );
  }

  if (relatedTasks.length) {
    markUsed(relatedTasks);
    blocks.push(
      `Task memory nodes:\n${relatedTasks
        .map(entry => {
          const title = entry.metadata?.title || entry.text;
          const status = entry.metadata?.status || 'unknown';
          const latestNote = entry.metadata?.latestNote || '';
          return `- ${title} [${status}]${latestNote ? ` :: ${normalizeConversationSnippet(latestNote, 160)}` : ''}`;
        })
        .join('\n')}`,
    );
  }

  if (!blocks.length) {
    const fallbackPromptHistory = normalizePromptHistory(state?.settings?.promptHistory)
      .filter(entry => entry.chatId === chat?.id)
      .slice(0, 4);
    const fallbackApprovals = normalizeApprovals(state?.approvals)
      .filter(
        approval =>
          approval.chatId === chat?.id ||
          (project?.id && approval.projectId === project.id),
      )
      .slice(0, 3);
    const fallbackTasks = normalizeTasks(state?.tasks)
      .filter(
        task =>
          task.chatId === chat?.id ||
          (project?.id && task.projectId === project.id) ||
          task.owner === activeAgentProfile?.id,
      )
      .slice(0, 3);

    if (fallbackPromptHistory.length) {
      blocks.push(
        `Prompt memory nodes:\n${fallbackPromptHistory
          .map(entry => `- ${normalizeConversationSnippet(entry.content, 180)}`)
          .join('\n')}`,
      );
    }

    if (fallbackApprovals.length) {
      blocks.push(
        `Approval memory nodes:\n${fallbackApprovals
          .map(
            approval =>
              `- ${approval.title} [${approval.status}]${
                approval.resultSummary ? ` :: ${approval.resultSummary}` : ''
              }`,
          )
          .join('\n')}`,
      );
    }

    if (fallbackTasks.length) {
      blocks.push(
        `Task memory nodes:\n${fallbackTasks
          .map(
            task =>
              `- ${task.title} [${task.status}]${
                task.latestNote
                  ? ` :: ${normalizeConversationSnippet(task.latestNote, 160)}`
                  : ''
              }`,
          )
          .join('\n')}`,
      );
    }
  }

  if (latestUserMessage) {
    blocks.push(
      `Current intent node:\n- Latest user turn: ${normalizeConversationSnippet(latestUserMessage, 220)}`,
    );
  }

  // Feedback signal to dreaming gates: memories that actually got rendered
  // into a prompt block are flagged `outcome='used'`.  Best-effort — a failure
  // here must not break recall.
  if (usedIds.size) {
    try { markMemoriesUsed([...usedIds]); } catch {}
  }

  return blocks.join('\n\n');
}
