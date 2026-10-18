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
  for (const file of (await readdir(dir)).sort()) {
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
