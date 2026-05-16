// Memory-snapshot pipeline — Phase 7d-5α-A1 (commit 5/9).
//
// Single responsibility: convert the in-memory desktop state into the
// flat `[{id, namespace, kind, text, ...}]` rows that the memory store
// (src/memory/store.js) keeps queryable. The actual write happens in
// `syncMemoryStoreSnapshot`, which calls `replaceMemories` with whatever
// `buildMemoryStoreEntries` produced. Errors are swallowed with a console
// warn so a failing memory write never blocks the state save itself.
//
// Why bundled this way:
//   • `syncMemoryStoreSnapshot` is called by `persistStateAtomically`
//     (commit 9 stateStore) — it has to be importable before stateStore
//     can move.
//   • `buildMemoryStoreEntries` is private to syncMemoryStoreSnapshot
//     (single caller). They migrate together.
//   • `buildSpeakerMemoryNamespace` was originally adjacent. It's used
//     by buildMemoryStoreEntries here AND by 3 sites in desktopStore
//     (inside buildAgentMemoryNodeContext — future 7d-5γ work). The
//     three external callers will import from this module.
//
// Per CLAUDE.md §5 (byte-for-byte rule), every body below is verbatim
// from desktopStore.js — only the `export` keyword + a file header
// were added.

import { join } from 'node:path';
import { getMeloHome } from '../config.js';
import {
  replaceMemories,
} from '../memory/store.js';
import {
  extractSpeakerFacts,
  getSpeakerFactStorageKey,
} from '../memory/speakerFacts.js';
import {
  enabledTiers,
} from '../memory/attic.js';
import {
  splitFrames,
  buildFrameEntry,
} from '../memory/frame.js';
import {
  applyMemoryContinuity,
} from '../memory/lifecycle.js';
import {
  groupIntoScenes,
  buildSceneEntry,
} from '../memory/scene.js';
import {
  normalizeExtractedMedia,
  memoryKindForExtractedMedia,
} from '../media/index.js';
import {
  messageVisibleText,
} from '../services/message/messageBlocks.js';
import {
  messageSearchText,
} from '../services/message/messageSearch.js';
import {
  messageTextForContext,
} from './chatThreadContext.js';
import {
  shouldSuppressAssistantContextText,
} from '../services/chat/contextFilters.js';
import {
  normalizePromptHistory,
} from '../services/activity/activityLog.js';
import {
  normalizeApprovals,
} from '../services/approval/approvalService.js';
import {
  normalizeTasks,
} from '../services/task/taskService.js';
import {
  allAgentIdsFromProfiles,
} from '../services/agent/agentLibrary.js';
import {
  normalizeAgentProfile,
} from './agentProfiles.js';
import {
  summarizeAgentPrompt,
} from '../services/chat/systemPrompt.js';
import {
  normalizeAgentStorageId,
  nowIso,
} from '../shared/helpers.js';

export function buildSpeakerMemoryNamespace({ chat, message, agentId = '' } = {}) {
  const source = String(chat?.source || '').trim().toLowerCase();
  const senderId = String(message?.senderId || '').trim();
  const normalizedAgentId = normalizeAgentStorageId(agentId || chat?.agentId || 'main');
  if (!source || source === 'desktop' || !senderId) {
    return '';
  }

  return `speaker:${source}:${normalizedAgentId}:${senderId}`;
}

