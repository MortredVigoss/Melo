// Generated from desktop-ui/tokens.css by scripts/generate-visual-tokens.js.
const defaults = Object.freeze({
  "chat": "#ba793b",
  "chat-light": "#e8ad66",
  "projects": "#8f3945",
  "projects-light": "#cb727b",
  "agents": "#715087",
  "agents-light": "#ae88c7",
  "knowledge": "#506e77",
  "knowledge-light": "#91b3bb",
  "system": "#926044",
  "system-light": "#ce9673",
  "execution-search": "#edb866",
  "execution-compute": "#82bccc",
  "execution-files": "#b9b39b",
  "execution-tools": "#b69bcb",
  "execution-create": "#e88c62",
  "scene-060a10": "#060a10",
  "scene-74849d": "#74849d",
  "scene-ffce97": "#ffce97",
  "scene-75bfd4": "#75bfd4",
  "scene-ffbb78": "#ffbb78",
  "scene-86cddd": "#86cddd",
  "scene-b29d80": "#b29d80",
  "scene-ab8955": "#ab8955",
  "scene-dabc84": "#dabc84",
  "scene-ffe4a3": "#ffe4a3",
  "scene-91b4c7": "#91b4c7",
  "scene-a88b63": "#a88b63"
});
export function visualColor(name) {
  const authored = typeof document !== 'undefined' && typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue('--visual-'+name).trim() : '';
  return authored || defaults[name];
}
export function visualRgb(name) {
  const color = visualColor(name);
  if (/^#[a-f0-9]{6}$/i.test(color)) return [1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16)).join(',');
  const values=color?.match(/^rgba?\(([^)]+)\)/)?.[1].split(',').slice(0,3).map(v=>v.trim());
  return values?.join(',') || [1,3,5].map(offset=>parseInt(defaults[name].slice(offset,offset+2),16)).join(',');
}
