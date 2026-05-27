// Search-results builder cluster — sub-phase 7d-5δ commit 8d of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// `buildSearchResults` is the search bar's per-query result composer. It
// pulls together feature catalogue entries, recent prompt-history hits,
// skill / connector / chat / artifact / file matches, plus memory items,
// runs them through a unified scoring pass, and returns a structured
// payload the desktop UI can render directly. Entry point is the only
// export; the rest are cluster-private helpers (and one config const).
//
// Members (all originally LOCAL to desktopStore, all private to this
// cluster — moved together as a self-contained module, same packaging
// pattern as the chat-action-planner cluster from commit 1 of 7d-5δ):
//
//   • MAX_SEARCH_RESULTS         — total-results cap (was a module const)
//   • sortSearchItems            — score-then-cap helper
//   • buildFeatureSearchEntries  — static feature catalogue
//   • buildRecentSearchSuggestions — empty-query suggestion mix
//   • buildChatThreadSearchEntry / buildChatMessageSearchEntry — chat hit shapers
//   • buildMemorySearchItem      — memory entry shaper (used twice)
//   • buildSearchResults         — entry: scored + categorized payload
//
// All upstream deps are already in dedicated leaf modules (memory store,
// search scoring, message blocks/search, conversation pruning/sort,
// activity log, artifact / project services, shared helpers).

import { join } from 'node:path';
import { searchMemories } from '../../memory/store.js';
import {
  buildSearchSnippet,
  fuzzySearchScore,
  normalizeSearchValue,
  weightedKeywordScore,
} from '../../search/scoring.js';
import { normalizePromptHistory } from '../activity/activityLog.js';
import { summarizeArtifact, visibleArtifacts } from '../artifact/artifactService.js';
import { messageVisibleText } from '../message/messageBlocks.js';
import {
  attachmentSearchText,
  messageSearchText,
} from '../message/messageSearch.js';
import { summarizeProject } from '../project/projectService.js';
import {
  formatUpdatedAt,
  normalizeMessageAttachments,
  nowIso,
} from '../../shared/helpers.js';
import {
  sortChats,
  summarizeChat,
  summarizeMessagePreview,
} from '../../state/conversation.js';

const MAX_SEARCH_RESULTS = 64;
function sortSearchItems(items = [], limit = MAX_SEARCH_RESULTS) {
  return items
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
    })
    .slice(0, limit);
}

