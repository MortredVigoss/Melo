import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_BEHAVIOR } from '../shared/agent/runtimeBehavior.js';

test('runtime switch directory covers user behavior and every production boolean environment consumer', async () => {
  const doc = await readFile(new URL('../docs/env-flags.md', import.meta.url), 'utf8');
  const required = new Set(Object.values(RUNTIME_BEHAVIOR).map(row => row.env));
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (['dist','node_modules','upstream'].includes(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(/\benv\.(MELO_[A-Z_]+)\s*[!=]==?\s*['"]1['"]/g)) required.add(match[1]);
      }
    }
  }
  await walk(fileURLToPath(new URL('../src/', import.meta.url)));
  for (const name of required) assert.ok(doc.includes(name), `Undocumented runtime switch: ${name}`);
});
