import {normalizeHandoff} from '../agents/handoff.js';
import {migrateLegacyResults} from '../domain/artifact/artifactService.js';
import { recommendedCapabilities } from '../domain/agent/capabilities.js';
import { hydrateAgentRecords, hydrateProjectAgentRecords } from '../domain/agent/agentState.js';
import { isDeepStrictEqual } from 'node:util';
import { serializeChatForPersistence } from './chatManifest.js';
import { normalizeLocalPreferences } from '../domain/settings/localPreferences.js';
// State hydration + default state — Phase 7d-5α-A1 (commit 7/9).
//
// This is the read side of the state machine: turning the on-disk state.json
// blob (parsed into a raw JS object by parseStatePayload) into a fully
// validated, normalized desktop state object the rest of the app can use.
//
// Bundle contents (10 symbols):
//   • BUILTIN_CONNECTORS              ─┐
//   • LEGACY_EXAMPLE_PROJECT_ID        │  static data + constants the
//   • LEGACY_EXAMPLE_PROJECT_NAME      │  hydration pipeline references
//   • defaultProjectTime              ─┘
//   • normalizeProject (local wrapper that binds sanitizeWorkspacePath /
//                       APP_ROOT / defaultProjectTime to the raw
//                       projectService.normalizeProject)
//   • normalizeChat                   ─ shape-validates a stored chat record
//   • buildThreadMemorySummary        ─ private helper used by normalizeChat
//   • createDefaultState              ─ first-boot factory
//   • threadCheckpointMatches         ─ private helper for hydrateChatThreads
//   • hydrateState                    ─ entry: raw parsed obj → desktop state
//   • hydrateChatThreads              ─ rehydrates per-chat thread checkpoints
//
// Why this bundle: hydrateState calls createDefaultState + normalizeChat +
// normalizeProject + normalizeArtifact (external) + many other normalizers.
// hydrateChatThreads calls normalizeChat + threadCheckpointMatches +
// loadThreadCheckpoint (external). Both entries are called only by
// readStateSnapshot which still lives in desktopStore. Pulling these out
// breaks the last big chunk of "desktopStore-internal helper churn" the
// future stateStore (commit 9) would otherwise force into the move.
//
// Per CLAUDE.md §5 (byte-for-byte rule), every body below is verbatim
// from desktopStore.js. The only mechanical adaptation is APP_ROOT —
// computed from this module's own URL, with one extra `dirname()` to
// climb out of `src/state/` so the resolved path matches the original
// desktopStore APP_ROOT exactly. The output is identical; the formula
// differs only because this module sits one level deeper.

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadThreadCheckpoint } from '../memory/checkpointer.js';
import { renderThreadMemorySnapshot as renderStructuredThreadMemorySnapshot } from '../memory/threadContext.js';
import {
  coerceIso,
  normalizeAgentStorageId,
  normalizeMessageAttachments,
} from '../shared/helpers.js';
import { normalizeMessageBlocks } from '../domain/message/messageBlocks.js';
import { normalizeExtractedMedia } from '../media/index.js';
import { sanitizeWorkspacePath as sanitizeWorkspacePathRaw } from '../domain/workspacePath.js';
import { normalizeProject as normalizeProjectRaw } from '../domain/project/projectService.js';
import { BUILTIN_SKILLS } from '../domain/skill/skillService.js';
import {
  normalizeAgentProfiles,
  normalizeProjectAgentOverrides,
} from './agentProfiles.js';
import { normalizeArtifact } from '../domain/artifact/artifactService.js';
import {
  normalizeCommandRuns,
  normalizeExternalToolRuns,
  normalizePromptHistory,
} from '../domain/activity/activityLog.js';
import { normalizeExternalConnector } from '../domain/connector/externalConnector.js';
import { normalizeTasks } from '../domain/task/taskService.js';
import { normalizeApprovals } from '../domain/approval/approvalService.js';
import {
  setChatThreadContextCache,
  buildThreadContextForChat,
  ensureChatThreadContext,
} from '../memory/chatThreadContext.js';