function buildFeatureSearchEntries(state) {
  const selectedProjectId = state.settings.selectedProjectId;

  return [
    {
      id: 'feature-search',
      kind: 'feature',
      iconKey: 'search',
      title: 'Search',
      subtitle: 'Find chats, features, projects, artifacts, files, and runtime tools.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-view', view: 'search' },
      keywords: 'find lookup fuzzy global search results discover app',
    },
    {
      id: 'feature-customize',
      kind: 'feature',
      iconKey: 'wand',
      title: 'Customize',
      subtitle: 'Open the configuration hub for agents, skills, connectors, safety, memory, and runtime tools.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-view', view: 'customize' },
      keywords: 'settings customize personalize config memory safety advanced',
    },
    {
      id: 'feature-agents',
      kind: 'feature',
      iconKey: 'spark',
      title: 'Agent',
      subtitle: 'Edit IDENTITY.md, SOUL.md, and mood for the main chat agent and worker lanes.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-view', view: 'agent' },
      keywords: 'agent agents mood identity soul persona personalities',
    },
    {
      id: 'feature-model',
      kind: 'feature',
      iconKey: 'sliders',
      title: 'Model',
      subtitle: 'Choose between local model, API, and OAuth setup for Melo.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-view', view: 'model' },
      keywords: 'model models oauth api local setup openai codex',
    },
    {
      id: 'feature-skills',
      kind: 'feature',
      iconKey: 'chip',
      title: 'Skills',
      subtitle: 'Browse built-in skills and control which ones shape Melo responses.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-customize-section', section: 'skills' },
      keywords: 'skills prompts workflows presets',
    },
    {
      id: 'feature-connectors',
      kind: 'feature',
      iconKey: 'link',
      title: 'Connectors',
      subtitle: 'Configure model, workspace, command, and external MCP-style connectors.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-customize-section', section: 'connectors' },
      keywords: 'connectors mcp openai model files commands external',
    },
    {
      id: 'feature-advanced',
      kind: 'feature',
      iconKey: 'terminal',
      title: 'Advanced',
      subtitle: 'Inspect MCP runtime status, plugins, background tasks, tools, prompts, and resources.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-customize-section', section: 'advanced' },
      keywords: 'advanced runtime tools resources prompts browse mcp plugins background tasks',
    },
    {
      id: 'feature-memory',
      kind: 'feature',
      iconKey: 'spark',
      title: 'Memory',
      subtitle: 'Inspect the local memory store, embedding model, vector status, and dreaming activity.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-customize-section', section: 'memory' },
      keywords: 'memory memories recall embeddings vectors sqlite store dreaming attic model drift',
    },
    {
      id: 'feature-safety',
      kind: 'feature',
      iconKey: 'lock',
      title: 'Safety',
      subtitle: 'Review persistent file-access rules and revoke always-allow grants.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-customize-section', section: 'safety' },
      keywords: 'safety permissions allowlist file access revoke always allow rules',
    },
    {
      id: 'feature-projects',
      kind: 'feature',
      iconKey: 'folder',
      title: 'Projects',
      subtitle: 'Switch project context and manage workspace instructions.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-view', view: 'projects' },
      keywords: 'projects workspaces contexts repos',
    },
    {
      id: 'feature-artifacts',
      kind: 'feature',
      iconKey: 'box',
      title: 'Artifacts',
      subtitle: 'Open the artifact shelf for saved outputs, notes, and reusable code.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'open-view', view: 'artifacts' },
      keywords: 'artifacts outputs snippets shelf notes code',
    },
    {
      id: 'feature-chat-mode',
      kind: 'feature',
      iconKey: 'bubble',
      title: 'Chat mode',
      subtitle: 'Return to the main Melo conversation surface.',
      meta: 'Mode',
      updatedAt: nowIso(),
      action: { type: 'switch-mode', mode: 'chat' },
      keywords: 'chat write assistant home',
    },
    {
      id: 'feature-cowork-mode',
      kind: 'feature',
      iconKey: 'spark',
      title: 'Cowork mode',
      subtitle: 'Use the collaborative planning surface for research and shared thinking.',
      meta: 'Mode',
      updatedAt: nowIso(),
      action: { type: 'switch-mode', mode: 'cowork' },
      keywords: 'cowork learn collaborate planning',
    },
    {
      id: 'feature-code-mode',
      kind: 'feature',
      iconKey: 'code',
      title: 'Code mode',
      subtitle: 'Open files, run commands, and work from the code-focused interface.',
      meta: 'Mode',
      updatedAt: nowIso(),
      action: { type: 'switch-mode', mode: 'code' },
      keywords: 'code files commands workspace patch diff',
    },
    {
      id: 'feature-tasks',
      kind: 'feature',
      iconKey: 'chip',
      title: 'Tasks & agents',
      subtitle: 'Review worker lanes, pending tasks, and explicit work items.',
      meta: 'Feature',
      updatedAt: nowIso(),
      action: { type: 'switch-mode', mode: 'code', projectId: selectedProjectId },
      keywords: 'tasks agents worker lanes approvals work items',
    },
  ];
}

