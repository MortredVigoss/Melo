import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
// External-connector mutation handlers — sub-phase 7d-5ε commit 1 of
// the desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// The seven exported functions in this module form the desktopStore-side
// CRUD surface for external (MCP-compatible) connectors. Every one is
// a small read-modify-persist orchestrator on top of the pure helpers
// already in `externalConnector.js`. They were originally LOCAL exports
// in desktopStore.js; server.js calls them directly from HTTP route
// handlers, and the desktopStore.js back-compat re-exports keep the
// existing import paths working.
//
// Members (all exported, source-order):
//
//   • createExternalConnector
//   • updateExternalConnector
//   • removeExternalConnector
//   • pingExternalConnector
//   • readExternalConnectorResource
//   • previewExternalConnectorPrompt
//   • invokeExternalConnectorTool
//
// All upstream deps live in dedicated leaf modules — no reverse imports
// from desktopStore are needed.

import { randomUUID } from 'node:crypto';
import { nowIso } from '../../shared/helpers.js';
import {
  loadState,
  updateStateAtomically,
} from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import {
  findExternalConnectorById,
  findProjectById,
} from '../../state/stateLookups.js';
import { BUILTIN_CONNECTORS } from '../../state/stateHydration.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshot.js';
import {
  normalizeExternalConnector,
  refreshExternalConnectorStatus,
  readExternalConnectorResourcePayload,
  readExternalConnectorPromptPayload,
  requestExternalConnectorJson,
} from './externalConnector.js';
import { normalizeExternalToolRuns } from '../../domain/activity/activityLog.js';

export async function createExternalConnector({
  name,
  description,
  endpoint,
  prompt,
  authToken,
  healthPath,
  manifestPath,
  contextPath,
  resourcePath,
  promptPath,
  invokePath,
}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createExternalConnector(...arguments));
  await updateStateAtomically(state => {
    const connector = normalizeExternalConnector({
      id: randomUUID(),
      name: name?.trim() || 'External connector',
      description: description?.trim() || '',
      endpoint,
      prompt: prompt?.trim() || '',
      authToken: authToken?.trim() || '',
      healthPath,
      manifestPath,
      contextPath,
      resourcePath,
      promptPath,
      invokePath,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    if (!connector.endpoint) {
      throw new Error('Connector endpoint is required.');
    }

    state.externalConnectors.unshift(connector);
    if (!state.settings.enabledConnectorIds.includes(connector.id)) {
      state.settings.enabledConnectorIds.push(connector.id);
    }
    state.settings.selectedConnectorId = connector.id;
    state.settings.selectedCustomizeSection = 'connectors';
    state.settings.activeView = 'customize';
    return state;
  });

  return getDesktopBootstrap();
}

export async function updateExternalConnector(connectorId, patch) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateExternalConnector(...arguments));
  // Sanitize the patch so blank strings on secret-like fields are dropped
  // instead of overwriting the persisted value. See
  // feedback_preserve_user_config.md. The existing authToken line below is
  // kept for belt-and-suspenders correctness even though the sanitizer would
  // already strip it.
  const SECRET_LIKE_CONNECTOR_KEYS = [
    'authToken',
    'apiKey',
    'clientSecret',
    'username',
    'password',
  ];
  const safePatch = { ...(patch || {}) };
  for (const key of SECRET_LIKE_CONNECTOR_KEYS) {
    if (!(key in safePatch)) continue;
    const v = safePatch[key];
    if (typeof v !== 'string' || !v.trim()) {
      delete safePatch[key];
    }
  }

  // The connector lives inside persistent state, so wrap the read-modify-write
  // in updateStateAtomically (same reasoning as updateAgentProfile above).
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    const connector = findExternalConnectorById(state, connectorId);
    if (!connector) {
      throw new Error('External connector not found.');
    }

    Object.assign(
      connector,
      normalizeExternalConnector({
        ...connector,
        ...safePatch,
        id: connector.id,
        createdAt: connector.createdAt,
        authToken:
          safePatch?.authToken && String(safePatch.authToken).trim()
            ? String(safePatch.authToken).trim()
            : connector.authToken,
        updatedAt: nowIso(),
      }),
    );

    return state;
  });

  return getDesktopBootstrap();
}

export async function removeExternalConnector(connectorId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => removeExternalConnector(...arguments));
  await updateStateAtomically(state => {
    const nextConnectors = state.externalConnectors.filter(connector => connector.id !== connectorId);
    if (nextConnectors.length === state.externalConnectors.length) {
      throw new Error('External connector not found.');
    }

    state.externalConnectors = nextConnectors;
    state.settings.enabledConnectorIds = state.settings.enabledConnectorIds.filter(
      id => id !== connectorId,
    );
    if (state.settings.selectedConnectorId === connectorId) {
      state.settings.selectedConnectorId = BUILTIN_CONNECTORS[0].id;
    }

    return state;
  });
  return getDesktopBootstrap();
}

