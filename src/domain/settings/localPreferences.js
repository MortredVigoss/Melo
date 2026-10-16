// Device-local preferences. Deliberately excluded from portable workspace sync.
export const LOCAL_PREFERENCE_DEFAULTS = Object.freeze({
  interfaceLanguage: 'zh-CN', textSize: 'standard', motion: 'system', autoCollapse: true,
  sendShortcut: 'enter', voiceLanguage: 'zh-CN', restoreSession: false,
});
const choices = {
  interfaceLanguage: ['zh-CN', 'en', 'ko', 'ja', 'es'],
  textSize: ['small', 'standard', 'large', 'larger'],
  motion: ['system', 'reduced'], sendShortcut: ['enter', 'command-enter'],
  voiceLanguage: ['zh-CN', 'en-US', 'system'],
};
export function normalizeLocalPreferences(raw = {}) {
  return Object.fromEntries(Object.entries(LOCAL_PREFERENCE_DEFAULTS).map(([key, fallback]) => [key,
    choices[key] ? (choices[key].includes(raw?.[key]) ? raw[key] : fallback)
      : typeof raw?.[key] === 'boolean' ? raw[key] : fallback,
  ]));
}
export function validateLocalPreferencePatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('设置格式无效。');
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(LOCAL_PREFERENCE_DEFAULTS, key) || (choices[key] ? !choices[key].includes(value) : typeof value !== 'boolean')) throw new Error('设置值无效，请刷新后重试。');
  }
  return { ...raw };
}