// One day in ms — used by `defaultProjectTime` below. The original
// desktopStore.js sourced this constant from a top-level `const ONE_DAY_MS`
// declaration. Re-declared here for byte-identical behavior at the
// `defaultProjectTime` call site.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// APP_ROOT — original desktopStore.js: `dirname(dirname(fileURLToPath(import.meta.url)))`.
// This module lives one level deeper (in `src/state/`), so we need an extra
// `dirname()` for the resolved path to be identical. The output is the same
// directory; only the formula differs.
const APP_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// IMPORTANT (Phase 7d-5α-A1 commit 7 follow-up — Codex review C-grade fix):
// The original desktopStore.js had a local 1-arg wrapper that bound APP_ROOT
// as the second arg of the 2-arg sanitizeWorkspacePath from workspaceFiles.js,
// then handed THAT 1-arg wrapper to normalizeProjectRaw via deps. The first
// version of this extraction grabbed the 2-arg function directly and dropped
// the binding — when projectService.normalizeProject called the dep with one
// arg for relative workspacePath, the underlying `resolve(undefined, rawPath)`
// threw TypeError. Restoring the local 1-arg wrapper exactly mirrors the
// original behavior. CLAUDE.md §5: this is the "byte-for-byte" version.
/**
 * G-1d slice 2 (2026-05-12): defensive normalize of `message.toolResults`
 * on state load.  Each entry is
 * `{ toolCallId, toolName, ok, evidenceTrail?, errorCode? }`.
 * Persistence path (sendChatMessage) builds these from chatExecutionRunner's
 * accumulator, but state.json round-trip can hit older files / corrupted
 * data — filter non-object entries and stamp safe defaults so renderers
 * never see undefined.
 *
 * 2026-05-23 架构 audit #2 round-2 (Codex C 闭环): `errorCode` (SearchTask
 * unified taxonomy, attached by toolResultProjection) must survive the
 * round-trip too — pre-fix this whitelist dropped it, so the persisted
 * record / devtools overlay silently lost the unified code after reload.
 * Validate SHAPE (non-empty string), NOT enum membership: stateHydration
 * stays decoupled from searchTask's ERROR_CODES (layering), and old state
 * carrying a code that later left the enum isn't dropped.  Malformed
 * (non-string / empty) → omitted, same defensive treatment as evidenceTrail.
 */
function normalizeToolResultsForHydration(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const entry = {
      toolCallId: typeof item.toolCallId === 'string' ? item.toolCallId : '',
      toolName: typeof item.toolName === 'string' ? item.toolName : '',
      ok: item.ok !== false,
    };
    if (Array.isArray(item.evidenceTrail) && item.evidenceTrail.length > 0) {
      // Filter trail items defensively too — same shape as G-1e parser /
      // G-1f UI side defensiveness so a corrupt entry doesn't crash render.
      const cleanTrail = item.evidenceTrail.filter(t => t && typeof t === 'object');
      if (cleanTrail.length > 0) entry.evidenceTrail = cleanTrail;
    }
    if (typeof item.errorCode === 'string' && item.errorCode.trim()) {
      entry.errorCode = item.errorCode;
    }
    if (typeof item.backupOperationId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(item.backupOperationId)) entry.backupOperationId = item.backupOperationId;
    if (item.handoff) entry.handoff=normalizeHandoff(item.handoff);
    if (item.member) entry.member={agentId:String(item.member.agentId),name:String(item.member.name),memberId:String(item.member.memberId),durationMs:Number(item.member.durationMs)||0};
    if (typeof item.path === 'string') entry.path = item.path;
    if (Number.isInteger(item.exitCode)) entry.exitCode = item.exitCode;
    if (item.replayed === true) entry.replayed = true;
    out.push(entry);
  }
  return out;
}

function sanitizeWorkspacePath(rawPath) {
  return sanitizeWorkspacePathRaw(rawPath, APP_ROOT);
}

