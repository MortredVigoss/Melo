// Customize feature handle (architecture B3). app.js installs it once and
// registers its actions / forms; renderPage() replaces app.js's
// renderCustomizePage() call in renderPage().
import { bindCustomizeContext } from './context.js';
import { customizeActions, customizeForms } from './controller.js';
import { renderCustomizePage } from './view.js';

export function installCustomizeFeature(context) {
  bindCustomizeContext(context);
  return { actions: customizeActions, forms: customizeForms, renderPage: () => renderCustomizePage() };
}
