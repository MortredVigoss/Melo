import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDevelopmentService } from './service.js';
import { createGit, containedFile } from './git.js';
import { command } from './process.js';
import { digest, dockerArguments } from './runner.js';
import { atomicJSON } from './store.js';
import { developmentCheckpoint, withDevelopmentCheckpoints } from './checkpoint.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'melo-dev-test-')), repository = join(root, 'repo'), home = join(root, 'home');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(repository);
  const git = createGit(process.env);
  await git.invoke(['init', '-b', 'main'], repository);
  await writeFile(join(repository, 'app.cjs'), 'module.exports = 1;\n');
  await writeFile(join(repository, 'check.cjs'), "require('node:assert/strict').equal(require('./app.cjs'), 2);\n");
  await git.invoke(['add', '.'], repository); await git.invoke(['commit', '-m', 'fixture'], repository);
  let calls = 0;
  const runnerFactory = ({ directory }) => ({
    image: async () => `sha256:${'a'.repeat(64)}`, stop: async () => {},
    async run({ argv, workspace, signal, onStart }) {
      calls++;
      const id = randomUUID(), run = { id, name: `melo-dev-${id}`, argv, startedAt: new Date().toISOString(), status: 'running' };
      await mkdir(join(directory, 'runs'), { recursive: true });
      await onStart?.(run);
      const result = await command(argv[0], argv.slice(1), { cwd: workspace, env: { PATH: process.env.PATH }, signal });
      Object.assign(run, { exitCode: result.code, status: result.code === 0 ? 'passed' : 'failed', logHash: digest(result.output) });
      await writeFile(join(directory, 'runs', `${id}.log`), result.output);
      await atomicJSON(join(directory, 'runs', `${id}.json`), run);
      return run;
    },
  });
  const service = createDevelopmentService({ home, env: { ...process.env }, runnerFactory, implement: async ({ job }) => { await writeFile(join(job.workspace, 'app.cjs'), 'module.exports = 2;\n'); return { ok: true }; }, review: async () => ({ verdict: 'approve', summary: 'Checked source and test receipt' }), ...options });
  const job = await service.create({ repository, goal: 'Return 2', agentId: 'builder', reviewerId: 'reviewer', commands: options.commands || [['node', 'check.cjs']] });
  const start = async () => { await service.start(job.id, { authorize: async () => {} }); return service.wait(job.id); };
  return { root, repository, home, git, service, job, start, calls: () => calls };
}

