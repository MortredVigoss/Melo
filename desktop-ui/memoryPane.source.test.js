import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, 'app.js'), 'utf8');

test('Memory pane wipe action sends an object body through the api helper', () => {
  assert.doesNotMatch(
    appSource,
    /api\('\/api\/memory\/wipe-embeddings'[\s\S]*?body:\s*JSON\.stringify/,
  );
  assert.match(
    appSource,
    /api\('\/api\/memory\/wipe-embeddings'[\s\S]*?body:\s*\{\s*confirm:\s*'YES, WIPE EMBEDDINGS'/,
  );
});

test('Memory pane labels unavailable live provider as unavailable, not uninitialised', () => {
  assert.match(appSource, /\(provider unavailable\)/);
  assert.doesNotMatch(appSource, /\(provider not initialised\)/);
});