export function buildMemoryStoreEntries(state) {
  const chatProjectMap = new Map(
    (state.chats || []).map(chat => [chat.id, chat.projectId || null]),
  );
  const entries = [];
  const speakerFactEntries = new Map();

  for (const entry of normalizePromptHistory(state.settings?.promptHistory)) {
    const namespaces = new Set();
    if (entry.chatId) {
      namespaces.add(`chat:${entry.chatId}`);
      const projectId = chatProjectMap.get(entry.chatId);
      if (projectId) {
        namespaces.add(`project:${projectId}`);
      }
    }

    for (const namespace of namespaces) {
      entries.push({
        id: `prompt:${namespace}:${entry.id}`,
        namespace,
        kind: 'prompt',
        sourceId: entry.id,
        text: entry.content,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        metadata: {
          chatId: entry.chatId || null,
          messageId: entry.messageId || null,
        },
      });
    }
  }

  for (const chat of Array.isArray(state.chats) ? state.chats : []) {
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    for (const message of messages) {
      const isUserMessage = message?.role === 'user';
      const isAssistantMessage = message?.role === 'assistant';
      // Index both user and assistant messages; skip system/tool messages.
      if (!isUserMessage && !isAssistantMessage) {
        continue;
      }

      // Speaker namespace only applies to user messages from external sources
      // (e.g. Telegram) that carry a senderId. Desktop keyboard input and AI
      // responses have no sender identity, so speakerNamespace is '' for them.
      const speakerNamespace = isUserMessage
        ? buildSpeakerMemoryNamespace({ chat, message })
        : '';
      const baseNamespaces = new Set();
      if (chat?.id) {
        baseNamespaces.add(`chat:${chat.id}`);
      }
      if (chat?.projectId) {
        baseNamespaces.add(`project:${chat.projectId}`);
      }
      if (speakerNamespace) {
        baseNamespaces.add(speakerNamespace);
      }

      // Index message text for ALL user and assistant messages.
      // Previously desktop user messages (no senderId) were excluded, and
      // assistant responses were never indexed — both gaps hurt search quality.
      const rawText = messageTextForContext(message);
      if (isAssistantMessage && shouldSuppressAssistantContextText(rawText)) {
        continue;
      }
      // Truncate long AI responses to keep the store manageable; user messages
      // are kept in full since they tend to be much shorter.
      const text = isAssistantMessage ? rawText.slice(0, 2000) : rawText;
      if (text) {
        for (const namespace of baseNamespaces) {
          entries.push({
            id: `message:${namespace}:${message.id}`,
            namespace,
            kind: 'prompt',
            sourceId: message.id,
            text,
            searchText: [
              messageSearchText(message),
              message?.senderName || '',
              message?.senderUsername || '',
              message?.senderId || '',
            ]
              .filter(Boolean)
              .join('\n'),
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
            metadata: {
              chatId: chat?.id || null,
              chatTitle: chat?.title || '',
              projectId: chat?.projectId || null,
              source: chat?.source || 'desktop',
              senderId: message?.senderId || null,
              senderName: message?.senderName || null,
              senderUsername: message?.senderUsername || null,
              messageId: message?.id || null,
            },
          });
        }
      }

      // Speaker fact extraction only applies to user messages that carry a
      // recognised sender (Telegram). AI responses do not produce facts.
      if (isUserMessage && speakerNamespace) {
        for (const fact of extractSpeakerFacts(messageVisibleText(message))) {
          const factKey = getSpeakerFactStorageKey(fact);
          if (!factKey) {
            continue;
          }

          const id = `fact:${speakerNamespace}:${factKey}`;
          speakerFactEntries.set(id, {
            id,
            namespace: speakerNamespace,
            kind: 'fact',
            sourceId: message.id,
            text: fact.text,
            searchText: [
              fact.text,
              fact.sourceText || '',
              messageSearchText(message),
              message?.senderName || '',
              message?.senderUsername || '',
              message?.senderId || '',
            ]
              .filter(Boolean)
              .join('\n'),
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
            metadata: {
              chatId: chat?.id || null,
              chatTitle: chat?.title || '',
              projectId: chat?.projectId || null,
              source: chat?.source || 'desktop',
              senderId: message?.senderId || null,
              senderName: message?.senderName || null,
              senderUsername: message?.senderUsername || null,
              messageId: message?.id || null,
              category: fact.category,
              sourceText: fact.sourceText || '',
            },
          });
        }
      }

      for (const media of normalizeExtractedMedia(message?.extractedMedia)) {
        if (!media?.text) {
          continue;
        }

        for (const namespace of baseNamespaces) {
          entries.push({
            id: `media:${namespace}:${message.id}:${media.attachmentId || media.kind}`,
            namespace,
            kind: memoryKindForExtractedMedia(media.kind),
            sourceId: message.id,
            text: media.text,
            searchText: [
              media.text,
              media.metadata?.title || '',
              media.metadata?.url || '',
              media.metadata?.siteName || '',
              media.metadata?.author || '',
            ]
              .filter(Boolean)
              .join('\n'),
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
              metadata: {
                ...(media.metadata || {}),
                attachmentId: media.attachmentId,
                originalKind: media.kind,
                chatId: chat?.id || null,
                chatTitle: chat?.title || '',
                projectId: chat?.projectId || null,
              messageId: message?.id || null,
              senderId: message?.senderId || null,
              senderName: message?.senderName || null,
              senderUsername: message?.senderUsername || null,
            },
          });
        }

        if (media.kind === 'transcript' && speakerNamespace) {
          for (const fact of extractSpeakerFacts(media.text)) {
            const factKey = getSpeakerFactStorageKey(fact);
            if (!factKey) {
              continue;
            }

            const id = `fact:${speakerNamespace}:${factKey}`;
            speakerFactEntries.set(id, {
              id,
              namespace: speakerNamespace,
              kind: 'fact',
              sourceId: message.id,
              text: fact.text,
              searchText: [
                fact.text,
                fact.sourceText || '',
                media.text.slice(0, 200),
              ]
                .filter(Boolean)
                .join('\n'),
              createdAt: message.createdAt,
              updatedAt: message.createdAt,
              metadata: {
                chatId: chat?.id || null,
                chatTitle: chat?.title || '',
                projectId: chat?.projectId || null,
                messageId: message?.id || null,
                senderId: message?.senderId || null,
                senderName: message?.senderName || null,
                senderUsername: message?.senderUsername || null,
                category: fact.category,
                sourceText: fact.sourceText || '',
                derivedFrom: 'audio-transcript',
              },
            });
          }
        }
      }
    }
  }

  entries.push(...speakerFactEntries.values());

  // Emit verification-correction entries from assistant messages that had a
  // CORRECTED verdict. These are scoped to the agent namespace so they surface
  // across all chats the agent participates in, helping it avoid repeating the
  // same mistake.
  for (const chat of Array.isArray(state.chats) ? state.chats : []) {
    const agentId = chat?.agentId ? normalizeAgentStorageId(chat.agentId) : null;
    if (!agentId) continue;
    const agentNamespace = `agent:${agentId}`;

    for (const message of Array.isArray(chat?.messages) ? chat.messages : []) {
      if (message?.role !== 'assistant') continue;
      const rec = message?.metadata?.verificationRecord;
      if (!rec || rec.verdict !== 'CORRECTED' || !rec.correction) continue;

      entries.push({
        id: `verification:${agentNamespace}:${message.id}`,
        namespace: agentNamespace,
        kind: 'verification-correction',
        sourceId: message.id,
        text: `Self-correction: I previously stated "${rec.claim || 'an uncertain claim'}" incorrectly. Correct answer: ${rec.correction}`,
        searchText: `${rec.claim || ''} ${rec.correction}`.toLowerCase().trim(),
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
        metadata: {
          chatId: chat?.id || null,
          messageId: message.id,
          claim: rec.claim || '',
          correction: rec.correction,
        },
      });
    }
  }

  for (const approval of normalizeApprovals(state.approvals)) {
    const namespaces = new Set();
    if (approval.chatId) {
      namespaces.add(`chat:${approval.chatId}`);
    }
    if (approval.projectId) {
      namespaces.add(`project:${approval.projectId}`);
    }

    for (const namespace of namespaces) {
      entries.push({
        id: `approval:${namespace}:${approval.id}`,
        namespace,
        kind: 'approval',
        sourceId: approval.id,
        text: [
          approval.title,
          approval.status,
          approval.description,
          approval.resultSummary,
        ]
          .filter(Boolean)
          .join('\n'),
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
        metadata: {
          title: approval.title,
          status: approval.status,
          resultSummary: approval.resultSummary || '',
          chatId: approval.chatId || null,
          projectId: approval.projectId || null,
        },
      });
    }
  }

  for (const task of normalizeTasks(state.tasks)) {
    const namespaces = new Set();
    if (task.chatId) {
      namespaces.add(`chat:${task.chatId}`);
    }
    if (task.projectId) {
      namespaces.add(`project:${task.projectId}`);
    }
    if (task.owner) {
      namespaces.add(`agent:${task.owner}`);
    }

    for (const namespace of namespaces) {
      entries.push({
        id: `task:${namespace}:${task.id}`,
        namespace,
        kind: 'task',
        sourceId: task.id,
        text: [task.title, task.status, task.latestNote].filter(Boolean).join('\n'),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        metadata: {
          title: task.title,
          status: task.status,
          latestNote: task.latestNote || '',
          owner: task.owner,
          chatId: task.chatId || null,
          projectId: task.projectId || null,
        },
      });
    }
  }

  for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    entries.push({
      id: `identity:agent:${agentId}`,
      namespace: `agent:${agentId}`,
      kind: 'identity',
      sourceId: agentId,
      text: summarizeAgentPrompt(profile),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      metadata: {
        agentId,
        name: profile.name,
      },
    });
  }

  // Scene + frame layers — built on top of the already-indexed messages.
  // Controlled by MELO_MEMORY_TIERS so the whole tier set can be turned off.
  const tiers = enabledTiers();
  if (tiers.has('frame') || tiers.has('scene')) {
    for (const chat of Array.isArray(state.chats) ? state.chats : []) {
      const messages = Array.isArray(chat?.messages) ? chat.messages : [];
      const frameSourceMessages = messages.filter(message =>
        message?.role !== 'assistant' ||
        !shouldSuppressAssistantContextText(messageTextForContext(message))
      );
      if (frameSourceMessages.length < 3) continue;

      const frameWindows = splitFrames(frameSourceMessages);
      const frameEntries = [];
      if (tiers.has('frame')) {
        for (const frame of frameWindows) {
          const entry = buildFrameEntry(chat, frame);
          if (entry) {
            frameEntries.push(entry);
            entries.push(entry);
          }
        }
      } else {
        // Still compute frame entries in-memory so scenes can aggregate them,
        // but don't persist them.
        for (const frame of frameWindows) {
          const entry = buildFrameEntry(chat, frame);
          if (entry) frameEntries.push(entry);
        }
      }

      if (tiers.has('scene')) {
        const scenes = groupIntoScenes(frameEntries);
        for (const scene of scenes) {
          const sceneEntry = buildSceneEntry(chat, scene);
          if (sceneEntry) entries.push(sceneEntry);
        }
      }
    }
  }

  return applyMemoryContinuity(entries);
}

