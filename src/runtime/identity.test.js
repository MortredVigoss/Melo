import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntimePaths } from './paths.js';
import { publishRuntime, releaseRuntime, probeDesktopRuntime, readDesktopDiagnostics } from './identity.js';

test('doctor reads the matching desktop effective config, not unrelated local or replacement-process data', async () => {
  const paths = { home: '/isolated-home' };
  const desktop = { status: 'running', runtime: { home: paths.home, instanceId: 'current', port: 43129 } };
  const report = { paths, desktop, config: { model: 'desktop-env-override' } };
  assert.equal((await readDesktopDiagnostics(paths, desktop, { fetchImpl: async () => Response.json(report) })).config.model, 'desktop-env-override');
  assert.equal(await readDesktopDiagnostics(paths, desktop, { fetchImpl: async () => Response.json({ ...report, paths: { home: '/other-home' } }) }), null);
  assert.equal(await readDesktopDiagnostics(paths, desktop, { fetchImpl: async () => Response.json({ ...report, desktop: { runtime: { instanceId: 'replacement' } } }) }), null);
  assert.equal(await readDesktopDiagnostics(paths, { ...desktop, runtime: { ...desktop.runtime, port: '43129@other-host' } }, { fetchImpl: () => assert.fail('must not fetch malformed port') }), null);
});

test('doctor rejects a foreign listener and old shutdown cannot erase a new runtime record', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-runtime-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = resolveRuntimePaths({ env: { MELO_HOME: home } });
  const first = { ...paths, instanceId: 'first', port: 43210 };
  const second = { ...first, instanceId: 'second' };
  await publishRuntime(first);
  const mismatched = await probeDesktopRuntime(paths, { fetchImpl: async () => Response.json({ ok: true, runtime: second }) });
  assert.equal(mismatched.status, 'mismatch');
  const matched = await probeDesktopRuntime(paths, { fetchImpl: async () => Response.json({ ok: true, runtime: first }) });
  assert.equal(matched.status, 'running');
  await publishRuntime(second);
  await releaseRuntime(first);
  assert.equal(JSON.parse(await readFile(paths.runtimePath, 'utf8')).instanceId, 'second');
  await releaseRuntime(second);
  assert.equal((await probeDesktopRuntime(paths)).status, 'not-running');
});
