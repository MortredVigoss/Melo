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
  "scene-ffe4a3": "#ffe4a3"
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

const sceneDefaults = Object.freeze({
  "neural-background": "#080807",
  "neural-gold": "#d3a459",
  "neural-clay": "#a97862",
  "neural-slate": "#737779",
  "neural-sand": "#b2a893",
  "neural-light": "#edc786",
  "neural-silver": "#91a0b3",
  "neural-shadow": "#080b13",
  "atom-h": "#f0f0f0",
  "atom-c": "#c4c4c4",
  "atom-n": "#6bb0ff",
  "atom-o": "#ff8080",
  "atom-f": "#ffe06b",
  "atom-cl": "#9be88a",
  "atom-br": "#d8a272",
  "atom-i": "#c18aff",
  "atom-p": "#ffaa66",
  "atom-s": "#ffe066",
  "atom-alkali": "#c0c0ff",
  "atom-fe": "#ff9a66",
  "atom-mg": "#a3ff9e",
  "atom-default": "#d0d0d0",
  "diagram-point": "#fff7f3"
});
export function sceneColor(name) {
  const authored = typeof document !== 'undefined' && typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue('--scene-'+name).trim() : '';
  return authored || sceneDefaults[name];
}
