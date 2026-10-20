// Customize feature handle (architecture B3). app.js installs it once and
// registers its actions / forms; renderPage() replaces app.js's old
// renderCustomizePage() call; the input / change entry points are called at
// the listener positions the branches used to occupy; refreshAdvancedStatus
// serves the Tools & Tasks management actions that still live in app.js.
import { bindCustomizeContext } from './context.js';
import { customizeActions, customizeForms, handleInput, handleChange, handleSkillFilterStateChange, refreshAdvancedStatus } from './controller.js';
import { renderCustomizePage } from './view.js';
import { customizeState, resetCustomizeState } from './state.js';

export function installCustomizeFeature(context) {
  bindCustomizeContext(context);
  resetCustomizeState();
  return {
    actions: customizeActions,
    forms: customizeForms,
    renderPage: () => renderCustomizePage(),
    handleInput,
    handleChange,
    handleSkillFilterStateChange,
    refreshAdvancedStatus,
    getState: () => customizeState,
  };
}
