import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./run-unit-tests.js', import.meta.url));
const fixtureEnv = { ...process.env };
// Exercise a standalone CLI, rather than inheriting Node's parent test IPC.
delete fixtureEnv.NODE_TEST_CONTEXT;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'melo-unit-scheduling-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'src/nested'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'scripts/test-quarantine.json'), '{}');
  return root;
}

test('serial unit scheduling runs every discovered file in an isolated home', { timeout: 30000 }, async t => {
  const root = await fixture(t);
  const originalHome = join(root, 'user-home');
  await mkdir(originalHome);
  await writeFile(join(originalHome, 'state.json'), 'unchanged');
  for (const name of ['first', 'second']) {
    await writeFile(join(root, `src/nested/${name}.test.js`), `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      import { open, unlink, appendFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      test('${name}', async () => {
        assert.notEqual(process.env.MELO_HOME, ${JSON.stringify(originalHome)});
        assert.equal(process.env.MELO_TEST_MODE, '1');
        const lock = await open('exclusive.lock', 'wx');
        try {
          await appendFile('events.jsonl', JSON.stringify({ name: '${name}', home: process.env.MELO_HOME }) + '\\n');
          await writeFile(join(process.env.MELO_HOME, 'state.json'), 'fixture');
          await new Promise(resolve => setTimeout(resolve, 80));
        } finally { await lock.close(); await unlink('exclusive.lock'); }
      });
    `);
  }
  const result = await execute(process.execPath, [script], {
    cwd: root, env: { ...fixtureEnv, MELO_HOME: originalHome, MELO_TEST_CONCURRENCY: '1' }, timeout: 25000,
  });
  assert.match(result.stdout, /# tests 2\b/);
  assert.match(result.stdout, /# pass 2\b/);
  const events = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.name), ['first', 'second']);
  assert.equal(await readFile(join(originalHome, 'state.json'), 'utf8'), 'unchanged');
  for (const { home } of events) await assert.rejects(access(home), { code: 'ENOENT' });
});

test('unit scheduling rejects invalid concurrency before any fixture can run', { timeout: 30000 }, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/marker.test.js'), "import {writeFileSync} from 'node:fs';writeFileSync('ran','unexpected');");
  for (const value of ['0', '-1', '1.5', 'bad', '']) {
    await assert.rejects(execute(process.execPath, [script], {
      cwd: root, env: { ...fixtureEnv, MELO_TEST_CONCURRENCY: value }, timeout: 10000,
    }), error => error.code !== 0 && /MELO_TEST_CONCURRENCY must be a positive integer/.test(error.stderr));
    await assert.rejects(access(join(root, 'ran')), { code: 'ENOENT' });
  }
});

test('serial unit scheduling preserves a real test failure exit code', { timeout: 30000 }, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/failure.test.js'), "import test from 'node:test';test('real failure',()=>{throw Error('fixture assertion must fail');});");
  await assert.rejects(execute(process.execPath, [script], {
    cwd: root, env: { ...fixtureEnv, MELO_TEST_CONCURRENCY: '1' }, timeout: 25000,
  }), error => error.code === 1 && /fixture assertion must fail/.test(error.stdout) && /# fail 1\b/.test(error.stdout));
});