export const BUILTIN_CONNECTORS = [
  {
    id: 'openai-compatible',
    name: 'OpenAI',
    category: 'Model',
    description:
      'Use either local Codex/ChatGPT OAuth or an OpenAI API key to power Melo chat.',
    details:
      'This connector powers the live model call path. Codex mode uses your local Codex login; API key mode uses the configured base URL, model, and system prompt.',
    prompt:
      'OpenAI is connected. Use the configured OpenAI model when the user sends a prompt.',
  },
  {
    id: 'projects',
    name: 'Projects',
    category: 'Workspace',
    description:
      'Attach chats to projects, keep project-specific instructions, and group recent work.',
    details:
      'Project context is appended to the system prompt and shapes titles, summaries, and search results.',
    prompt:
      'Project context is available. Prefer project-aware answers when a chat belongs to a project.',
  },
  {
    id: 'artifacts',
    name: 'Artifacts',
    category: 'Workspace',
    description:
      'Save code blocks and durable outputs into an artifacts shelf for later reuse.',
    details:
      'Generated code fences become artifacts, and artifacts can also be created manually from the desktop UI.',
    prompt:
      'Artifacts are enabled. Durable code or plans may be captured for reuse.',
  },
  {
    id: 'local-files',
    name: 'Local Files',
    category: 'Connector',
    description:
      'Browse the active project workspace, preview files, and pull selected file context into code mode.',
    details:
      'This connector surfaces a local file tree, selected file preview, and file context inside the code assistant.',
    prompt:
      'Local file browsing is enabled. Use selected workspace files and project structure when answering code requests.',
  },
  {
    id: 'local-command',
    name: 'Local Command',
    category: 'Connector',
    description:
      'Run curated local commands like git status, build, and ripgrep inside the active project workspace.',
    details:
      'This connector exposes a controlled command runner for project diagnostics and build checks.',
    prompt:
      'Local command execution is enabled. Recent command outputs may help answer code questions.',
  },
];

export const defaultProjectTime = new Date(Date.now() - ONE_DAY_MS).toISOString();

// ID + name signature of the legacy auto-seeded example project. Earlier
// versions of Melo shipped with a "How to use Melo" sample whose
// workspacePath defaulted to the Melo install directory — that leaked the
// source path and showed up for every brand-new install. The seed is gone
// now (empty projects list on first boot), and hydrateState() drops any
// persisted copy that is still in its pristine form. A user who renamed the
// project or pointed it at a different workspace keeps it.
export const LEGACY_EXAMPLE_PROJECT_ID = 'example-project';
export const LEGACY_EXAMPLE_PROJECT_NAME = 'How to use Melo';

// normalizeProject was extracted to `src/services/project/projectService.js`
// in Phase 9c. The local wrapper binds APP_ROOT / sanitizeWorkspacePath /
// defaultProjectTime so the original one-arg signature keeps working.
export function normalizeProject(project) {
  return normalizeProjectRaw(project, {
    sanitizeWorkspacePath,
    fallbackWorkspaceRoot: APP_ROOT,
    defaultProjectTime,
  });
}

