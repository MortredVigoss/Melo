// Explicit, real container acceptance. No synthetic runner and no real user data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createContainerRunner } from '../src/development/runner.js';
import { createGit } from '../src/development/git.js';

const root = await mkdtemp(join(process.env.MELO_DEV_CONTAINER_FIXTURE_ROOT || tmpdir(), 'melo-container-acceptance-'));
const workspace = join(root, 'candidate'), outside = join(root, 'host-only.txt'), repository = join(root, 'repository'), credentialFixture = join(root, 'synthetic-credentials.json');
await mkdir(repository, { mode: 0o700 }); await writeFile(outside, 'host-fixture-only');
await writeFile(credentialFixture, '{"key":"synthetic-fixture-only"}');
const git = createGit(process.env);
await git.invoke(['init', '-b', 'main'], repository);
let networkRequests = 0;
const server = createServer((_, response) => { networkRequests++; response.end('host'); });
server.listen(0, '0.0.0.0'); await once(server, 'listening');
const probe = `const fs=require('fs'), cp=require('child_process'), assert=require('assert/strict');
assert.equal(process.env.MELO_SYNTHETIC_SECRET,undefined);
assert.equal(process.env.HOME,'/tmp/home');
assert.match(cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}),/^[a-f0-9]{40}/);
cp.execFileSync('git',['branch','worker-only']);
for(const p of [${JSON.stringify(outside)},'/var/run/docker.sock',${JSON.stringify(credentialFixture)}])assert.throws(()=>fs.readFileSync(p));
assert.throws(()=>fs.writeFileSync('/host-write','bad'));
fs.writeFileSync('/workspace/source/result.txt','candidate-write');
assert.throws(()=>cp.execFileSync('node',['-e','require("fs").readFileSync('+JSON.stringify(${JSON.stringify(outside)})+')']));
Promise.all(['http://1.1.1.1','http://host.docker.internal:${server.address().port}'].map(url=>fetch(url,{signal:AbortSignal.timeout(1500)}).then(()=>{throw Error('network unexpectedly allowed')},()=>{}))).then(()=>console.log('isolation verified'));`;
await writeFile(join(repository, 'probe.cjs'), probe);
await git.invoke(['add', '.'], repository); await git.invoke(['commit', '-m', 'isolation fixture'], repository);
const baseSha = await git.invoke(['rev-parse', 'HEAD'], repository), gitDir = join(root, 'private-git');
await git.checkout({ repository, workspace, gitDir, baseSha });
const runner = createContainerRunner({ directory: root, env: { ...process.env, MELO_SYNTHETIC_SECRET: 'must-not-cross-boundary' } });
try {
  const image = await runner.image(process.argv.includes('--prepared') ? 'melo-development:local' : 'node:22-bookworm');
  const isolation = await runner.run({ image, workspace, gitDir, argv: ['node', 'probe.cjs'] });
  assert.equal(isolation.status, 'passed', isolation.error || await readFile(join(root, 'runs', `${isolation.id}.log`), 'utf8').catch(() => 'No log'));
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'candidate-write');
  assert.equal(await readFile(outside, 'utf8'), 'host-fixture-only'); assert.equal(networkRequests, 0);
  assert.equal(await git.invoke(['rev-parse', 'HEAD'], repository), baseSha);
  assert.equal(await git.privateGit({ workspace, gitDir }, ['branch', '--list', 'worker-only']), '');
  let dependencies = null;
  if (process.argv.includes('--prepared')) {
    dependencies = await runner.run({ image, workspace, gitDir, argv: ['node', '-e', 'require("node:assert/strict").ok(require("sharp").versions.vips); require("ajv"); require("./build/Release/dirfd_ops.node"); console.log("Linux dependencies and native addon loaded")'] });
    assert.equal(dependencies.status, 'passed', dependencies.error || await readFile(join(root, 'runs', `${dependencies.id}.log`), 'utf8'));
  }
  const rejectedOutput = await runner.run({ image, workspace, gitDir, argv: ['node', '-e', 'const fs=require("fs");fs.writeFileSync("result.txt","untrusted replacement");fs.symlinkSync("/tmp/home","escape");'] });
  assert.equal(rejectedOutput.status, 'failed'); assert.match(rejectedOutput.error, /escaping symbolic link/);
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'candidate-write', 'rejected worker output cannot replace the candidate');
  let longCommand = null;
  if (process.argv.includes('--long')) {
    longCommand = await runner.run({ image, workspace, gitDir, argv: ['node', '-e', 'console.log("long command started"); setTimeout(()=>console.log("long command complete"),610000)'], timeoutMs: 660000 });
    assert.equal(longCommand.status, 'passed');
    // The requirement is >10 minutes on the controller clock. The VM's timer
    // can drift slightly against the host; the 610s guest timer leaves margin.
    assert.ok(Date.parse(longCommand.finishedAt) - Date.parse(longCommand.startedAt) > 600000);
  }
  const controller = new AbortController();
  const cancelled = await runner.run({ image, workspace, gitDir, argv: ['node', '-e', 'setInterval(()=>console.log("running"),100)'], signal: controller.signal, onStart: () => { setTimeout(() => controller.abort(), 1200); } });
  assert.equal(cancelled.status, 'cancelled');
  console.log(JSON.stringify({ fixture: root, isolation, dependencies, rejectedOutput, longCommand, cancelled, hostRequests: networkRequests }, null, 2));
} finally { server.close(); }
