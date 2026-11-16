// Four visual variants. Existing action/layout hooks remain available to
// feature owners; they are not separate button designs.
export const BUTTON_VARIANTS = Object.freeze(['primary','secondary','ghost','icon']);
// These buttons are interactive content, navigation, or selection controls.
// Their component owns the hit area and selected state, not action-button chrome.
// The composer's call toggle is a pressed-state pill like the composer's context pills (2026-11-16).
const CONTENT_CONTROLS = '.neural-brand,.neural-cluster,.neural-branch,.execution-label,.execution-signal,.project-card,.artifact-card,.artifact-mini-card,.chat-row,.list-row,.mini-list-item,.tree-row,.agent-selector-row,.model-picker-option,.composer-menu-item,.palette-item,.slash-palette-item,.edit-context-item,.message-image-preview,.toggle-switch,.tts-radio-row,.agent-channel-tab,.skill-tab,.voice-call-toggle';
export function applyButtonStyles(root) {
  for (const button of root?.querySelectorAll('button') || []) {
    const classes = button.classList;
    if (button.matches(CONTENT_CONTROLS)) {
      for (const name of BUTTON_VARIANTS) classes.remove(`button-${name}`);
      continue;
    }
    const explicit = button.dataset.buttonVariant;
    const icon = /(?:composer-icon|icon-toggle|atomic|search-clear|thread-scroll-jump)-button/.test(button.className)
      || (!button.textContent.trim() && Boolean(button.querySelector('svg')));
    const primary = classes.contains('is-primary') || classes.contains('settings-save-button');
    const ghost = /(?:ghost|chip|copy-link|link|undo-toast|project-back)-button/.test(button.className);
    const variant = BUTTON_VARIANTS.includes(explicit) ? explicit : icon ? 'icon' : primary ? 'primary' : ghost ? 'ghost' : 'secondary';
    for (const name of BUTTON_VARIANTS) classes.toggle(`button-${name}`, name === variant);
  }
}
