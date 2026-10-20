// Approvals feature entry (capability elevation, 2026-10-20). So far it owns
// the capability prompt card and the «临时授权» list; the tool permission and
// file-safety dialogs' JS is still in app.js (their styles are in
// approvals.css, as before).
import { installApprovalsController, approvalsActions, focusPromptAfterRender, loadGrants } from './controller.js';
import { approvalsState } from './state.js';
import { renderCapabilityPrompt, renderGrantList } from './view.js';

export function installApprovalsFeature(context) {
  installApprovalsController(context);
  return {
    actions: approvalsActions,
    // renderToolPermissionDialog() hands a queued entry of kind 'capability' here.
    renderCapabilityPrompt,
    // Agent settings (one Agent) and Customize → Safety (all Agents).
    renderGrantList,
    // render() hook, after the other restores.
    focusPromptAfterRender,
    reloadGrants: () => loadGrants({ force: true }),
    getState: () => approvalsState,
  };
}