export function normalizeChat(chat) {
  const normalized = {
    id: chat?.id || randomUUID(),
    ...(Object.hasOwn(chat || {}, 'checkpointId') ? { checkpointId: chat.checkpointId || null } : {}),
    title: chat?.title || 'New chat',
    mode: chat?.mode || 'chat',
    projectId: chat?.projectId || null,
    ...(typeof chat?.workspacePath==='string' && chat.workspacePath ? {workspacePath:chat.workspacePath} : {}),
    contextArtifactIds: Array.isArray(chat?.contextArtifactIds) ? [...new Set(chat.contextArtifactIds.filter(id=>typeof id==='string'))] : [],
    ...(chat?.modelSelection && typeof chat.modelSelection.model === 'string' ? {modelSelection: {profileId:String(chat.modelSelection.profileId || ''), model:chat.modelSelection.model, authMode:chat.modelSelection.authMode, baseUrl:chat.modelSelection.baseUrl,...(chat.modelSelection.portable?{portable:chat.modelSelection.portable}:{})}} : {}),
    agentId:
      typeof chat?.agentId === 'string' && chat.agentId.trim()
        ? normalizeAgentStorageId(chat.agentId)
        : 'main',
    source:
      typeof chat?.source === 'string' && chat.source.trim() ? chat.source.trim() : 'desktop',
    chatType:
      typeof chat?.chatType === 'string' && chat.chatType.trim()
        ? chat.chatType.trim()
        : 'private',
    chatTitle:
      typeof chat?.chatTitle === 'string' && chat.chatTitle.trim()
        ? chat.chatTitle.trim()
        : '',
    messageThreadId:
      Number.isFinite(Number(chat?.messageThreadId)) && Number(chat.messageThreadId) > 0
        ? Number(chat.messageThreadId)
        : null,
    externalThreadKey:
      typeof chat?.externalThreadKey === 'string' && chat.externalThreadKey.trim()
        ? chat.externalThreadKey.trim()
        : '',
    locked: Boolean(chat?.locked),
    createdAt: coerceIso(chat?.createdAt),
    updatedAt: coerceIso(chat?.updatedAt),
    memorySummary:
      typeof chat?.memorySummary === 'string' ? chat.memorySummary.trim() : '',
    // Context-compression fields (contextCompact.js)
    compactSummary:
      typeof chat?.compactSummary === 'string' ? chat.compactSummary.trim() : '',
    compactBoundaryMessageId:
      typeof chat?.compactBoundaryMessageId === 'string'
        ? chat.compactBoundaryMessageId.trim()
        : '',
    compactedMessageCount:
      Number.isFinite(Number(chat?.compactedMessageCount)) && Number(chat.compactedMessageCount) >= 0
        ? Number(chat.compactedMessageCount)
        : 0,
    compactedAt:
      typeof chat?.compactedAt === 'string' && chat.compactedAt.trim()
        ? coerceIso(chat.compactedAt)
        : '',
    compactFailures:
      Number.isFinite(Number(chat?.compactFailures)) && Number(chat.compactFailures) >= 0
        ? Number(chat.compactFailures)
        : 0,
    // Session memory — extracted facts accumulated across turns
    sessionMemory: Array.isArray(chat?.sessionMemory) ? chat.sessionMemory : [],
    memoryLastExtractedAt: Number.isFinite(Number(chat?.memoryLastExtractedAt))
      ? Number(chat.memoryLastExtractedAt)
      : 0,
    memoryLastExtractedAtCount: Number.isFinite(Number(chat?.memoryLastExtractedAtCount))
      ? Number(chat.memoryLastExtractedAtCount)
      : 0,
    messages: Array.isArray(chat?.messages)
      ? chat.messages.map(message => ({
          id: message?.id || randomUUID(),
          role: message?.role || 'assistant',
          content: typeof message?.content === 'string' ? message.content : '',
          blocks: normalizeMessageBlocks(message?.blocks, message?.content),
          attachments: normalizeMessageAttachments(message?.attachments),
          extractedMedia: normalizeExtractedMedia(message?.extractedMedia),
          createdAt: coerceIso(message?.createdAt),
          senderId:
            typeof message?.senderId === 'string' && message.senderId.trim()
              ? message.senderId.trim()
              : null,
          senderName:
            typeof message?.senderName === 'string' && message.senderName.trim()
              ? message.senderName.trim()
              : null,
          senderUsername:
            typeof message?.senderUsername === 'string' && message.senderUsername.trim()
              ? message.senderUsername.trim()
              : null,
          // Demon viz-spec — preserved as-is through state hydration. The
          // spec was already shape-validated by extractVizSpec() at the time
          // the reply was first persisted, so we just round-trip it here.
          // `undefined` stays `undefined`, preventing spurious keys on
          // user messages that never carry a viz.
          ...(message?.viz && typeof message.viz === 'object'
            ? { viz: message.viz }
            : {}),
          // Source citations (NotebookLM-style pins). Similarly shape-validated
          // at extract time; round-trip through hydration so the UI always has
          // a structured list to back the inline pill-click → side-viewer
          // behavior.
          ...(Array.isArray(message?.citations) && message.citations.length
            ? { citations: message.citations }
            : {}),
          // Preserve message-level metadata (e.g. verificationRecord) that
          // sendChatMessage attaches alongside viz.
          ...(message?.metadata && typeof message.metadata === 'object'
            ? { metadata: message.metadata }
            : {}),
          // G-1d slice 2 (2026-05-12): structured tool execution metadata
          // attached by sendChatMessage when chatExecutionRunner's tool
          // loop ran any tools.  Each entry: { toolCallId, toolName, ok,
          // evidenceTrail? }.  Round-trip preserved so chat history UI
          // can render the fallback trail under each assistant message
          // that drove a tool call (past the 1.8s active-chip window).
          // Drop malformed entries defensively.
          ...(Array.isArray(message?.toolResults) && message.toolResults.length
            ? { toolResults: normalizeToolResultsForHydration(message.toolResults) }
            : {}),
        }))
      : [],
  };

  if (!normalized.memorySummary) {
    normalized.memorySummary = buildThreadMemorySummary(normalized);
  }

  return normalized;
}

