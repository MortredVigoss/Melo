// Agent settings feature entry (architecture plan P2b, 2026-10-19): the only
// module app.js imports for the Agent page and Customize → Agents.
// installAgentsFeature(context) returns what app.js composes: action/form
// tables for the registry, listener entry points called at their original
// positions, the settingsFormEditors ownership of agent-profile-update, the
// render() / navigation / unload hooks and the two renderers.
import {
  installAgentsController,
  agentsActions,
  agentsForms,
  handleAgentSectionToggle,
  handleAgentProfileInput,
  handleAgentEditorScroll,
  handleAgentFileChange,
  handleAgentProfileChange,
  captureBeforeRender,
  restoreScrollAfterRender,
  syncRuntimeRefresh,
  restoreEditorAfterRender,
  flushPending,
  flushOnUnload,
  ownsFormDraft,
  formDraftScope,
  discardFormDraft,
} from './controller.js';
import { agentsState } from './state.js';
import { renderAgentPage, renderAgentWorkbench } from './view.js';

export function installAgentsFeature(context) {
  installAgentsController(context);
  return {
    actions: agentsActions,
    forms: agentsForms,
    // 'toggle' (capture): remembers opened capability / channel sections.
    handleToggle: handleAgentSectionToggle,
    // 'input': agent-profile-update fields (last branch). Returns true when handled.
    handleInput: handleAgentProfileInput,
    // 'scroll' (capture): editor caret / detail scroll capture.
    handleScroll: handleAgentEditorScroll,
    // 'change': Markdown import / avatar file inputs. Returns false or the pending import.
    handleFileChange: handleAgentFileChange,
    // 'change': agent-profile-update fields (last branch in the try). Returns true when handled.
    handleChange: handleAgentProfileChange,
    // settingsFormEditors: ownsDraft / scope / onCancel for agent-profile-update.
    ownsFormDraft,
    formDraftScope,
    discardFormDraft,
    // render() hooks, called at the positions of the former inline calls.
    captureBeforeRender,
    restoreScrollAfterRender,
    syncRuntimeRefresh,
    restoreEditorAfterRender,
    // Leaving the page / closing the window.
    flushPending,
    flushOnUnload,
    renderPage: renderAgentPage,
    // Customize → Agents detail (renderConnectorDetails).
    renderWorkbench: renderAgentWorkbench,
    getState: () => agentsState,
  };
}
