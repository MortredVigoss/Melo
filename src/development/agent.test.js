import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateTools, authorizeDevelopmentProfiles, createDevelopmentAgents } from './agent.js';
import { recommendedCapabilities } from '../domain/agent/capabilities.js';
import { runSubAgent } from '../agents/subAgent.js';
import { currentRequestContext } from '../runtime/requestScope.js';

test('read-only reviewer has no command/write tool even when its normal profile permits them', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'melo-dev-agent-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'source.txt'), 'original');
  let commands = 0, requests = 0;
  const agents = createDevelopmentAgents({ run: options => runSubAgent({ ...options, replyFn: async () => {
    requests++;
    assert.equal(currentRequestContext().capabilityScope.capabilities.writeFiles, false);
    assert.equal(currentRequestContext().capabilityScope.capabilities.runCommands, false);
    assert.deepEqual(options.extraTools.map(tool => tool.id), ['candidate_read']);
    return requests === 1 ? '<tool_call>{"name":"candidate_write","arguments":{"path":"source.txt","content":"attacked","expectedHash":"missing"}}</tool_call>' : '{"status":"completed","review":"revise","conclusion":"Write was refused"}';
  } }) });
  const profile = { id: 'reviewer', capabilities: recommendedCapabilities('reviewer') };
  const result = await agents.review({ job: { workspace, headSha: 'abc', goal: 'Inspect', reviewerId: 'reviewer', rules: [], tests: [] }, context: { home: join(workspace, 'home'), env: { ...process.env, MELO_FUNCTION_CALLING: 'legacy' }, reviewer: profile, config: { authMode: 'api-key', apiKey: 'fixture', baseUrl: 'https://example.test', model: 'fixture', toolCalling: 'legacy' } }, execute: async () => { commands++; } });
  assert.equal(result.verdict, 'revise'); assert.equal(commands, 0); assert.equal(await readFile(join(workspace, 'source.txt'), 'utf8'), 'original'); assert.ok(requests >= 2);
});
test('candidate writes require current content hash and reviewer cannot obtain write function', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'melo-dev-tools-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'a.txt'), 'old');
  const tools = candidateTools({ workspace }, async () => {});
  const read = tools.find(tool => tool.id === 'candidate_read'), write = tools.find(tool => tool.id === 'candidate_write');
  const hash = JSON.parse((await read.run({ path: 'a.txt' })).output).hash;
  await write.run({ path: 'a.txt', content: 'new', expectedHash: hash });
  await assert.rejects(write.run({ path: 'a.txt', content: 'lost edit', expectedHash: hash }), /changed/);
  assert.deepEqual(candidateTools({ workspace }, null, { readOnly: true }).map(tool => tool.id), ['candidate_read']);
});
test('legacy or disabled capabilities cannot start an isolated worker', () => {
  const job = { agentId: 'builder', reviewerId: 'reviewer' };
  const profiles = { builder: { id: 'builder', capabilities: recommendedCapabilities('builder') }, reviewer: { id: 'reviewer', capabilities: recommendedCapabilities('reviewer') } };
  assert.ok(authorizeDevelopmentProfiles(profiles, job));
  profiles.builder.capabilities = { ...profiles.builder.capabilities, runCommands: false };
  assert.throws(() => authorizeDevelopmentProfiles(profiles, job), /Implementation/);
  profiles.builder.capabilities = null;
  assert.throws(() => authorizeDevelopmentProfiles(profiles, job), /Implementation/);
});