function buildThreadMemorySummary(chat) {
  return renderStructuredThreadMemorySnapshot(ensureChatThreadContext(chat));
}

function threadCheckpointMatches(checkpoint, chat, threadContext) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  if (!checkpoint) {
    return messages.length === 0;
  }

  const checkpointMessages = Array.isArray(checkpoint.messages) ? checkpoint.messages : [];
  return (
    checkpointMessages.length === messages.length &&
    (checkpointMessages[checkpointMessages.length - 1]?.id || null) ===
      (messages[messages.length - 1]?.id || null) &&
    checkpoint.updatedAt === chat?.updatedAt &&
    checkpoint.derived?.threadContext?.derivedFromMessageId === threadContext?.derivedFromMessageId &&
    chatRuntimeCheckpointMatches(checkpoint.derived?.chatRuntime, chat)
  );
}

function chatRuntimeCheckpointMatches(runtime, chat) {
  if (!runtime || typeof runtime !== 'object') {
    const hasRuntimeState =
      (Array.isArray(chat?.sessionMemory) && chat.sessionMemory.length > 0) ||
      Boolean(chat?.memoryLastExtractedAt) ||
      Boolean(chat?.memoryLastExtractedAtCount) ||
      Boolean(chat?.compactSummary) ||
      Boolean(chat?.compactBoundaryMessageId) ||
      Boolean(chat?.compactedMessageCount) ||
      Boolean(chat?.compactedAt) ||
      Boolean(chat?.compactFailures);
    return !hasRuntimeState;
  }

  return (
    JSON.stringify(Array.isArray(runtime.sessionMemory) ? runtime.sessionMemory : []) ===
      JSON.stringify(Array.isArray(chat?.sessionMemory) ? chat.sessionMemory : []) &&
    (Number(runtime.memoryLastExtractedAt) || 0) === (Number(chat?.memoryLastExtractedAt) || 0) &&
    (Number(runtime.memoryLastExtractedAtCount) || 0) ===
      (Number(chat?.memoryLastExtractedAtCount) || 0) &&
    String(runtime.compactSummary || '') === String(chat?.compactSummary || '') &&
    String(runtime.compactBoundaryMessageId || '') === String(chat?.compactBoundaryMessageId || '') &&
    (Number(runtime.compactedMessageCount) || 0) === (Number(chat?.compactedMessageCount) || 0) &&
    String(runtime.compactedAt || '') === String(chat?.compactedAt || '') &&
    (Number(runtime.compactFailures) || 0) === (Number(chat?.compactFailures) || 0)
  );
}

/**
 * @param {object} state
 * @param {{ threadsDir?: string }} [options] — when provided, every
 *   loadThreadCheckpoint call in this hydrate pass uses the same
 *   captured threadsDir. CLAUDE.md §6: protects the load chain from
 *   MELO_HOME flips happening across the disk-read awaits inside this
 *   loop. Omitted = legacy lazy resolution (still works for any
 *   single-shot caller outside readStateSnapshot's orchestration).
 */
