// The grant ledger is reachable only through the elevation service, and the
// service only from the executor's capability check, the HTTP routes and the
// turn lifecycle — never from a model tool, a prompt builder, memory, sync or
// the bootstrap (docs/capability-elevation-20261020.md, rule 5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(path);
  }
  return out;
}
// Files that import `target` (repo-relative), statically or dynamically.
async function importers(target) {
  const found = [];
  for (const file of await sources(join(root, 'src'))) {
    const text = await readFile(file, 'utf8');
    const specifiers = [...text.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] || m[2]);
    if (specifiers.some(spec => spec.startsWith('.') && relative(root, resolve(dirname(file), spec)) === target)) found.push(relative(root, file));
  }
  return found.sort();
}

test('only the elevation service touches the grant ledger', async () => {
  assert.deepEqual(await importers('src/persistence/capabilityGrantLedger.js'), ['src/services/agent/capabilityElevation.js']);
});

test('the elevation service is reached only by the executor, the routes and the turn lifecycle', async () => {
  assert.deepEqual(await importers('src/services/agent/capabilityElevation.js'), [
    'src/http/capabilityRoutes.js',
    'src/services/chat/sendChatMessage.js',
    'src/tools/executor.js',
  ]);
});

test('no tool, prompt, memory, sync or bootstrap module names the ledger file', async () => {
  for (const file of await sources(join(root, 'src'))) {
    const rel = relative(root, file);
    if (['src/persistence/capabilityGrantLedger.js'].includes(rel)) continue;
    const text = await readFile(file, 'utf8');
    assert.equal(text.includes('capability-grants.json'), false, `${rel} names the grant ledger file`);
  }
});
