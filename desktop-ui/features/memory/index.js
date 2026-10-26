// Memory feature entry (architecture plan P2, 2026-10-19): the only module
// app.js imports for the memory page, the project memory book and the reply
// footer. installMemoryFeature(context) returns what app.js composes:
// action/form tables for the registry, listener entry points called at their
// original positions, the bootstrap hook and the three renderers.
import {
  installMemoryController,
  memoryActions,
  memoryForms,
  handleMemoryFactFieldInput,
  handleMemoryInput,
  handleMemoryChange,
  handleMemoryRefsToggle,
  syncProjectDetailView,
  projectBookData,
} from './controller.js';
import { memoryState } from './state.js';
import { renderMemoryPane } from './viewPane.js';
import { renderProjectMemoryBook } from './viewProjectBook.js';
import { renderMessageMemoryRefs } from './viewMessageRefs.js';

export function installMemoryFeature(context) {
  installMemoryController(context);
  return {
    actions: memoryActions,
    forms: memoryForms,
    // 'input' + 'change': memory-fact editor fields (first branch, before the typing stamp).
    handleFieldInput: handleMemoryFactFieldInput,
    // 'input': embedding connection fields and the memory-book draft.
    handleInput: handleMemoryInput,
    // 'change': memory-book section / draft. Returns false, true or a promise.
    handleChange: handleMemoryChange,
    // 'toggle' (capture): remembers opened reply footers.
    handleToggle: handleMemoryRefsToggle,
    // Every bootstrap that lands: load / drop the project page's book.
    onBootstrap: syncProjectDetailView,
    renderPane: renderMemoryPane,
    renderProjectBook: project => renderProjectMemoryBook(project, projectBookData(project.id), { busy: memoryState.projectBookBusy, feedback: memoryState.projectBookFeedback, draft: memoryState.projectBookDraft?.projectId === project.id ? memoryState.projectBookDraft : null }),
    renderMessageRefs: message => renderMessageMemoryRefs(message, { feedback: memoryState.memoryRefFeedback, busy: memoryState.memoryFactBusy, open: Boolean(memoryState.memoryRefsOpen[message.id]) }),
    cancelCreateForm() { memoryState.projectBookDraft=null; },
    getState: () => memoryState,
  };
}