export async function pingExternalConnector(connectorId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => pingExternalConnector(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const connector = findExternalConnectorById(state, connectorId);
  if (!connector) {
    throw new Error('External connector not found.');
  }

  const refreshed = await refreshExternalConnectorStatus(connector);
  await updateStateAtomically(latest => {
    const current = findExternalConnectorById(latest, connectorId);
    // A response from an old endpoint must not overwrite edited credentials/configuration.
    if (!current || current.endpoint !== connector.endpoint || current.authToken !== connector.authToken) return;
    for (const key of ['lastStatus', 'lastError', 'lastCheckedAt', 'manifest']) {
      current[key] = refreshed[key];
    }
    current.updatedAt = nowIso();
  });
  return getDesktopBootstrap();
}

export async function readExternalConnectorResource({
  connectorId,
  resourceId,
  projectId,
}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => readExternalConnectorResource(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const connector = findExternalConnectorById(state, connectorId);
  if (!connector) {
    throw new Error('External connector not found.');
  }

  const project = findProjectById(state, projectId);
  const workspace = await buildWorkspaceSnapshot(state, project);
  return readExternalConnectorResourcePayload(connector, {
    resourceId,
    activeMode: state.settings.activeMode,
    project,
    selectedFile: workspace.selectedFile
      ? {
          path: workspace.selectedFile.path,
          language: workspace.selectedFile.language,
        }
      : null,
  });
}

export async function previewExternalConnectorPrompt({
  connectorId,
  promptId,
  projectId,
}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => previewExternalConnectorPrompt(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const connector = findExternalConnectorById(state, connectorId);
  if (!connector) {
    throw new Error('External connector not found.');
  }

  const project = findProjectById(state, projectId);
  const workspace = await buildWorkspaceSnapshot(state, project);
  return readExternalConnectorPromptPayload(connector, {
    promptId,
    activeMode: state.settings.activeMode,
    project,
    selectedFile: workspace.selectedFile
      ? {
          path: workspace.selectedFile.path,
          language: workspace.selectedFile.language,
        }
      : null,
  });
}

export async function invokeExternalConnectorTool({
  connectorId,
  toolName,
  input,
  projectId,
}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => invokeExternalConnectorTool(...arguments));
  const state = ensureSelectedEntities(await loadState());
  const connector = findExternalConnectorById(state, connectorId);
  if (!connector) {
    throw new Error('External connector not found.');
  }

  const normalizedToolName = String(toolName || '').trim();
  if (!normalizedToolName) {
    throw new Error('Tool name is required.');
  }

  const project = findProjectById(state, projectId);
  const workspace = await buildWorkspaceSnapshot(state, project);

  let parsedInput = {};
  if (typeof input === 'string') {
    const trimmed = input.trim();
    parsedInput = trimmed ? JSON.parse(trimmed) : {};
  } else if (input && typeof input === 'object') {
    parsedInput = input;
  }

  try {
    const payload = await requestExternalConnectorJson(connector, connector.invokePath, {
      method: 'POST',
      body: {
        tool: normalizedToolName,
        input: parsedInput,
        activeMode: state.settings.activeMode,
        project: project
          ? {
              id: project.id,
              name: project.name,
              summary: project.summary,
              instructions: project.instructions,
              workspacePath: project.workspacePath,
            }
          : null,
        selectedFile: workspace.selectedFile
          ? {
              path: workspace.selectedFile.path,
              language: workspace.selectedFile.language,
            }
          : null,
      },
    });

    state.externalToolRuns.unshift({
      id: randomUUID(),
      connectorId: connector.id,
      connectorName: connector.name,
      toolName: normalizedToolName,
      success: true,
      input: JSON.stringify(parsedInput, null, 2),
      output:
        typeof payload?.output === 'string'
          ? payload.output
          : JSON.stringify(payload, null, 2),
      executedAt: nowIso(),
    });
    state.externalToolRuns = normalizeExternalToolRuns(state.externalToolRuns);
    connector.lastStatus = 'connected';
    connector.lastError = '';
    connector.lastCheckedAt = nowIso();
    connector.updatedAt = nowIso();
    await persistConnectorToolOutcome(connector, state.externalToolRuns[0]);

    return {
      bootstrap: await getDesktopBootstrap(),
      toolRun: state.externalToolRuns[0],
    };
  } catch (error) {
    state.externalToolRuns.unshift({
      id: randomUUID(),
      connectorId: connector.id,
      connectorName: connector.name,
      toolName: normalizedToolName,
      success: false,
      input: JSON.stringify(parsedInput, null, 2),
      output: error.message,
      executedAt: nowIso(),
    });
    state.externalToolRuns = normalizeExternalToolRuns(state.externalToolRuns);
    connector.lastStatus = 'error';
    connector.lastError = error.message;
    connector.lastCheckedAt = nowIso();
    connector.updatedAt = nowIso();
    await persistConnectorToolOutcome(connector, state.externalToolRuns[0]);
    throw error;
  }
}

async function persistConnectorToolOutcome(connector, toolRun) {
  await updateStateAtomically(latest => {
    latest.externalToolRuns = normalizeExternalToolRuns([toolRun, ...latest.externalToolRuns]);
    const current = findExternalConnectorById(latest, connector.id);
    if (!current || current.endpoint !== connector.endpoint || current.authToken !== connector.authToken) return;
    for (const key of ['lastStatus', 'lastError', 'lastCheckedAt']) current[key] = connector[key];
    current.updatedAt = nowIso();
  });
}
