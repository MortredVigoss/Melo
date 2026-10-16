// Connector rollup builder — sub-phase 7d-5δ commit 8c of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// `buildConnectors` is the per-turn "what does the user have today"
// rollup: walks the BUILTIN_CONNECTORS catalogue, fills in each one's
// runtime config (workspace path, command-template count, last command
// run, etc.), then appends external MCP connectors with their runtime
// status. Used by sendChatMessage (the chat path) and getDesktopBootstrap
// (the UI bootstrap path) and a few task-graph entry points.
//
// Mechanical adaptation (same pattern as Phase 7d-5α-A1 commit 7's
// stateHydration.js and Phase 7d-5δ commit 3's workspaceSnapshot.js):
// this module sits at `src/services/connector/` (3 levels deep), so
// APP_ROOT is computed via four `dirname()` calls. Same value as
// desktopStore's APP_ROOT, just different formula.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_CONNECTORS } from '../../state/stateHydration.js';
import { COMMAND_TEMPLATES } from '../command/commandTemplates.js';
import { visibleArtifacts } from '../../domain/artifact/artifactService.js';
import { formatUpdatedAt } from '../../shared/helpers.js';
import { maskSecret } from './externalConnector.js';

// APP_ROOT — original desktopStore.js: `dirname(dirname(fileURLToPath(import.meta.url)))`.
// This module lives two levels deeper (`src/services/connector/`), so the
// formula needs two extra `dirname()` calls to resolve to the same
// project-root directory. Output identical, formula adjusted for depth.
const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

export function buildConnectors(enabledIds, config, workspace, state, project) {
  const recentCommandRun = workspace.commandRuns[0] || null;
  const builtins = BUILTIN_CONNECTORS.map(connector => {
    let connectorConfig = null;

    switch (connector.id) {
      case 'openai-compatible':
        connectorConfig = {
          authMode: config.authMode,
          maskedApiKey: config.apiKey
            ? `${config.apiKey.slice(0, 4)}...${config.apiKey.slice(-4)}`
            : '(not set)',
          hasApiKey: Boolean(config.apiKey),
          hasCredentials:
            config.authMode === 'codex'
              ? Boolean(config.codexAuth?.loggedIn)
              : config.authMode === 'local'
                ? Boolean(config.baseUrl && config.model)
                : Boolean(config.apiKey),
          baseUrl: config.baseUrl,
          model: config.model,
          systemPrompt: config.systemPrompt,
          codexAuth: config.codexAuth || null,
          // Whisper transcription override fields. The connector detail
          // form (`renderConnectorDetails` in desktop-ui/app.js) reads
          // these as `selected.config.*`; without them the placeholder
          // would always fall back to "Leave blank to use auto-detected
          // key", masking that a key is actually saved. Same masking
          // pattern as the main apiKey above (raw never leaves the
          // server, UI sees prefix...suffix).
          hasWhisperKey: Boolean(config.whisperApiKey),
          maskedWhisperApiKey: config.whisperApiKey
            ? `${config.whisperApiKey.slice(0, 4)}...${config.whisperApiKey.slice(-4)}`
            : '(not set)',
          whisperBaseUrl: config.whisperBaseUrl || '',
          // MiniMax T2A V2 — same purpose. The form lets the user enter
          // a cloned-voice id and a Group ID, plus test playback before
          // committing. Mirrors the masked-key contract above.
          hasMinimaxKey: Boolean(config.minimaxApiKey),
          maskedMinimaxApiKey: config.minimaxApiKey
            ? `${config.minimaxApiKey.slice(0, 4)}...${config.minimaxApiKey.slice(-4)}`
            : '(not set)',
          minimaxGroupId: config.minimaxGroupId || '',
          minimaxVoiceId: config.minimaxVoiceId || '',
        };
        break;
      case 'projects':
        connectorConfig = {
          activeProject: project?.name || '(none)',
          workspacePath: workspace.rootPath || null,
        };
        break;
      case 'artifacts': {
        // Counts must match the bootstrap-visible row set so the UI
        // doesn't display "5 artifacts" while the panel only shows 4
        // live ones (Codex 2026-04-27 audit).
        const live = visibleArtifacts(state.artifacts).filter(a=>a.kind!=='result');
        connectorConfig = {
          totalArtifacts: live.length,
          projectArtifacts: live.filter(artifact => artifact.projectId === project?.id).length,
        };
        break;
      }
      case 'local-files':
        connectorConfig = {
          workspaceRoot: workspace.rootPath,
          exists: workspace.exists,
          fileCount: workspace.fileCount,
          selectedFilePath: workspace.selectedFilePath,
        };
        break;
      case 'local-command':
        connectorConfig = {
          templateCount: COMMAND_TEMPLATES.length,
          lastRun: recentCommandRun
            ? {
                label: recentCommandRun.label,
                success: recentCommandRun.success,
                executedLabel: formatUpdatedAt(recentCommandRun.executedAt),
              }
            : null,
        };
        break;
      default:
        break;
    }

    return {
      ...connector,
      enabled: ['local-files','local-command'].includes(connector.id) || enabledIds.includes(connector.id),
      config: connectorConfig,
    };
  });

  const externals = state.externalConnectors.map(connector => ({
    ...connector,
    enabled: enabledIds.includes(connector.id),
    config: {
      endpoint: connector.endpoint,
      healthPath: connector.healthPath,
      manifestPath: connector.manifestPath,
      contextPath: connector.contextPath,
      resourcePath: connector.resourcePath,
      promptPath: connector.promptPath,
      maskedAuthToken: maskSecret(connector.authToken),
      lastStatus: connector.lastStatus,
      lastError: connector.lastError,
      lastCheckedLabel: connector.lastCheckedAt
        ? formatUpdatedAt(connector.lastCheckedAt)
        : 'Never checked',
      invokePath: connector.invokePath,
      toolCount: connector.manifest.tools.length,
      resourceCount: connector.manifest.resources.length,
      promptCount: connector.manifest.prompts.length,
      manifest: connector.manifest,
      recentRuns: state.externalToolRuns
        .filter(run => run.connectorId === connector.id)
        .slice(0, 4)
        .map(run => ({
          ...run,
          executedLabel: formatUpdatedAt(run.executedAt),
        })),
    },
  }));

  return [...builtins, ...externals];
}
