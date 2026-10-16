/**
 * Tests for skillExecutor (Phase 2B):
 *   - runSkill rejects non-executable / missing / bad-config inputs
 *   - skill's systemPrompt shows up verbatim in the rendered system prompt
 *   - toolWhitelist intersects with caller's allowedToolIds (most restrictive)
 *   - agent tool is always forbidden inside skill (prevents recursion)
 *   - maxIterations is clamped and respected
 *   - buildSkillTool produces a registrable tool with id "skill:<id>"
 *   - skill-tool dispatch forwards args + context.allowedToolIds
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {buildSkillTool} from './skillExecutor.js';
import {runSkill} from '../testSupport/directAgentFixture.js';
import { registerTool, unregisterTool } from '../tools/registry.js';

function makeFakeReply() {
  const queue = [];
  const callLog = [];
  const fn = async (args) => {
    callLog.push(args);
    if (!queue.length) return '';
    const next = queue.shift();
    return typeof next === 'function' ? await next(args) : next;
  };
  fn.queue = queue;
  fn.callLog = callLog;
  return fn;
}

function makeRecordingTool(id) {
  const calls = [];
  const tool = {
    id,
    name: id,
    description: `recording ${id}`,
    category: 'test',
    isConcurrencySafe: false,
    requiresPermission: false,
    parametersSchema: { type: 'object', properties: {} },
    run: async (args, context) => {
      calls.push({ args, context });
      return { ok: true, output: `ran ${id}`, meta: {} };
    },
  };
  return { tool, calls };
}

function validConfig() {
  return {
    authMode: 'api-key',
    apiKey: 'sk-test',
    baseUrl: 'https://example.test',
    model: 'test-model',
  };
}

function executableSkill(patch = {}) {
  return {
    id: 'summariser',
    name: 'summariser',
    description: 'Summarise a block of text.',
    systemPrompt: 'You are SUMMARISER. Keep answers to three sentences max.',
    type: 'executable',
    parametersSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'text to summarise' },
      },
      required: ['text'],
    },
    toolWhitelist: null,
    allowedAgentIds: null,
    maxIterations: 4,
    ...patch,
  };
}

// ─── Guards ──────────────────────────────────────────────────────────────────

test('runSkill: missing skill returns MISSING_SKILL', async () => {
  const res = await runSkill({});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'MISSING_SKILL');
});

test('runSkill: non-executable skill returns SKILL_NOT_EXECUTABLE', async () => {
  const res = await runSkill({
    skill: { id: 'p', name: 'p', type: 'prompt', systemPrompt: 'x' },
    config: validConfig(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'SKILL_NOT_EXECUTABLE');
});

test('runSkill: missing config returns MISSING_CONFIG', async () => {
  const res = await runSkill({ skill: executableSkill() });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'MISSING_CONFIG');
});

// ─── System prompt shape ─────────────────────────────────────────────────────

test('runSkill embeds the skill systemPrompt verbatim in the rendered prompt', async () => {
  const reply = makeFakeReply();
  reply.queue.push('Done in three sentences.');
  const res = await runSkill({
    skill: executableSkill(),
    config: validConfig(),
    args: { text: 'hello world' },
    replyFn: reply,
  });
  assert.equal(res.ok, true);
  const sp = reply.callLog[0].systemPrompt;
  assert.match(sp, /SUMMARISER/);
  assert.match(sp, /three sentences/);
  assert.match(sp, /Final output hard constraints/);
});

test('runSkill renders args into the first user turn', async () => {
  const reply = makeFakeReply();
  reply.queue.push('ok');
  await runSkill({
    skill: executableSkill(),
    config: validConfig(),
    args: { text: 'TO_SUMMARISE_MARKER' },
    task: 'Please summarise succinctly',
    replyFn: reply,
  });
  const first = reply.callLog[0].messages[0];
  assert.equal(first.role, 'user');
  assert.match(first.content, /Please summarise succinctly/);
  assert.match(first.content, /TO_SUMMARISE_MARKER/);
});

// ─── Whitelist intersection ──────────────────────────────────────────────────

test('runSkill: skill.toolWhitelist narrows the tool set', async () => {
  const { tool: a, calls: aCalls } = makeRecordingTool('tool_a');
  const { tool: b, calls: bCalls } = makeRecordingTool('tool_b');
  registerTool(a);
  registerTool(b);
  try {
    const reply = makeFakeReply();
    // Round 1: model emits both. Only tool_a is on the skill's whitelist.
    reply.queue.push(
      [
        '<tool_call>{"id":"1","name":"tool_a","arguments":{}}</tool_call>',
        '<tool_call>{"id":"2","name":"tool_b","arguments":{}}</tool_call>',
      ].join('\n'),
    );
    reply.queue.push('done');

    const res = await runSkill({
      skill: executableSkill({ toolWhitelist: ['tool_a'] }),
      config: validConfig(),
      args: { text: 'x' },
      replyFn: reply,
    });
    assert.equal(res.ok, true);
    assert.equal(aCalls.length, 1);
    assert.equal(bCalls.length, 0);

    const second = reply.callLog[1];
    const toolResult = second.messages[second.messages.length - 1].content;
    assert.match(toolResult, /TOOL_NOT_WHITELISTED/);
  } finally {
    unregisterTool('tool_a');
    unregisterTool('tool_b');
  }
});

test('runSkill: caller allowedToolIds further narrows skill whitelist', async () => {
  const { tool: a, calls: aCalls } = makeRecordingTool('tool_a');
  const { tool: c, calls: cCalls } = makeRecordingTool('tool_c');
  registerTool(a);
  registerTool(c);
  try {
    const reply = makeFakeReply();
    reply.queue.push(
      [
        '<tool_call>{"id":"1","name":"tool_a","arguments":{}}</tool_call>',
        '<tool_call>{"id":"2","name":"tool_c","arguments":{}}</tool_call>',
      ].join('\n'),
    );
    reply.queue.push('done');

    // Skill whitelist has both; caller only permits tool_a. Intersection = [tool_a].
    const res = await runSkill({
      skill: executableSkill({ toolWhitelist: ['tool_a', 'tool_c'] }),
      allowedToolIds: ['tool_a'],
      config: validConfig(),
      args: { text: 'x' },
      replyFn: reply,
    });
    assert.equal(res.ok, true);
    assert.equal(aCalls.length, 1);
    assert.equal(cCalls.length, 0);
  } finally {
    unregisterTool('tool_a');
    unregisterTool('tool_c');
  }
});

test('runSkill: forbids the `agent` tool even if explicitly whitelisted', async () => {
  const reply = makeFakeReply();
  reply.queue.push('ok');
  await runSkill({
    skill: executableSkill({ toolWhitelist: ['agent'] }),
    config: validConfig(),
    args: { text: 'x' },
    replyFn: reply,
  });
  // The rendered tools section should NOT include the agent tool.
  const sp = reply.callLog[0].systemPrompt;
  assert.ok(!/### agent\b/i.test(sp), 'agent tool must be stripped out of skill prompt');
});

// ─── Iteration cap ───────────────────────────────────────────────────────────

test('runSkill: reaching maxIterations reports incomplete work without raw tool calls', async () => {
  const { tool: a } = makeRecordingTool('tool_a');
  registerTool(a);
  try {
    const reply = makeFakeReply();
    // Always emit a tool call so the loop hits the budget.
    const makeCall = () =>
      '<tool_call>{"id":"loop","name":"tool_a","arguments":{}}</tool_call>';
    for (let i = 0; i < 10; i++) reply.queue.push(makeCall());

    const res = await runSkill({
      skill: executableSkill({ toolWhitelist: ['tool_a'], maxIterations: 2 }),
      config: validConfig(),
      args: { text: 'x' },
      replyFn: reply,
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'SKILL_ITERATION_LIMIT');
    assert.equal(res.meta.iterations, 2);
    // 2 iterations → 2 model calls.
    assert.equal(reply.callLog.length, 2);
    // The final output is scrubbed (no raw <tool_call>).
    assert.ok(!res.output.includes('<tool_call>'));
  } finally {
    unregisterTool('tool_a');
  }
});

// ─── buildSkillTool ──────────────────────────────────────────────────────────

test('buildSkillTool: returns null for non-executable skills', () => {
  assert.equal(buildSkillTool(null), null);
  assert.equal(buildSkillTool({ id: 'x', type: 'prompt' }), null);
});

test('buildSkillTool: produces a tool with id "skill:<id>" and the skill\'s parametersSchema', () => {
  const tool = buildSkillTool(executableSkill());
  assert.ok(tool);
  assert.equal(tool.id, 'skill:summariser');
  assert.equal(tool.category, 'skill');
  assert.equal(tool.isConcurrencySafe, false);
  assert.equal(tool.parametersSchema.type, 'object');
  assert.deepEqual(tool.parametersSchema.required, ['text']);
});

test('runSkill: forwards skill whitelist as nested allowedToolIds into tool context', async () => {
  const { tool: a, calls } = makeRecordingTool('probe');
  registerTool(a);
  try {
    const reply = makeFakeReply();
    reply.queue.push('<tool_call>{"id":"1","name":"probe","arguments":{}}</tool_call>');
    reply.queue.push('done');

    await runSkill({
      skill: executableSkill({ toolWhitelist: ['probe'] }),
      allowedToolIds: ['probe', 'other'],
      config: validConfig(),
      args: { text: 'x' },
      replyFn: reply,
    });
    assert.equal(calls.length, 1);
    const ctx = calls[0].context;
    // Executor must pass down the skill's effective tool list (after
    // intersection with caller's allowlist).
    assert.deepEqual(ctx.allowedToolIds, ['probe']);
    // Skills always live at agentDepth >= 1 so nested `agent` tool calls
    // observe the recursion guard.
    assert.ok(ctx.agentDepth >= 1);
  } finally {
    unregisterTool('probe');
  }
});

test('an explicitly empty caller whitelist executes no registered tool', async () => {
  const {tool,calls}=makeRecordingTool('empty_list_probe');registerTool(tool);
  try {
    const reply=makeFakeReply();reply.queue.push('<tool_call>{"name":"empty_list_probe","arguments":{}}</tool_call>','finished');
    await runSkill({skill:executableSkill(),config:validConfig(),allowedToolIds:[],replyFn:reply});
    assert.equal(calls.length,0);assert.match(reply.callLog[1].messages.at(-1).content,/TOOL_NOT_WHITELISTED|not in.*whitelist/);
  } finally {unregisterTool(tool.id);}
});

test('skill captures the request connection once across tool-loop awaits',async()=>{
 const {runWithRequestContext}=await import('../runtime/requestScope.js');const {createRequestContext}=await import('../runtime/requestContext.js');const before=process.env.MELO_MODEL;
 const {tool}=makeRecordingTool('env_probe');registerTool(tool);let count=0;
 try {
  await runWithRequestContext(createRequestContext({env:{MELO_MODEL:'bound-model',MELO_API_KEY:'bound-key'}}),()=>runSkill({skill:executableSkill(),config:validConfig(),allowedToolIds:['env_probe'],replyFn:async options=>{
   assert.equal(options.model,'bound-model');assert.equal(options.apiKey,'bound-key');process.env.MELO_MODEL='mutated';
   return count++===0?'<tool_call>{"id":"probe","name":"env_probe","arguments":{}}</tool_call>':'done';
  }}));assert.equal(count,2);
 }finally{unregisterTool(tool.id);if(before===undefined)delete process.env.MELO_MODEL;else process.env.MELO_MODEL=before;}
});
