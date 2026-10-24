import { normalizeLocale } from '../../../shared/agent/locale.js';
const systemLocale = normalizeLocale(typeof navigator !== 'undefined' ? navigator.language : Intl.DateTimeFormat().resolvedOptions().locale);
const interfaceDefault = ['zh','en','ja','ko','es'].includes(systemLocale) ? (systemLocale === 'zh' ? 'zh-CN' : systemLocale) : 'en';
// Device-local preferences. Deliberately excluded from portable workspace sync.
export const LOCAL_PREFERENCE_DEFAULTS = Object.freeze({
  interfaceLanguage: interfaceDefault, textSize: 'standard', motion: 'system', autoCollapse: true,
  sendShortcut: 'enter', voiceLanguage: 'system', restoreSession: false,
  // Per-Agent permissions for this computer (the phone's 这台手机上 has the
  // same shape, 2026-10-22): { [agentId]: { location: true } }. Only true
  // values are stored, so an Agent is off until the user turns it on here.
  agentDevice: Object.freeze({}),
});
export const DEVICE_PERMISSION_KEYS = Object.freeze(['location']);
const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
function normalizeAgentDevice(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [agentId, grants] of Object.entries(raw)) {
    if (!AGENT_ID.test(agentId) || !grants || typeof grants !== 'object' || Array.isArray(grants)) continue;
    const entry = Object.fromEntries(DEVICE_PERMISSION_KEYS.filter(key => grants[key] === true).map(key => [key, true]));
    if (Object.keys(entry).length) out[agentId] = entry;
  }
  return out;
}
export const agentDevicePermission = (preferences, agentId, key) => preferences?.agentDevice?.[agentId]?.[key] === true;
const choices = {
  interfaceLanguage: ['zh-CN', 'en', 'ko', 'ja', 'es'],
  textSize: ['small', 'standard', 'large', 'larger'],
  motion: ['system', 'reduced'], sendShortcut: ['enter', 'command-enter'],
  voiceLanguage: ['zh-CN', 'en-US', 'system'],
};
export function normalizeLocalPreferences(raw = {}) {
  return Object.fromEntries(Object.entries(LOCAL_PREFERENCE_DEFAULTS).map(([key, fallback]) => [key,
    key === 'agentDevice' ? normalizeAgentDevice(raw?.agentDevice)
      : choices[key] ? (choices[key].includes(raw?.[key]) ? raw[key] : fallback)
      : typeof raw?.[key] === 'boolean' ? raw[key] : fallback,
  ]));
}
export function validateLocalPreferencePatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('设置格式无效。');
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'agentDevice') {
      const valid = value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([agentId, grants]) =>
        AGENT_ID.test(agentId) && grants && typeof grants === 'object' && !Array.isArray(grants) &&
        Object.entries(grants).every(([name, on]) => DEVICE_PERMISSION_KEYS.includes(name) && typeof on === 'boolean'));
      if (!valid) throw new Error('设置值无效，请刷新后重试。');
      continue;
    }
    if (!Object.hasOwn(LOCAL_PREFERENCE_DEFAULTS, key) || (choices[key] ? !choices[key].includes(value) : typeof value !== 'boolean')) throw new Error('设置值无效，请刷新后重试。');
  }
  return { ...raw };
}