export async function hydrateChatThreads(state, { threadsDir, previousChats = [] } = {}) {
  const previous = new Map(previousChats.map(chat => [chat.id,chat]));
  let repaired = false;
  const hydratedChats = [];

  for (const storedChat of Array.isArray(state.chats) ? state.chats : []) {
    const prior = previous.get(storedChat.id);
    if (prior && storedChat.checkpointId && !(storedChat.messages?.length) &&
        isDeepStrictEqual(serializeChatForPersistence(storedChat), serializeChatForPersistence(prior))) {
      hydratedChats.push(prior);
      continue;
    }
    const checkpoint = storedChat.checkpointId === null ? null
      : await loadThreadCheckpoint(storedChat.checkpointId || storedChat.id, { threadsDir });
    if (storedChat.checkpointId && !checkpoint) {
      throw Object.assign(new Error(`Missing committed checkpoint for chat ${storedChat.id}.`), { code: 'STATE_CHECKPOINT_MISSING' });
    }
    const hasLegacyMessages = Array.isArray(storedChat.messages) && storedChat.messages.length > 0;
    const sourceMessages = Array.isArray(checkpoint?.messages)
      ? checkpoint.messages
      : Array.isArray(storedChat.messages)
        ? storedChat.messages
        : [];
    const checkpointRuntime =
      checkpoint?.derived?.chatRuntime && typeof checkpoint.derived.chatRuntime === 'object'
        ? checkpoint.derived.chatRuntime
        : {};
    const hydratedChat = normalizeChat({
      ...storedChat,
      ...checkpointRuntime,
      messages: sourceMessages,
      memorySummary: '',
    });
    const checkpointThreadContext = checkpoint?.derived?.threadContext || null;
    const threadContext =
      checkpointThreadContext &&
      checkpointThreadContext.derivedFromMessageId ===
        (hydratedChat.messages[hydratedChat.messages.length - 1]?.id || null)
        ? checkpointThreadContext
        : buildThreadContextForChat(hydratedChat);

    setChatThreadContextCache(hydratedChat, threadContext);
    hydratedChat.memorySummary = renderStructuredThreadMemorySnapshot(threadContext);

    if (hasLegacyMessages || !threadCheckpointMatches(checkpoint, hydratedChat, threadContext)) {
      repaired = true;
    }

    hydratedChats.push(hydratedChat);
  }

  state.chats = hydratedChats;
  return repaired;
}

export function createDefaultState() {
  return {
    settings: {
      activeView: 'chat',
      activeMode: 'chat',
      selectedChatId: null,
      selectedProjectId: null,
      selectedCustomizeSection: 'skills',
      selectedAgentScope: 'global',
      selectedAgentId: 'main',
      selectedSkillId: BUILTIN_SKILLS[0].id,
      selectedConnectorId: BUILTIN_CONNECTORS[0].id,
      enabledSkillIds: [
        'skill-creator',
        'project-planner',
        'connector-builder',
        'artifact-curator',
      ],
      customSkills: [],
      enabledConnectorIds: [
        'openai-compatible',
        'projects',
        'artifacts',
        'local-files',
        'local-command',
      ],
      connectorPresetVersion: 2,
      skillPresetVersion: 1,
      promptHistory: [],
      sortProjectsBy: 'activity',
      selectedFilePath: null,
    },
    chats: [],
    projects: [],
    artifacts: [],
    commandRuns: [],
    externalConnectors: [],
    externalToolRuns: [],
    agentProfiles: Object.fromEntries(Object.entries(normalizeAgentProfiles()).map(([id,p])=>[id,{...p,capabilities:recommendedCapabilities(id),collaboration:{...p.collaboration,canDelegate:id==='main',delegateTargets:id==='main'?['research','builder','reviewer']:[]}}])),
    projectAgentOverrides: {},
    tasks: [],
    approvals: [],
  };
}