function buildRecentSearchSuggestions(state, featureEntries, connectors = [], skills = []) {
  const recentPromptHistory = normalizePromptHistory(state.settings?.promptHistory)
    .slice(0, 4)
    .map(entry => ({
      id: `prompt-history:${entry.id}`,
      kind: 'prompt-history',
      iconKey: 'bubble',
      title: buildSearchSnippet(entry.content, entry.content, 86, { fallback: 'Empty prompt' }),
      subtitle: entry.chatId
        ? state.chats.find(chat => chat.id === entry.chatId)?.title || 'Prompt history'
        : 'Prompt history',
      meta: formatUpdatedAt(entry.createdAt),
      updatedAt: entry.createdAt,
      chatId: entry.chatId,
      messageId: entry.messageId,
      action: entry.chatId ? { type: 'open-chat-hit' } : { type: 'new-chat-home' },
    }));

  const recentThreads = sortChats(state.chats)
    .slice(0, 5)
    .map(chat => ({
      id: `chat-thread:${chat.id}`,
      kind: 'chat-thread',
      iconKey: 'bubble',
      title: chat.title || 'New chat',
      subtitle: summarizeMessagePreview([...chat.messages].reverse().find(message => message.role !== 'system')),
      meta: formatUpdatedAt(chat.updatedAt),
      updatedAt: chat.updatedAt,
      chatId: chat.id,
      action: { type: 'open-chat-thread' },
    }));

  // Soft-deleted artifacts must not bleed into search summaries.
  // visibleArtifacts() funnels every reader through the same predicate
  // so a tombstoned row can't reappear in counts, project summaries, or
  // search hits (Codex 2026-04-27 audit — same fix at the artifacts
  // bucket below + at line ~599).
  const liveArtifacts = visibleArtifacts(state.artifacts);

  const projectSuggestions = state.projects
    .map(project => summarizeProject(project, state.chats, liveArtifacts))
    .slice(0, 3)
    .map(project => ({
      id: `project:${project.id}`,
      kind: 'project',
      iconKey: 'folder',
      title: project.name,
      subtitle: project.summary || project.workspacePath || 'Project workspace',
      meta: project.updatedLabel,
      updatedAt: project.updatedAt,
      projectId: project.id,
      action: { type: 'focus-project' },
    }));

  const skillSuggestions = skills
    .filter(skill => skill.enabled)
    .slice(0, 2)
    .map(skill => ({
      id: `skill:${skill.id}`,
      kind: 'skill',
      iconKey: 'chip',
      title: skill.name,
      subtitle: skill.description,
      meta: skill.sourceLabel || 'Built-in skill',
      updatedAt: nowIso(),
      action: { type: 'open-customize-section', section: 'skills' },
    }));

  const connectorSuggestions = connectors
    .filter(connector => connector.enabled)
    .slice(0, 2)
    .map(connector => ({
      id: `connector:${connector.id}`,
      kind: 'connector',
      iconKey: connector.id === 'openai-compatible' ? 'sliders' : 'link',
      title: connector.name,
      subtitle: connector.description,
      meta: connector.category || 'Connector',
      updatedAt: connector.updatedAt || nowIso(),
      action: { type: 'open-customize-section', section: 'connectors' },
    }));

  // Keep all feature entries — they're navigable app sections and should all
  // be reachable from the empty-query search page. Only other suggestion types
  // are capped so the total list stays reasonable.
  return [
    ...featureEntries,
    ...skillSuggestions,
    ...connectorSuggestions,
    ...recentPromptHistory,
    ...recentThreads,
    ...projectSuggestions,
  ];
}

function buildChatThreadSearchEntry(chat, query) {
  const summary = summarizeChat(chat);
  const score = fuzzySearchScore(
    query,
    `${summary.title}\n${summary.preview}\n${chat.messages
      .map(message => messageSearchText(message))
      .join('\n\n')}`,
  );

  if (!score) {
    return null;
  }

  return {
    id: `chat-thread:${chat.id}`,
    kind: 'chat-thread',
    iconKey: 'bubble',
    title: summary.title,
    subtitle: buildSearchSnippet(summary.preview, query, 92),
    meta: summary.updatedLabel,
    updatedAt: summary.updatedAt,
    chatId: chat.id,
    action: { type: 'open-chat-thread' },
    score: score + 56,
  };
}

function buildChatMessageSearchEntry(chat, message, query, score) {
  const messageText = messageVisibleText(message).trim();
  const attachmentText = normalizeMessageAttachments(message.attachments)
    .map(attachmentSearchText)
    .filter(Boolean)
    .join('\n');
  const snippetSource = messageText || attachmentText || summarizeMessagePreview(message);
  const speakerLabel =
    message.role === 'assistant'
      ? 'Melo'
      : message.senderName || message.senderUsername || 'You';

  return {
    id: `chat-hit:${chat.id}:${message.id}`,
    kind: 'chat-hit',
    iconKey: 'bubble',
    title: buildSearchSnippet(snippetSource, query, 88, { fallback: 'Empty message' }),
    subtitle: `${speakerLabel} · ${chat.title || 'New chat'}`,
    meta: formatUpdatedAt(message.createdAt || chat.updatedAt),
    updatedAt: message.createdAt || chat.updatedAt,
    chatId: chat.id,
    messageId: message.id,
    action: { type: 'open-chat-hit' },
    score: score + 40,
    rawScore: score,
  };
}

