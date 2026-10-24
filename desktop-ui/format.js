import { currentLanguage } from './i18n.js';
const STYLES = {
  compact: { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' },
  full: { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false },
  clock: { hour:'2-digit', minute:'2-digit', second:'2-digit' },
};
export function formatTime(value, { style='compact', locale=currentLanguage(), timeZone, invalid='' } = {}) {
  if (value === null || value === undefined || value === '') return invalid;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return invalid;
  const options = { ...(STYLES[style] || STYLES.compact), ...(timeZone ? { timeZone } : {}) };
  try { return new Intl.DateTimeFormat(locale, options).format(date); }
  catch { return new Intl.DateTimeFormat('en', STYLES[style] || STYLES.compact).format(date); }
}
export function formatNumber(value, locale=currentLanguage()) {
  try { return new Intl.NumberFormat(locale).format(value); }
  catch { return new Intl.NumberFormat('en').format(value); }
}