export function hydrateState(parsed = {}) {
  const defaults = createDefaultState();
  // Split tables are a disk representation, consumed exactly once below.
  // Keeping them beside the writable runtime profiles would let stale values
  // overwrite a later channel/voice edit when the committed cache is hydrated.
  const { agentChannelBindings, agentVoiceSettings, ...runtimeFields } = parsed;
  const connectorPresetVersion = Number(parsed?.settings?.connectorPresetVersion || 0);
  const skillPresetVersion = Number(parsed?.settings?.skillPresetVersion || 0);

  // Respect an explicit empty array — a user who deleted every project must
  // not have the old example re-seeded. Only fall back to defaults (also
  // empty now) when the persisted state has no `projects` key at all.
  const rawProjects = Array.isArray(parsed.projects) ? parsed.projects : null;
  const projects = rawProjects
    ? rawProjects
        .map(normalizeProject)
        // Drop the legacy auto-seeded "How to use Melo" example when it is
        // still pristine (same id AND same name). If the user renamed it,
        // we leave it alone — at that point it is their project.
        .filter(
          project =>
            !(
              project.id === LEGACY_EXAMPLE_PROJECT_ID &&
              project.name === LEGACY_EXAMPLE_PROJECT_NAME
            ),
        )
    : defaults.projects;

  const enabledConnectorIds = Array.isArray(parsed?.settings?.enabledConnectorIds)
    ? [...parsed.settings.enabledConnectorIds]
    : [...defaults.settings.enabledConnectorIds];

  if (connectorPresetVersion < defaults.settings.connectorPresetVersion) {
    for (const connectorId of ['local-files', 'local-command']) {
      if (!enabledConnectorIds.includes(connectorId)) {
        enabledConnectorIds.push(connectorId);
      }
    }
  }

  // Skill preset migration: older state persisted before skillPresetVersion
  // introduction only had 2 of the 4 built-in skills enabled. Backfill so
  // every built-in skill is globally available to every agent by default.
  const enabledSkillIds = Array.isArray(parsed?.settings?.enabledSkillIds)
    ? [...parsed.settings.enabledSkillIds]
    : [...defaults.settings.enabledSkillIds];

  if (skillPresetVersion < defaults.settings.skillPresetVersion) {
    for (const skillId of ['connector-builder', 'artifact-curator']) {
      if (!enabledSkillIds.includes(skillId)) {
        enabledSkillIds.push(skillId);
      }
    }
  }

  // Reconcile the persisted selectedProjectId against the actual projects
  // list — after dropping the pristine example, a stale pointer would
  // otherwise leave the UI believing a project is selected when it is gone.
  const persistedSelectedProjectId =
    typeof parsed?.settings?.selectedProjectId === 'string'
      ? parsed.settings.selectedProjectId
      : defaults.settings.selectedProjectId;
  const selectedProjectId = projects.some(
    project => project.id === persistedSelectedProjectId,
  )
    ? persistedSelectedProjectId
    : null;

  return {
    ...defaults,
    ...runtimeFields,
    settings: {
      ...defaults.settings,
      ...parsed.settings,
      localPreferences: normalizeLocalPreferences(parsed.settings?.localPreferences),
      enabledConnectorIds,
      connectorPresetVersion: defaults.settings.connectorPresetVersion,
      enabledSkillIds,
      skillPresetVersion: defaults.settings.skillPresetVersion,
      promptHistory: normalizePromptHistory(parsed?.settings?.promptHistory),
      selectedProjectId,
    },
    chats: Array.isArray(parsed.chats) ? parsed.chats.map(normalizeChat) : defaults.chats,
    projects,
    artifacts: Array.isArray(parsed.artifacts)
      ? migrateLegacyResults(parsed.artifacts,parsed.chats || [])
      : defaults.artifacts,
    commandRuns: normalizeCommandRuns(parsed.commandRuns),
    externalConnectors: Array.isArray(parsed.externalConnectors)
      ? parsed.externalConnectors.map(normalizeExternalConnector)
      : defaults.externalConnectors,
    externalToolRuns: normalizeExternalToolRuns(parsed.externalToolRuns),
    agentProfiles: Object.keys(parsed).length===0 ? defaults.agentProfiles : normalizeAgentProfiles(hydrateAgentRecords(parsed)),
    projectAgentOverrides: normalizeProjectAgentOverrides(
      hydrateProjectAgentRecords(parsed),
      hydrateAgentRecords(parsed),
    ),
    tasks: normalizeTasks(parsed.tasks),
    mobileTaskSync: parsed.mobileTaskSync || null,
    mobileWorkspaceSync: parsed.mobileWorkspaceSync || null,
    mobileMemoryPending: parsed.mobileMemoryPending || null,
    mobileWorkspaceDevice: typeof parsed.mobileWorkspaceDevice === 'string' ? parsed.mobileWorkspaceDevice : null,
    approvals: normalizeApprovals(parsed.approvals),
  };
}