function buildMemorySearchItem(entry, query) {
  const isFact = entry.kind === 'fact';
  const isTranscript = entry.kind === 'audio-transcript';
  const isArticle = entry.kind === 'link-article';
  const isImageOcr = entry.kind === 'image-ocr';
  const isMediaContent = entry.kind === 'media-content';
  const typeLabel = isFact
    ? 'Speaker fact'
    : isTranscript
      ? 'Audio transcript'
      : isArticle
        ? 'Linked content'
        : isImageOcr
          ? 'Image OCR'
          : isMediaContent
            ? 'Media context'
            : 'Prompt memory';
  const title = buildSearchSnippet(entry.text, query, 88, { fallback: 'Empty memory' });
  const subtitle = [
    entry.metadata?.senderName ? `said by ${entry.metadata.senderName}` : '',
    entry.metadata?.chatTitle || '',
    isFact ? entry.metadata?.category || '' : entry.metadata?.title || '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    id: `memory:${entry.id}`,
    kind: isFact
      ? 'speaker-fact'
      : isTranscript
        ? 'audio-transcript'
        : isArticle
          ? 'link-article'
          : isImageOcr
            ? 'image-ocr'
            : isMediaContent
              ? 'media-content'
              : 'memory-prompt',
    iconKey: isFact
      ? 'spark'
      : isTranscript
        ? 'audio'
        : isArticle
          ? 'link'
          : isImageOcr
            ? 'image'
            : isMediaContent
              ? 'chip'
              : 'bubble',
    title,
    subtitle,
    badge: typeLabel,
    meta: formatUpdatedAt(entry.updatedAt),
    updatedAt: entry.updatedAt,
    chatId: entry.metadata?.chatId || null,
    messageId: entry.metadata?.messageId || null,
    action: entry.metadata?.chatId
      ? { type: 'open-chat-hit' }
      : { type: 'open-view', view: 'search' },
    score: (() => {
      const base = fuzzySearchScore(query, entry.text, entry.searchText || '');
      // Only add the type bonus when the content actually matches the query.
      // Without this guard the bonus makes every memory item score > 0,
      // which defeats the .filter(item => item.score > 0) relevance gate.
      return base > 0
        ? base + (isFact ? 28 : isTranscript || isArticle || isImageOcr || isMediaContent ? 24 : 20)
        : 0;
    })(),
  };
}

