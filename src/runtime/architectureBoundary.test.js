import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

async function sources(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) files.push(...await sources(url));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(url);
  }
  return files;
}

test('business services cannot import whole-snapshot persistence or depend on the desktop facade', async () => {
  for (const url of await sources(new URL('../services/', import.meta.url))) {
    const source = await readFile(url, 'utf8');
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?/gm)].map(m => m[0]).join('\n');
    assert.doesNotMatch(imports, /\b(saveState|persistStateAtomically|enqueueStateWrite)\b/, url.pathname);
    assert.doesNotMatch(imports, /from ['"][^'"]*desktopStore\.js['"]/, url.pathname);
  }
});
