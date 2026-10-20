// The narrow context app.js hands the approvals feature (features/README.md).
// No uiState: the permission queue the reply stream fills is reached through
// toolPermissions() / setToolPermissions(); Agent names come from
// getBootstrap(); a "一直开启" decision reloads page data via refreshBootstrap().
import { checkFeatureContext } from '../featureContext.js';
import { createApprovalsApi } from './api.js';

export const APPROVALS_CONTEXT = Object.freeze([
  'getBootstrap', 'app', 'api', 'render', 'bgRender', 'showFlashToast', 'refreshBootstrap',
  'toolPermissions', 'setToolPermissions', 'escapeHtml', 'icon',
]);

export let getBootstrap, app, render, bgRender, showFlashToast, refreshBootstrap, toolPermissions, setToolPermissions, escapeHtml, icon, approvalsApi;

export function bindApprovalsContext(context) {
  checkFeatureContext('approvals', context, APPROVALS_CONTEXT);
  ({ getBootstrap, app, render, bgRender, showFlashToast, refreshBootstrap, toolPermissions, setToolPermissions, escapeHtml, icon } = context);
  approvalsApi = createApprovalsApi(context.api);
}
