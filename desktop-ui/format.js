import { currentLanguage } from './i18n.js';
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '';
  try { return new Intl.DateTimeFormat(currentLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)); }
  catch { return new Date(ms).toLocaleString(); }
}