test('isolated candidates run checks on exact revisions, retain original WIP, and export without merging', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, 'user-wip.txt'), 'keep');
  const result = await f.start(); assert.equal(result.status, 'awaiting_merge', result.error);
  const bundle = await f.service.exportCandidate(f.job.id);
  assert.equal(bundle.mergePerformed, false); assert.equal(bundle.headSha, result.headSha);
  assert.equal(await readFile(join(f.repository, 'app.cjs'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(await readFile(join(f.repository, 'user-wip.txt'), 'utf8'), 'keep');
  assert.equal(await f.git.invoke(['rev-parse', 'HEAD'], f.repository), f.job.baseSha);
  assert.match(bundle.patch, /module.exports = 2/);
  const applied = { ...f.job, workspace: join(f.root, 'apply-check'), gitDir: join(f.root, 'apply-git') };
  await f.git.checkout(applied);
  await f.git.privateGit(applied, ['update-index', '--refresh']);
  const patchPath = join(f.root, 'candidate.patch'); await writeFile(patchPath, bundle.patch);
  await f.git.privateGit(applied, ['apply', '--index', patchPath]);
  assert.equal(await f.git.tree(applied), bundle.treeSha);
});
test('two jobs never share candidate files or Git databases', async t => {
  const f = await fixture(t);
  const other = await f.service.create({ ...f.job, commands: f.job.commands });
  assert.notEqual(other.workspace, f.job.workspace); assert.notEqual(other.gitDir, f.job.gitDir);
  await f.start(); assert.equal(await readFile(join(other.workspace, 'app.cjs'), 'utf8'), 'module.exports = 1;\n');
});
test('red verification cannot call reviewer or export a merge candidate', async t => {
  let reviews = 0;
  const f = await fixture(t, { implement: async ({ job }) => { await writeFile(join(job.workspace, 'app.cjs'), 'module.exports = 3;'); return { ok: true }; }, review: async () => { reviews++; return { verdict: 'approve' }; } });
  const result = await f.start(); assert.equal(result.status, 'blocked'); assert.equal(reviews, 0); assert.equal(f.calls(), 1);
  await assert.rejects(f.service.exportCandidate(f.job.id), /not awaiting merge/);
});
test('editing candidate or advancing target invalidates old test/review receipts', async t => {
  const f = await fixture(t); await f.start();
  await writeFile(join(f.job.workspace, 'app.cjs'), 'module.exports = 99;');
  await assert.rejects(f.service.exportCandidate(f.job.id), /Candidate changed/);
  await writeFile(join(f.job.workspace, 'app.cjs'), 'module.exports = 2;\n');
  await writeFile(join(f.repository, 'advance'), 'next'); await f.git.invoke(['add', '.'], f.repository); await f.git.invoke(['commit', '-m', 'advance'], f.repository);
  await assert.rejects(f.service.exportCandidate(f.job.id), /Target branch changed/);
});
test('forged or edited receipts and logs are rejected', async t => {
  const f = await fixture(t); const result = await f.start();
  const file = join(f.service.store.directory(f.job.id), 'runs', result.tests[0].id);
  await writeFile(`${file}.log`, 'fabricated pass');
  await assert.rejects(f.service.exportCandidate(f.job.id), /log changed/);
  await writeFile(`${file}.log`, ''); await writeFile(`${file}.json`, '{}');
  await assert.rejects(f.service.exportCandidate(f.job.id), /receipt changed/);
});
test('test modifications require desktop confirmation tied to the exact candidate', async t => {
  const f = await fixture(t, { implement: async ({ job }) => { await writeFile(join(job.workspace, 'app.cjs'), 'module.exports = 2;\n'); await writeFile(join(job.workspace, 'app.test.cjs'), '// additional regression'); return { ok: true }; } });
  const result = await f.start(); assert.equal(result.status, 'awaiting_review');
  await assert.rejects(f.service.exportCandidate(f.job.id), /not awaiting merge/);
  await assert.rejects(f.service.approve(f.job.id, 'wrong-version'), /version changed/);
  assert.equal((await f.service.approve(f.job.id, result.headSha)).status, 'awaiting_merge');
  assert.equal((await f.service.exportCandidate(f.job.id)).manualReview.headSha, result.headSha);
});
test('missing authority blocks model, commands and changes before execution', async t => {
  let models = 0;
  const f = await fixture(t, { implement: async () => { models++; return { ok: true }; } });
  await assert.rejects(f.service.start(f.job.id, { authorize: async () => { throw new Error('denied'); } }), /denied/);
  assert.equal(models, 0); assert.equal(f.calls(), 0); assert.equal((await f.service.read(f.job.id)).status, 'created');
});
test('review rejection remains blocked and cancellation retains the candidate', async t => {
  const f = await fixture(t, { review: async () => ({ verdict: 'revise', summary: 'Missing acceptance coverage' }) });
  assert.equal((await f.start()).status, 'blocked');
  await assert.rejects(f.service.exportCandidate(f.job.id), /not awaiting merge/);
});
test('file paths reject escapes and symbolic links including intermediate directories', async t => {
  const f = await fixture(t);
  await symlink(f.repository, join(f.job.workspace, 'outside'));
  for (const path of ['../repo/app.cjs', '/etc/passwd', '.git/config', 'outside/app.cjs']) await assert.rejects(containedFile(f.job.workspace, path, { writing: true }));
});
test('Docker command binds only candidate with no network, capabilities or daemon socket', () => {
  const args = dockerArguments({ name: `melo-dev-${randomUUID()}`, image: `sha256:${'a'.repeat(64)}`, workspace: '/tmp/candidate' });
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.match(args[args.indexOf('--mount') + 1], /^type=volume,source=melo-dev-.*target=\/workspace$/);
  assert.ok(!args.join(' ').includes('/tmp/candidate'));
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('no-new-privileges')); assert.ok(args.includes('ALL'));
  assert.equal(args.filter(arg => arg === '--mount').length, 1); assert.ok(!args.join(' ').includes('docker.sock'));
});
test('mobile checkpoints preserve version and evidence without host paths or mutable approvals', async t => {
  const f = await fixture(t); const result = await f.start();
  const checkpoint = developmentCheckpoint(result);
  assert.equal(checkpoint.id, result.id); assert.match(checkpoint.checkpoint, new RegExp(result.headSha)); assert.equal(checkpoint.status, 'review');
  assert.ok(!JSON.stringify(checkpoint).includes(f.repository));
  assert.deepEqual(withDevelopmentCheckpoints([{ ...checkpoint, revision: 999, status: 'done' }], [checkpoint]), [checkpoint]);
});

