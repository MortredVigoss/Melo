// Approvals feature controller (capability elevation, 2026-10-20): answers the
// capability prompts the reply stream queues, loads and revokes temporary
// grants. Registered once by app.js through the action registry.
import { t } from '../../i18n.js';
import { approvalsState, resetApprovalsState } from './state.js';
import { bindApprovalsContext, approvalsApi, app, render, bgRender, notify, refreshBootstrap, toolPermissions, setToolPermissions } from './context.js';

export const GRANTS_TTL_MS = 5000;

export function installApprovalsController(context) {
  bindApprovalsContext(context);
  resetApprovalsState();
}

export async function loadGrants({ force = false } = {}) {
  if (approvalsState.grantsLoading && !force) return;
  approvalsState.grantsLoading = true;
  try {
    const payload = await approvalsApi.grants();
    approvalsState.grants = Array.isArray(payload?.grants) ? payload.grants : [];
    approvalsState.grantsError = '';
  } catch (error) {
    approvalsState.grantsError = t('临时授权读取失败：{reason}', { reason: error.message });
  } finally {
    approvalsState.grantsLoading = false;
    approvalsState.grantsLoadedAt = Date.now();
    bgRender();
  }
}

/** Called by the list renderer: a stale or never-loaded list refreshes itself once. */
export function ensureGrants() {
  if (approvalsState.grantsLoading) return;
  if (approvalsState.grantsLoadedAt && Date.now() - approvalsState.grantsLoadedAt < GRANTS_TTL_MS) return;
  approvalsState.grantsLoading = true;
  Promise.resolve().then(() => { approvalsState.grantsLoading = false; return loadGrants(); });
}

const capabilityEntry = requestId => toolPermissions().find(entry => entry.kind === 'capability' && entry.requestId === requestId);
const dropEntry = requestId => setToolPermissions(toolPermissions().filter(entry => entry.requestId !== requestId));

const ERROR_TEXT = {
  ALWAYS_UNAVAILABLE: () => t('全局设置没有开启这个能力，项目设置不能单独开启；可以选择仅本次。'),
  AGENT_MIGRATION_REQUIRED: () => t('请先在 Agent 设置里完成能力迁移。'),
  CAPABILITY_DECISION_IN_PROGRESS: () => t('正在保存上一次选择，请稍候。'),
};

export async function respondCapabilityRequest(requestId, decision) {
  const entry = capabilityEntry(requestId);
  if (!entry || entry.submitting) return;
  entry.submitting = true;
  entry.error = '';
  render();
  try {
    await approvalsApi.respondCapability({ requestId, decision });
    dropEntry(requestId);
    approvalsState.grantsLoadedAt = 0;
    if (decision === 'always') await refreshBootstrap();
  } catch (error) {
    if (error.message === 'CAPABILITY_REQUEST_NOT_FOUND') {
      // Timed out, cancelled or answered elsewhere: nothing was granted.
      dropEntry(requestId);
      notify({level:'success',text:t('这个授权请求已经结束，没有保存任何授权。')});
    } else {
      entry.error = (ERROR_TEXT[error.message] || (() => t('授权没有保存：{reason}', { reason: error.message })))();
    }
  } finally {
    entry.submitting = false;
    render();
  }
}

export async function revokeGrant(id) {
  if (!id || approvalsState.revoking[id]) return;
  approvalsState.revoking[id] = true;
  render();
  try {
    await approvalsApi.revokeGrant(id);
    approvalsState.grants = approvalsState.grants.filter(grant => grant.id !== id);
    notify({level:'success',text:t('已撤销临时授权，下一次工具调用起生效。')});
  } catch (error) {
    // Already expired / revoked elsewhere: the reload below shows the truth.
    approvalsState.grantsError = error.message === 'CAPABILITY_GRANT_NOT_FOUND' ? '' : t('撤销没有完成：{reason}', { reason: error.message });
  } finally {
    delete approvalsState.revoking[id];
    await loadGrants({ force: true });
  }
}

/**
 * render() hook (after the other restores): a newly shown capability prompt
 * takes keyboard focus once, on its first offered decision.
 */
export function focusPromptAfterRender() {
  const shell = app?.querySelector?.('[data-capability-request]');
  const id = shell?.dataset.capabilityRequest || '';
  if (!id || id === approvalsState.focusedRequestId) return;
  approvalsState.focusedRequestId = id;
  shell.querySelector('[data-action="capability-request-respond"]')?.focus?.();
}

export const approvalsActions = {
  'capability-request-respond': async ({ trigger }) => {
    await respondCapabilityRequest(trigger.dataset.requestId, trigger.dataset.decision);
  },
  'capability-grant-revoke': async ({ trigger }) => {
    await revokeGrant(trigger.dataset.grantId);
  },
  'capability-grants-refresh': async () => {
    await loadGrants({ force: true });
  },
};
