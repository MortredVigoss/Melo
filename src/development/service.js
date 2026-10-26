import { mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJobStore, atomicJSON } from './store.js';
import { createGit, repositoryRules } from './git.js';
import { createContainerRunner, commandArguments, digest } from './runner.js';

export const activeStages = new Set(['implementing', 'testing', 'reviewing']);
export const sensitiveChange = path => /(^|\/)(?:[^/]*\.(?:test|spec)\.[^/]+|tests?|__tests__|scripts|\.github|AGENTS\.md|CLAUDE\.md|package(?:-lock)?\.json|safety|development|permissions?)(\/|$)/i.test(path)
  || /^(?:src\/(?:tools\/|http\/|runtime\/|domain\/agent\/capabilit|server\.js|config\.js)|desktop-app\/|native\/)/.test(path);
const fail = message => { throw new Error(message); };
const plan = value => {
  if (!Array.isArray(value) || !value.length || value.length > 16) fail('Choose at least one required verification command');
  return value.map(commandArguments);
};

export function createDevelopmentService({ home, env, implement, review, publish = async () => {}, runnerFactory = createContainerRunner }) {
  // All paths and environment are captured by the host at construction.
  const store = createJobStore(home), git = createGit(env), active = new Map();
  const runnerFor = job => runnerFactory({ env, directory: store.directory(job.id) });
  const save = async job => { await store.save(job); await publish(job); return job; };
  const candidateCurrent = async job => {
    if (!job.headSha || await git.tree(job) !== job.treeSha) fail('Candidate changed; run verification and review again');
    const source = await git.repository(job.repository);
    if (source.baseSha !== job.baseSha || source.branch !== job.branch) fail('Target branch changed; preserve this candidate and create a job on the new baseline');
  };
  async function evidenceCurrent(job) {
    await candidateCurrent(job);
    if (job.policyHash !== digest(JSON.stringify({ image: job.image, commands: job.commands }))) fail('Verification policy changed');
    if (job.tests?.length !== job.commands.length) fail('Required tests are missing');
    for (const [index, receipt] of job.tests.entries()) {
      if (receipt.status !== 'passed' || receipt.exitCode !== 0 || receipt.headSha !== job.headSha || receipt.treeSha !== job.treeSha || JSON.stringify(receipt.argv) !== JSON.stringify(job.commands[index])) fail('Required verification did not pass on this candidate');
      const file = join(store.directory(job.id), 'runs', receipt.id);
      if (digest(await readFile(`${file}.log`).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; })) !== receipt.logHash) fail('Verification log changed');
      if (digest(await readFile(`${file}.json`)) !== receipt.receiptHash) fail('Verification receipt changed');
    }
    if (!job.review || job.review.headSha !== job.headSha || job.review.treeSha !== job.treeSha || job.review.verdict !== 'approve') fail('Read-only review has not approved this candidate');
    if (job.sensitiveFiles?.length && job.manualReview?.headSha !== job.headSha) fail('Changes to tests, policy or execution require desktop review');
  }
  const service = {
    store, git, read: store.read,
    async list() {
      const rows = await store.list();
      for (const [index, job] of rows.entries()) if (activeStages.has(job.status) && !active.has(job.id)) {
        try { rows[index] = await this.recover(job.id); }
        catch (error) { rows[index] = { ...job, recoveryError: error.message }; }
      }
      return rows;
    },
    async create({ repository, goal, agentId, reviewerId, commands, image = 'melo-development:local' }) {
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 12000) fail('A bounded development goal is required');
      if (!agentId || !reviewerId || agentId === reviewerId) fail('Choose a separate implementation and review Agent');
      const tests = plan(commands), source = await git.repository(repository);
      const id = `dev_${randomUUID()}`, directory = store.directory(id);
      const job = { version: 1, id, goal: goal.trim(), repository: source.root, baseSha: source.baseSha, branch: source.branch, agentId, reviewerId,
        workspace: join(directory, 'candidate'), gitDir: join(directory, 'git'), commands: tests, status: 'preparing', initialized: false, revision: 0, tests: [], createdAt: new Date().toISOString() };
      await save(job);
      // Resolve an existing image to its immutable ID. Never silently pull or
      // execute host commands when Docker or the configured image is absent.
      try {
        job.image = await runnerFor(job).image(image);
        job.policyHash = digest(JSON.stringify({ image: job.image, commands: tests }));
        await git.checkout(job);
        job.rules = await repositoryRules(job.workspace);
        job.initialized = true; job.status = 'created';
        return save(job);
      } catch (error) { job.status = 'blocked'; job.error = error.message; await save(job); throw error; }
    },
    async start(id, context) {
      if (active.has(id)) fail('Development job is already active');
      const job = await store.read(id);
      if (!job.initialized) fail('Job preparation did not complete. Fix the runner or image and create a new job.');
      if (activeStages.has(job.status)) fail('Recover the interrupted controller before resuming');
      // Validate identity/capabilities before marking running or invoking any
      // model. The HTTP adapter builds context from local Agent profiles.
      await context.authorize(job);
      const source = await git.repository(job.repository);
      if (source.baseSha !== job.baseSha || source.branch !== job.branch) fail('Target branch changed; create a job on the new baseline');
      const controller = new AbortController();
      const item = { controller, promise: null };
      let announce, rejectStart;
      const started = new Promise((resolve, reject) => { announce = resolve; rejectStart = reject; });
      active.set(id, item);
      item.promise = store.lock(id, async () => {
        try {
          job.tests = []; job.review = null; job.manualReview = null; job.error = null; job.activeRun = null;
          job.status = 'implementing'; await save(job);
          announce({ id, status: 'implementing' });
          const runner = runnerFor(job);
          const execute = async (argv, { workspace = job.workspace, gitDir = job.gitDir, writable = true, timeoutMs = 3600000 } = {}) => runner.run({ image: job.image, workspace, gitDir, argv, writable, timeoutMs, signal: controller.signal,
            onStart: async run => { job.activeRun = run; await save(job); } });
          const outcome = await implement({ job, context, signal: controller.signal, execute });
          job.implementation = outcome;
          if (!outcome?.ok) fail(outcome?.output || 'Implementation did not complete');
          if (controller.signal.aborted) fail('Cancelled');
          Object.assign(job, await git.snapshot(job));
          job.changedFiles = await git.changed(job);
          if (!job.changedFiles.length) fail('No candidate changes were produced');
          job.sensitiveFiles = job.changedFiles.filter(path => sensitiveChange(path) || job.commands.some(argv => argv.includes(path) || argv.includes(`./${path}`)));
          job.status = 'testing'; await save(job);
          const validation = join(store.directory(id), 'validation');
          await rm(validation, { recursive: true, force: true });
          await cp(job.workspace, validation, { recursive: true, dereference: false });
          // Validation may write generated outputs in its own copy, never the
          // candidate. Its Git database stays outside the worker mount too.
          const validationJob = { ...job, workspace: validation, gitDir: join(store.directory(id), 'validation-git') };
          await rm(validationJob.gitDir, { recursive: true, force: true });
          await git.invoke(['init', '--bare', validationJob.gitDir], validation);
          await git.privateGit(validationJob, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--', job.gitDir, job.headSha]);
          await git.privateGit(validationJob, ['read-tree', job.headSha]);
          await git.privateGit(validationJob, ['update-ref', 'refs/heads/candidate', job.headSha]);
          await git.privateGit(validationJob, ['symbolic-ref', 'HEAD', 'refs/heads/candidate']);
          for (const argv of job.commands) {
            const result = await execute(argv, { workspace: validation, gitDir: validationJob.gitDir });
            const receiptPath = join(store.directory(id), 'runs', `${result.id}.json`);
            job.tests.push({ ...result, headSha: job.headSha, treeSha: job.treeSha, receiptHash: digest(await readFile(receiptPath)) });
            job.activeRun = null; await save(job);
            if (result.status !== 'passed') fail('Required verification failed; inspect the command log');
            if (await git.tree(validationJob) !== job.treeSha) fail('Verification modified the source tree; its result is not accepted');
          }
          await candidateCurrent(job);
          job.status = 'reviewing'; await save(job);
          const result = await review({ job, context, signal: controller.signal, diff: await git.diff(job) });
          job.review = { ...result, headSha: job.headSha, treeSha: job.treeSha, reviewedAt: new Date().toISOString() };
          if (result?.verdict !== 'approve') fail('Read-only review requested changes');
          job.status = job.sensitiveFiles.length ? 'awaiting_review' : 'awaiting_merge';
          if (job.status === 'awaiting_merge') await evidenceCurrent(job);
        } catch (error) { rejectStart(error); job.status = controller.signal.aborted ? 'cancelled' : 'blocked'; job.error = error.message; }
        finally { job.activeRun = null; await save(job); }
        return job;
      }).catch(error => { rejectStart(error); throw error; }).finally(() => active.delete(id));
      item.promise.catch(() => {});
      return started;
    },
    async wait(id) { return active.get(id)?.promise || store.read(id); },
    async shutdown() { return Promise.allSettled([...active.keys()].map(id => this.stop(id))); },
    async stop(id) {
      const item = active.get(id);
      if (!item) return this.recover(id);
      item.controller.abort(new Error('Stopped by user'));
      return item.promise;
    },
    async recover(id) {
      if (active.has(id)) fail('Stop the active job first');
      const job = await store.read(id);
      await store.recoverLock(id);
      const runs = await readdir(join(store.directory(id), 'runs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const file of runs.filter(file => file.endsWith('.json'))) {
        const receipt = JSON.parse(await readFile(join(store.directory(id), 'runs', file), 'utf8'));
        if (['starting', 'running', 'cleanup_failed'].includes(receipt.status)) {
          await runnerFor(job).stop(receipt.name);
          receipt.status = 'interrupted'; receipt.finishedAt = new Date().toISOString();
          await atomicJSON(join(store.directory(id), 'runs', file), receipt);
        }
      }
      if (activeStages.has(job.status)) { job.status = 'interrupted'; job.activeRun = null; job.error = 'Controller interrupted; candidate retained. Resume explicitly to revalidate.'; await save(job); }
      return job;
    },
    async approve(id, headSha) {
      return store.lock(id, async () => {
        const job = await store.read(id);
        if (job.status !== 'awaiting_review' || headSha !== job.headSha) fail('Review version changed');
        await evidenceCurrent({ ...job, manualReview: { headSha } });
        job.manualReview = { headSha, reviewedAt: new Date().toISOString() }; job.status = 'awaiting_merge';
        return save(job);
      });
    },
    async details(id) {
      const job = await store.read(id), runs = [];
      for (const file of await readdir(join(store.directory(id), 'runs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (!file.endsWith('.json')) continue;
        const receipt = JSON.parse(await readFile(join(store.directory(id), 'runs', file), 'utf8'));
        const log = await readFile(join(store.directory(id), 'runs', file.replace(/\.json$/, '.log')), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        runs.push({ ...receipt, log: log.slice(-64000), truncated: log.length > 64000 });
      }
      return { job, diff: job.headSha ? await git.diff(job) : '', runs: runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt)) };
    },
    async exportCandidate(id) {
      return store.lock(id, async () => {
        const job = await store.read(id);
        if (job.status !== 'awaiting_merge') fail('Job is not awaiting merge');
        await evidenceCurrent(job);
        const patch = await git.privateGit(job, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', job.baseSha, job.headSha, '--'], { raw: true });
        const bundle = { version: 1, id, goal: job.goal, baseSha: job.baseSha, headSha: job.headSha, treeSha: job.treeSha, image: job.image, policyHash: job.policyHash, tests: job.tests, review: job.review, manualReview: job.manualReview || null, patch, patchHash: digest(patch), mergePerformed: false, nativeValidation: 'not-performed' };
        await atomicJSON(join(store.directory(id), 'candidate-bundle.json'), bundle);
        return bundle;
      });
    },
  };
  return service;
}
