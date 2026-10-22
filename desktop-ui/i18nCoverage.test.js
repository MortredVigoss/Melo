// Bug audit 2026-10-18 U6: every `t('…')` literal in the desktop UI needs a
// five-language catalog row, otherwise other languages silently show Chinese.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { translations } from './translations.js';
import { LANGUAGES } from './i18n.js';

const dir = new URL('./', import.meta.url);
// t('literal') / t("literal") with optional whitespace; escaped quotes allowed.
const LITERAL = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;

export async function scanTranslationLiterals() {
  const found = new Map();
  // Recursive since architecture plan P2 moved page code into features/<name>/.
  for (const file of (await readdir(dir, { recursive: true })).sort()) {
    if (!file.endsWith('.js') || file.includes('.test.')) continue;
    const source = await readFile(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(LITERAL)) {
      const key = match[2].replace(/\\(['"])/g, '$1');
      if (!found.has(key)) found.set(key, new Set());
      found.get(key).add(file);
    }
  }
  return found;
}

test('every t() literal in desktop-ui has a catalog row in all five languages', async () => {
  const found = await scanTranslationLiterals();
  assert.ok(found.size > 100, `scanner found ${found.size} literals; the regex probably broke`);
  const missing = [...found].filter(([key]) => !translations[key]).map(([key, files]) => `${[...files].join(',')}: ${key}`);
  assert.deepEqual(missing, [], 'add these rows to desktop-ui/translations.js and run node scripts/build-interface-languages.js');
  for (const [key] of found) for (const { id } of LANGUAGES) assert.ok(translations[key][id]?.trim(), `${id}: ${key}`);
});

test('placeholders in catalog rows match the Chinese source', () => {
  for (const [key, row] of Object.entries(translations)) {
    const expected = [...new Set(key.match(/\{\w+\}/g) || [])].sort();
    for (const { id } of LANGUAGES) {
      const actual = [...new Set(row[id].match(/\{\w+\}/g) || [])].sort();
      assert.deepEqual(actual, expected, `${id}: ${key}`);
    }
  }
});

// Audit 2026-10-22: authored Chinese inside templates must be reachable by the
// catalog too, otherwise every other language shows Chinese (the model and
// search settings did). This mirrors i18n.js: in a `ui` template the trimmed
// static text nodes and the title / aria-label / placeholder / alt attributes
// are the keys, with placeholders renumbered {0}… per node; a plain template
// that renders markup is never translated, so it has to be tagged `ui`.
// Templates that build content rather than interface are listed here, and so is
// the launch screen: a classic <script> drawn before any module (or the
// language) loads, so it cannot import the catalog.
const CONTENT_TEMPLATES = new Set(['features/agents/agentDraft.js', 'videoKnowledge.js', 'launchScreen.js']);
const CJK = /[一-鿿]/;

// Template literals of a module: `{ tagged, text }` with every `${…}` replaced by a marker.
export function templateLiterals(source) {
  const out = []; let i = 0;
  const skipString = quote => { i++; while (i < source.length && source[i] !== quote) { if (source[i] === '\\') i++; i++; } i++; };
  const regexAllowed = () => { const before = source.slice(0, i).replace(/\s+$/, ''); return !before || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(?:return|typeof|case|in|of|do|else|void|throw|new|delete|instanceof)$/.test(before); };
  const readTemplate = () => {
    let text = ''; i++;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { text += c + source[i + 1]; i += 2; continue; }
      if (c === '`') { i++; return text; }
      if (c === '$' && source[i + 1] === '{') {
        i += 2; let depth = 1;
        while (i < source.length && depth) {
          const d = source[i];
          if (d === '`') { const nestedTagged = /\bui\s*$/.test(source.slice(Math.max(0, i - 4), i)); out.push({ tagged: nestedTagged, text: readTemplate() }); continue; }
          if (d === "'" || d === '"') { skipString(d); continue; }
          if (d === '{') depth++; else if (d === '}') depth--;
          i++;
        }
        text += ''; continue;
      }
      text += c; i++;
    }
    return text;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '/' && regexAllowed()) { i++; let cls = false; while (i < source.length) { const d = source[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) { i++; break; } else if (d === '\n') break; i++; } continue; }
    if (c === "'" || c === '"') { skipString(c); continue; }
    if (c === '`') { const tagged = /\bui\s*$/.test(source.slice(Math.max(0, i - 4), i)); out.push({ tagged, text: readTemplate() }); continue; }
    i++;
  }
  return out;
}
// The catalog keys a template's Chinese text resolves to (same split as i18n.js).
export function templateTextKeys(text) {
  const keys = [];
  const push = raw => { const core = raw.trim(); if (!core || !CJK.test(core)) return; let n = 0; keys.push(core.replace(//g, () => `{${n++}}`)); };
  for (const part of text.split(/(<[^>]*>)/g)) {
    if (part.startsWith('<')) { for (const match of part.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"]*)"/g)) push(match[1]); }
    else push(part);
  }
  return keys;
}

test('Chinese text in ui templates has a catalog row, and markup templates are tagged ui', async () => {
  const missing = [], untagged = [];
  for (const file of (await readdir(dir, { recursive: true })).sort()) {
    if (!file.endsWith('.js') || file.includes('.test.') || file.startsWith('vendor') || file === 'translations.js' || CONTENT_TEMPLATES.has(file)) continue;
    for (const { tagged, text } of templateLiterals(await readFile(new URL(file, dir), 'utf8'))) {
      const keys = templateTextKeys(text);
      if (!keys.length) continue;
      if (tagged) { for (const key of keys) if (!translations[key]) missing.push(`${file}: ${key}`); }
      else if (/<[a-z!/]/i.test(text)) untagged.push(`${file}: ${keys[0]}`);
    }
  }
  assert.deepEqual(missing, [], 'add rows to desktop-ui/translations.js for this ui-template text');
  assert.deepEqual(untagged, [], 'tag these markup templates with ui`…` so the text can be translated');
});
