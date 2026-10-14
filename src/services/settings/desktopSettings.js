// Architecture migration: byte-for-byte command port.
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { normalizePromptHistory } from '../../domain/activity/activityLog.js';

export async function prepareDesktopLaunchState() {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => prepareDesktopLaunchState(...arguments));
  // 2026-05-23 架构 audit #3: migrate read-modify-write → updateStateAtomically
  // so a concurrent write (settings save / chat create) can't clobber this
  // launch-state reset and vice versa. Same serialization the migrated
  // updateAgentProfile already uses.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    if (state.settings.localPreferences?.restoreSession) return state;
    state.settings = {
      ...state.settings,
      activeView: 'chat',
      activeMode: 'chat',
      selectedChatId: null,
      selectedFilePath: null,
    };
    return state;
  });
}

export async function updateDesktopSettings(patch) {
  if (Object.hasOwn(patch || {}, 'localProfile') || Object.hasOwn(patch || {}, 'localPreferences')) throw new Error('请使用个人资料与设置入口保存。');
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateDesktopSettings(...arguments));
  // 2026-05-23 架构 audit #3: settings spread-merge inside the mutator so the
  // patch applies to the freshest settings object — a concurrent settings
  // write (e.g. createChat flipping activeView) no longer races to clobber.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    state.settings = {
      ...state.settings,
      ...patch,
      ...(patch?.promptHistory
        ? { promptHistory: normalizePromptHistory(patch.promptHistory) }
        : {}),
    };
    return state;
  });
  return getDesktopBootstrap();
}

export async function toggleConnector(connectorId) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => toggleConnector(...arguments));
  // 2026-05-23 架构 audit #3: the toggle reads the current enabled-set then
  // flips one member — a textbook lost-update if read pre-atomically (two
  // concurrent toggles against the same stale set double-add / double-remove
  // or drop each other). Reading the set INSIDE the mutator makes each toggle
  // apply to the freshest enabled list.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    const enabled = new Set(state.settings.enabledConnectorIds);

    if (enabled.has(connectorId)) {
      enabled.delete(connectorId);
    } else {
      enabled.add(connectorId);
    }

    state.settings.enabledConnectorIds = [...enabled];
    state.settings.selectedConnectorId = connectorId;
    return state;
  });
  return getDesktopBootstrap();
}