/**
 * @param {object} state
 * @param {{ ctx?: { storePath?: string } }} [options] — when provided,
 *   `ctx.storePath` is threaded through to `replaceMemories` so writes
 *   go to the home captured at the top of the load chain (not whatever
 *   `process.env.MELO_HOME` currently resolves to). CLAUDE.md §6 fix-7:
 *   closes the last home-leak vector in readStateSnapshot's repair-save
 *   path. Omitted = legacy lazy resolution via the cached production db.
 *
 * Diagnostics: setting `MELO_DEBUG_MEMORY=1` prints a one-line summary
 * per call (chat count, entry count by kind, target storePath, enabled
 * tiers). Phase E follow-up (2026-05-05): the Phase 7d-5α-A1 wiring is
 * complete on paper, but production stores have shown 0 frame/scene
 * rows even after weeks of use — this log is the cheapest way to
 * tell whether (a) state.chats is empty, (b) the chat-length-≥3 gate
 * filters everything, (c) MELO_MEMORY_TIERS turned tiers off, or (d)
 * writes succeed but go to a different storePath than the one the
 * user is inspecting.
 */
export function syncMemoryStoreSnapshot(state, { ctx } = {}) {
  try {
    const entries = buildMemoryStoreEntries(state);
    if (process.env.MELO_DEBUG_MEMORY === '1') {
      const byKind = entries.reduce((acc, e) => {
        const k = e?.kind || 'unknown';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      const tiers = Array.isArray(state?.chats) && state.chats.length
        ? `tiers=${[...enabledTiers()].join(',')}`
        : 'tiers=N/A(no chats)';
      const chats = Array.isArray(state?.chats) ? state.chats.length : 0;
      const eligibleChats = Array.isArray(state?.chats)
        ? state.chats.filter(c => Array.isArray(c?.messages) && c.messages.length >= 3).length
        : 0;
      // Codex follow-up (Phase E 🟡 P2 2026-05-05): print the resolved
      // storePath even when the caller didn't pass ctx.storePath. The
      // earlier "(default MELO_HOME)" placeholder hid exactly the
      // problem this diagnostic exists to surface — multiple MELO_HOMEs
      // pointing at unrelated stores. Resolve via getMeloHome() and
      // tag the result with `(default)` vs `(ctx)` so the operator
      // can spot when their interactive `melo memory status` is reading
      // a different file than saveState is writing.
      const storePath = ctx?.storePath
        ? `${ctx.storePath} (ctx)`
        : `${join(getMeloHome(), 'desktop', 'store.sqlite')} (default)`;
      const summary = Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(' ') || '(empty)';
      // eslint-disable-next-line no-console
      console.log(
        `[memory.snapshot] chats=${chats} eligibleChats=${eligibleChats} entries=${entries.length} ${summary} ${tiers} storePath=${storePath}`,
      );
    }
    replaceMemories(entries, { storePath: ctx?.storePath });
  } catch (error) {
    console.warn(`Failed to sync Melo memory store: ${error.message}`);
  }
}
