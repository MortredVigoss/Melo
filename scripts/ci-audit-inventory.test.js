import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

test('CI rejects baseline inflation and requires available PR/push ancestry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melo-audit-ci-'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const put = async (path, text) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  const commit = () => git(['-c', 'user.name=Audit fixture', '-c', 'user.email=audit@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const inventory = async () => {
    execFileSync(process.execPath, ['scripts/audit-inventory.mjs'], { cwd: root });
    const name = (await readdir(join(root, 'docs/audit'))).find(name => /^inventory-\d{4}-\d{2}-\d{2}\.json$/.test(name) && name !== 'inventory-2026-10-26.json');
    if (name) await put('docs/audit/inventory-2026-10-26.json', await readFile(join(root, 'docs/audit', name)));
  };
  const check = async (eventName, event) => {
    await put('event.json', JSON.stringify(event));
    return spawnSync(process.execPath, ['scripts/ci-audit-inventory.mjs'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: join(root, 'event.json') },
    });
  };
  try {
    for (const file of ['audit-inventory.mjs', 'ci-audit-inventory.mjs']) await put(`scripts/${file}`, await readFile(new URL(file, import.meta.url)));
    await put('src/example.js', 'const model = configured;');
    git(['init', '-q']);
    await inventory();
    git(['add', 'scripts', 'src', 'docs']); commit();
    const base = git(['rev-parse', 'HEAD']);
    assert.equal((await check('push', { before: base })).status, 0);
    await put('src/example.js', "const model = 'gpt-4.1-mini';");
    assert.equal((await check('workflow_dispatch', {})).status, 1, 'current baseline is enforced even on a manual run');
    await inventory(); // Simulate a PR that raises its own baseline.
    // The branch can introduce a newer dated baseline; the target still has
    // its older filename and must be compared independently.
    await put('docs/audit/inventory-2099-12-31.json', await readFile(join(root, 'docs/audit/inventory-2026-10-26.json')));
    git(['add', 'src', 'docs']); commit();
    const result = await check('pull_request', { pull_request: { base: { sha: base } } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /H1 \+1\/-0/);
    assert.equal((await check('push', { before: '0'.repeat(40) })).status, 1);
    assert.equal((await check('push', { before: 'f'.repeat(40) })).status, 1);
    assert.equal((await check('workflow_dispatch', {})).status, 0, 'manual run uses the checked-in baseline');
  } finally { await rm(root, { recursive: true, force: true }); }
});