test('resume revalidates an edited candidate instead of trapping it behind obsolete evidence', async t => {
  const f = await fixture(t); await f.start();
  await writeFile(join(f.job.workspace, 'app.cjs'), 'module.exports = 9;');
  await assert.rejects(f.service.exportCandidate(f.job.id), /Candidate changed/);
  const resumed = await f.start(); assert.equal(resumed.status, 'awaiting_merge'); assert.equal(f.calls(), 2);
});
test('commands that mutate the tested source cannot produce accepted verification', async t => {
  let reviews = 0;
  const f = await fixture(t, { commands: [['node', '-e', 'require("fs").writeFileSync("app.cjs","module.exports=4;")']], review: async () => { reviews++; return { verdict: 'approve' }; } });
  const result = await f.start(); assert.equal(result.status, 'blocked'); assert.match(result.error, /modified the source/); assert.equal(reviews, 0);
});
test('cancellation stops the job before verification and persists a cancelled state', async t => {
  const f = await fixture(t, { implement: async ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false, output: 'cancelled' }), { once: true })) });
  await f.service.start(f.job.id, { authorize: async () => {} });
  assert.equal((await f.service.stop(f.job.id)).status, 'cancelled'); assert.equal(f.calls(), 0);
});
test('startup recovery stops recorded containers and never replays model work', async t => {
  let models = 0;
  const f = await fixture(t, { implement: async () => { models++; return { ok: true }; } });
  const job = await f.service.read(f.job.id); job.status = 'implementing'; await f.service.store.save(job);
  const directory = f.service.store.directory(job.id);
  await mkdir(join(directory, 'lock')); await atomicJSON(join(directory, 'lock', 'owner.json'), { pid: 2147483647 });
  await mkdir(join(directory, 'runs'));
  await atomicJSON(join(directory, 'runs', 'interrupted.json'), { name: `melo-dev-${randomUUID()}`, status: 'running' });
  const recovered = await f.service.list(); assert.equal(recovered[0].status, 'interrupted'); assert.equal(models, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'runs', 'interrupted.json'))).status, 'interrupted');
});
test('failed runner preparation remains visible without breaking all job listings', async t => {
  const f = await fixture(t);
  const service = createDevelopmentService({ home: f.home, env: { ...process.env }, runnerFactory: () => ({ image: async () => { throw new Error('image absent'); } }) });
  await assert.rejects(service.create({ repository: f.repository, goal: 'Unavailable image', agentId: 'builder', reviewerId: 'reviewer', commands: [['node', 'check.cjs']] }), /image absent/);
  const rows = await service.list(); assert.equal(rows.length, 2); assert.ok(rows.some(row => row.status === 'blocked' && !row.initialized));
});