export async function buildSearchResults(query, state, workspace, connectors = [], skills = []) {
  const q = normalizeSearchValue(query);
  const featureEntries = buildFeatureSearchEntries(state);

  if (!q) {
    const suggestions = buildRecentSearchSuggestions(state, featureEntries, connectors, skills);
    // Surface recently accessed non-prompt memory items (facts, transcripts,
    // articles, OCR, media) so the empty-query view is a useful activity feed
    // rather than just showing the most recent chat threads.
    const recentMemoryItems = searchMemories({
      query: '',
      kinds: ['fact', 'audio-transcript', 'link-article', 'image-ocr', 'media-content'],
      limit: 8,
    }).map(entry => buildMemorySearchItem(entry, ''));

    return {
      query,
      items: [],
      suggestions,
      features: suggestions.filter(item => item.kind === 'feature'),
      promptHistory: suggestions.filter(item => item.kind === 'prompt-history'),
      skills: suggestions.filter(item => item.kind === 'skill'),
      connectors: suggestions.filter(item => item.kind === 'connector'),
      chatThreads: suggestions.filter(item => item.kind === 'chat-thread'),
      chatHits: [],
      memoryItems: recentMemoryItems,
      projects: suggestions.filter(item => item.kind === 'project'),
      artifacts: [],
      files: [],
    };
  }

  const featureItems = featureEntries
    .map(item => ({
      ...item,
      score:
        fuzzySearchScore(q, `${item.title}\n${item.subtitle}`) +
        weightedKeywordScore(q, item.keywords || []),
    }))
    .filter(item => item.score > 0);

  const promptHistory = normalizePromptHistory(state.settings?.promptHistory)
    .map(entry => {
      const chat = entry.chatId ? state.chats.find(item => item.id === entry.chatId) : null;
      const score = fuzzySearchScore(q, entry.content);
      if (!score) {
        return null;
      }

      return {
        id: `prompt-history:${entry.id}`,
        kind: 'prompt-history',
        iconKey: 'bubble',
        title: buildSearchSnippet(entry.content, query, 88, { fallback: 'Empty prompt' }),
        subtitle: chat?.title || 'Prompt history',
        meta: formatUpdatedAt(entry.createdAt),
        updatedAt: entry.createdAt,
        chatId: entry.chatId,
        messageId: entry.messageId,
        action: chat ? { type: 'open-chat-hit' } : { type: 'new-chat-home' },
        score: score + 34,
      };
    })
    .filter(Boolean);

  const skillItems = skills
    .map(skill => {
      const score = fuzzySearchScore(
        q,
        `${skill.name}\n${skill.description}\n${skill.folderSummary}\n${skill.systemPrompt}`,
      );
      if (!score) {
        return null;
      }

      return {
        id: `skill:${skill.id}`,
        kind: 'skill',
        iconKey: 'chip',
        title: skill.name,
        subtitle: buildSearchSnippet(skill.description, query, 88),
        meta: skill.enabled ? 'Enabled skill' : 'Disabled skill',
        updatedAt: nowIso(),
        action: { type: 'open-customize-section', section: 'skills' },
        score: score + 30,
      };
    })
    .filter(Boolean);

  const connectorItems = connectors
    .map(connector => {
      const score = fuzzySearchScore(
        q,
        `${connector.name}\n${connector.description}\n${connector.details}\n${connector.category}`,
      );
      if (!score) {
        return null;
      }

      return {
        id: `connector:${connector.id}`,
        kind: 'connector',
        iconKey: connector.id === 'openai-compatible' ? 'sliders' : 'link',
        title: connector.name,
        subtitle: buildSearchSnippet(connector.description, query, 88),
        meta: connector.category,
        updatedAt: connector.updatedAt || nowIso(),
        action: { type: 'open-customize-section', section: 'connectors' },
        score: score + 26,
      };
    })
    .filter(Boolean);

  const chatThreads = [];
  const chatHits = [];
  const chatHitCounts = new Map();
  for (const chat of sortChats(state.chats)) {
    let strongestMessageScore = 0;
    for (const message of chat.messages || []) {
      const searchableText = `${chat.title || 'New chat'}\n${messageSearchText(message)}`;
      const score = fuzzySearchScore(q, searchableText);
      if (!score) {
        continue;
      }

      strongestMessageScore = Math.max(strongestMessageScore, score);
      chatHitCounts.set(chat.id, (chatHitCounts.get(chat.id) || 0) + 1);
      chatHits.push(buildChatMessageSearchEntry(chat, message, q, score));
    }

    const threadEntry = buildChatThreadSearchEntry(chat, q);
    if (!threadEntry && !strongestMessageScore) {
      continue;
    }

    if (threadEntry) {
      threadEntry.rawScore = Math.max(threadEntry.score - 56, strongestMessageScore);
      chatThreads.push(threadEntry);
    } else {
      const summary = summarizeChat(chat);
      chatThreads.push({
        id: `chat-thread:${chat.id}`,
        kind: 'chat-thread',
        iconKey: 'bubble',
        title: summary.title,
        subtitle: buildSearchSnippet(summary.preview, q, 92),
        meta: summary.updatedLabel,
        updatedAt: summary.updatedAt,
        chatId: chat.id,
        action: { type: 'open-chat-thread' },
        score: strongestMessageScore + 56,
        rawScore: strongestMessageScore,
      });
    }
  }

  const chatThreadMap = new Map(chatThreads.map(entry => [entry.chatId, entry]));
  const dedupedChatHits = chatHits.filter(hit => {
    const thread = chatThreadMap.get(hit.chatId);
    if (!thread) {
      return true;
    }

    const hitCount = chatHitCounts.get(hit.chatId) || 0;
    return hitCount > 1 || Math.abs((hit.rawScore || 0) - (thread.rawScore || 0)) > 30;
  });

  // Soft-deleted artifacts gate — same predicate as buildRecent-
  // SearchSuggestions above.  Project summaries and the artifacts
  // bucket below all consume this filtered list so a tombstoned row
  // can't be re-surfaced through search.
  const liveArtifactRows = visibleArtifacts(state.artifacts);

  const projects = state.projects
    .map(project => summarizeProject(project, state.chats, liveArtifactRows))
    .filter(project =>
      fuzzySearchScore(
        q,
        `${project.name}\n${project.summary}\n${project.instructions}\n${project.workspacePath}`,
      ),
    );

  const projectItems = projects.map(project => ({
    id: `project:${project.id}`,
    kind: 'project',
    iconKey: 'folder',
    title: project.name,
    subtitle: project.summary || project.workspacePath || 'Project workspace',
    meta: project.updatedLabel,
    updatedAt: project.updatedAt,
    projectId: project.id,
    action: { type: 'focus-project' },
    score:
      fuzzySearchScore(
        q,
        `${project.name}\n${project.summary}\n${project.instructions}\n${project.workspacePath}`,
      ) + 22,
  }));

  const artifacts = [...liveArtifactRows]
    .map(summarizeArtifact)
    .filter(artifact =>
      fuzzySearchScore(q, `${artifact.title}\n${artifact.content}\n${artifact.language || ''}`),
    )
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  const artifactItems = artifacts.map(artifact => ({
    id: `artifact:${artifact.id}`,
    kind: 'artifact',
    iconKey: 'box',
    title: artifact.title,
    subtitle: buildSearchSnippet(artifact.content, q, 84) || `${artifact.language} artifact`,
    meta: artifact.createdLabel,
    updatedAt: artifact.createdAt,
    artifactId: artifact.id,
    action: { type: 'open-artifact' },
    score: fuzzySearchScore(q, `${artifact.title}\n${artifact.content}\n${artifact.language || ''}`) + 16,
  }));

  const files = (workspace.filePaths || [])
    .filter(filePath => fuzzySearchScore(q, filePath))
    .slice(0, 20);

  const fileItems = files.map(filePath => ({
    id: `file:${filePath}`,
    kind: 'file',
    iconKey: 'file',
    title: filePath,
    subtitle: 'Workspace file',
    meta: 'File',
    updatedAt: nowIso(),
    filePath,
    action: { type: 'open-file' },
    score: fuzzySearchScore(q, filePath) + 10,
  }));

  const rawMemoryItems = searchMemories({
    query,
    kinds: ['fact', 'prompt', 'audio-transcript', 'link-article', 'image-ocr', 'media-content'],
    limit: 48,
  })
    .map(entry => buildMemorySearchItem(entry, q))
    .filter(item => item.score > 0);

  // Deduplicate: memory-prompt entries whose messageId is already covered by a
  // chat-hit (same message content shown twice in different categories).
  const chatHitMessageIds = new Set(
    dedupedChatHits.map(hit => hit.messageId).filter(Boolean),
  );
  const memoryItems = rawMemoryItems.filter(
    item =>
      !(
        item.kind === 'memory-prompt' &&
        item.messageId &&
        chatHitMessageIds.has(item.messageId)
      ),
  );

  const items = sortSearchItems([
    ...featureItems,
    ...promptHistory,
    ...skillItems,
    ...connectorItems,
    ...chatThreads,
    ...dedupedChatHits,
    ...memoryItems,
    ...projectItems,
    ...artifactItems,
    ...fileItems,
  ]);

  return {
    query,
    items,
    suggestions: buildRecentSearchSuggestions(state, featureEntries, connectors, skills),
    features: featureItems.slice(0, 8),
    promptHistory: promptHistory.slice(0, 10),
    skills: skillItems.slice(0, 8),
    connectors: connectorItems.slice(0, 8),
    chatThreads: sortSearchItems(chatThreads, 16),
    chatHits: sortSearchItems(dedupedChatHits, 20),
    memoryItems: sortSearchItems(memoryItems, 20),
    projects: projectItems.slice(0, 12),
    artifacts: artifactItems.slice(0, 12),
    files: sortSearchItems(fileItems, 12),
  };
}
