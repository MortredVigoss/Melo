import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 2026-11-10 agent audit, second pass. Each case below runs the real execution graph against a fixture
// model. One parent test owns the fixture home (see src/runtime/testIsolation.test.js).
await test('lead loop fixes through the graph stay inside their fixture home', async t => {
  const home = mkdtempSync(join(tmpdir(), 'melo-loop-fixes-'));
  const oldHome = process.env.MELO_HOME, oldCalling = process.env.MELO_FUNCTION_CALLING;
  process.env.MELO_HOME = home;
  t.after(() => { rmSync(home, { recursive: true, force: true }); if (oldHome === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = oldHome; if (oldCalling === undefined) delete process.env.MELO_FUNCTION_CALLING; else process.env.MELO_FUNCTION_CALLING = oldCalling; });
  const { runChatAgentExecutionGraph } = await import('./chatExecutionRunner.js');
  const { saveState } = await import('../../state/stateStore.js');
  const { bootstrapBuiltinTools, registerTool, unregisterTool } = await import('../../tools/registry.js'); bootstrapBuiltinTools();
  const { beginSupplements, addSupplement, endSupplements } = await import('./supplements.js');
  const checker = request => String(request.systemPrompt).startsWith("You are Melo's task completion checker");
  const selfContained = JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, turnKind: 'answer', reasonType: 'self_contained', reason: 'Answered.', requirements: [{ text: 'explanation', kind: 'response', status: 'met', evidenceIds: [] }] });
  let reads = 0;
  const tool = 'loop_fixture_read';
  registerTool({ id: tool, name: tool, description: 'Read the local fixture catalog', effect: 'read', capability: null, requiresPermission: false, parametersSchema: { type: 'object', properties: { page: { type: 'number' } } }, run: async args => { reads++; return { ok: true, output: `Catalog page ${args?.page ?? 0}: Model A, price 100 AUD, region AU, available now.` }; } });
  t.after(() => unregisterTool(tool));
  async function turn(id, goal, protocol, reply, extra = {}) {
    assert.equal(process.env.MELO_HOME, home, 'this test still runs inside its fixture home');
    process.env.MELO_FUNCTION_CALLING = protocol;
    reads = 0;
    const requests = [], events = [];
    const chat = { id, title: 'fixture', mode: 'chat', projectId: null, agentId: 'main', messages: [...(extra.history || []), { id: 'u-' + id, role: 'user', content: goal }], sessionMemory: [] };
    const state = { projects: [], chats: [chat], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], agentProfiles: { main: { id: 'main', name: 'Fixture', model: 'opaque', tools: ['local-files'], skills: [], channels: {}, evaluationMode: 'quick', collaboration: { canDelegate: false } } }, projectAgentOverrides: {}, settings: { selectedProjectId: null, selectedChatId: chat.id, selectedAgentId: 'main', activeMode: 'chat', promptHistory: [] } };
    await saveState(state);
    beginSupplements(chat.id);
    try {
      const result = await runChatAgentExecutionGraph({ config: { replyLanguage: 'en', authMode: 'unset', apiKey: '', baseUrl: '', model: 'opaque', toolCalling: protocol }, state, chat, workspace: { rootPath: home, exists: true, entries: [], filePaths: [], fileCount: 0, commandTemplates: [], commandRuns: [] }, connectors: [], skills: [], latestUserMessage: goal, agentId: 'main', sseEmitter: (type, event) => events.push({ type, ...event }),
        _dependencies: { turnTimeoutMs: 20 * 60000, getEmbedding: async () => null, createReply: async request => {
          requests.push({ purpose: request.purpose, messages: JSON.stringify(request.messages), first: request.messages?.[0]?.content, system: String(request.systemPrompt || ''), check: checker(request) });
          return reply(request, requests.filter(row => row.purpose === 'loop').length, chat);
        } } });
      return { result, requests, events };
    } finally { endSupplements(chat.id); }
  }
  const text = (name, args, id) => '<tool_call>' + JSON.stringify({ ...(id === undefined ? {} : { id }), name, arguments: args }) + '</tool_call>';
  const native = list => ({ protocol: 'chat-completions', text: '', message: { role: 'assistant', content: '', tool_calls: list.map(([name, args]) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } })) } });
  const say = value => ({ protocol: 'chat-completions', text: value, message: { role: 'assistant', content: value } });
  const verdict = JSON.stringify({ decision: 'partial', evaluationValid: true, needsEvaluation: false, reasonType: 'unavailable', reason: 'fixture', requirements: [{ text: 'catalog', kind: 'external_fact', status: 'unavailable', evidenceIds: [] }] });

  await t.test('a server that sends no call ids keeps working when the turn changes its session', async () => {
    // The second request runs on the session built once routing closed (a supplement arrived). Its first
    // synthesized id used to be call_1 again, and the turn ended on DUPLICATE_CALL_ID.
    const { result, requests } = await turn('ids-native', 'Read the local fixture catalog and tell me the price of Model A.', 'native', (request, step, chat) => {
      if (checker(request)) return JSON.stringify({ decision: 'partial', evaluationValid: true, needsEvaluation: false, reasonType: 'unavailable', reason: 'fixture', requirements: [{ text: 'price', kind: 'external_fact', status: 'unavailable', evidenceIds: [] }] });
      if (step === 1) { addSupplement(chat.id, 'Also say which region it is sold in.'); return native([[tool, { page: 1 }]]); }
      if (step === 2) return native([[tool, { page: 2 }]]);
      return say('Model A costs 100 AUD and is sold in AU.');
    });
    assert.equal(reads, 2, 'both reads ran');
    assert.match(result.normalizedReply.content, /100 AUD/);
    assert.equal(requests.filter(row => row.purpose === 'loop').length, 3);
  });

  await t.test('on the text protocol a repeated or numeric call id written by the model does not end the turn', async () => {
    const { result } = await turn('ids-text', 'Read the local fixture catalog and tell me the price of Model A.', 'legacy', (request, step) => {
      if (checker(request)) return verdict;
      if (step === 1) return text(tool, { page: 1 }, 'call_1');
      if (step === 2) return text(tool, { page: 2 }, 'call_1');
      if (step === 3) return text(tool, { page: 3 }, 7);
      return 'Model A costs 100 AUD.';
    });
    assert.equal(reads, 3, 'every call ran once');
    assert.match(result.normalizedReply.content, /100 AUD/);
  });

  await t.test('after a supplement the ledger can still be revised, so the check it triggers can be satisfied', async () => {
    const quote = 'Catalog page 1: Model A, price 100 AUD, region AU, available now.';
    const items = ['A', 'B', 'C'].map(name => ({ fields: Object.fromEntries(Object.entries({ name: 'Model ' + name, model: 'Model ' + name, price: 100, currency: 'AUD', region: 'AU', availability: 'available' }).map(([key, value]) => [key, { value, evidence: [{ id: 'catalog-read', quote }] }])), match: 35, diversity: 8, reason: 'In the catalog.', conflicts: [], tags: [] }));
    const contract = JSON.stringify({ category: 'products' });
    const { result, requests } = await turn('ledger-supplement', 'Find products from the local catalog with verified prices and availability.', 'legacy', (request, step, chat) => {
      if (checker(request)) return JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, reason: 'Checked.', requirements: [{ text: 'products', kind: 'external_fact', status: 'met', evidenceIds: ['catalog-read'] }] });
      if (step === 1) return text('task_progress', { action: 'contract', data: contract }, 'contract-1');
      if (step === 2) { addSupplement(chat.id, 'Prices must be in AUD.'); return text(tool, { page: 1 }, 'catalog-read'); }
      if (step === 3) return text('task_progress', { action: 'contract', data: contract }, 'contract-2');
      if (step === 4) return text('task_progress', { action: 'batch', data: JSON.stringify({ items, gaps: [] }) }, 'batch-1');
      return 'Found Model A, Model B and Model C at 100 AUD each, all available.';
    });
    const sent = requests.filter(row => row.purpose === 'loop').map(row => row.messages).join('\n');
    assert.doesNotMatch(sent, /task_progress must be called alone by the lead with routing available|task_progress is not available/, 'the revised ledger calls were answered');
    assert.equal(result.normalizedReply.completion.task.evaluation.stale, false, 'the ledger was revised for the amended goal');
    assert.equal(result.normalizedReply.completion.outcome, 'completed');
  });

  await t.test('an answer that is written when the allowance ends is delivered, not rewritten', async () => {
    const answer = 'The sky is blue because air scatters short blue wavelengths of sunlight more than long red ones.';
    const { result, requests } = await turn('limit-pending', 'Explain in one sentence why the sky is blue.', 'legacy', request => {
      if (request.purpose === 'limit-check') return selfContained;
      if (request.purpose === 'limit-delivery') return 'Confirmed results: none.\n\nMissing: everything.\n\nNext steps: ask again.';
      // The provider reports a usage that leaves nothing for further work, only the delivery reserve.
      request.onProviderResponse?.({ usage: { input_tokens: 380000 } });
      return answer;
    });
    assert.deepEqual(requests.map(row => row.purpose), ['loop', 'limit-check'], 'no request asked the model to write the answer again');
    assert.equal(result.normalizedReply.content, answer);
    assert.equal(result.normalizedReply.completion.outcome, 'completed');
    assert.equal(result.normalizedReply.completion.reason, 'LIMIT_DELIVERED');
  });

  await t.test('when its check cannot run either, the written answer is delivered and marked unverified', async () => {
    const answer = 'The sky is blue because air scatters short blue wavelengths of sunlight more than long red ones.';
    const { result, requests } = await turn('limit-unchecked', 'Explain in one sentence why the sky is blue.', 'legacy', request => {
      if (request.purpose === 'limit-check') throw new Error('fixture: the check request failed');
      request.onProviderResponse?.({ usage: { input_tokens: 380000 } });
      return answer;
    });
    assert.deepEqual(requests.map(row => row.purpose), ['loop', 'limit-check']);
    assert.equal(result.normalizedReply.content.startsWith(answer), true, 'the answer is kept word for word');
    assert.match(result.normalizedReply.content, /delivery check unavailable/i);
    assert.equal(result.normalizedReply.completion.outcome, 'unverified');
    // The marker the answer carries on its last line is internal. With a note appended after it, it was no
    // longer at the end of the reply, where the finalize step looks for it, and stayed visible.
    const marked = await turn('limit-marker', 'Explain in one sentence why the sky is blue.', 'legacy', request => {
      if (request.purpose === 'limit-check') throw new Error('fixture: the check request failed');
      request.onProviderResponse?.({ usage: { input_tokens: 380000 } });
      return answer + '\n[UNCERTAIN: air scatters blue light more than red]';
    });
    assert.equal(marked.result.normalizedReply.content.startsWith(answer), true);
    assert.doesNotMatch(marked.result.normalizedReply.content, /UNCERTAIN/);
    assert.match(marked.result.normalizedReply.content, /delivery check unavailable/i);
  });

  await t.test('a supplement that arrives while an answer waits for its check sends the turn back to work', async () => {
    // The stale answer used to be checked against the amended goal; a pass closed the turn and the
    // supplement was recorded as used although no answer had seen it.
    const { result, requests } = await turn('supplement-pending', 'Read the local fixture catalog and tell me the price of Model A.', 'legacy', (request, step, chat) => {
      if (checker(request)) return JSON.stringify({ decision: 'complete', evaluationValid: true, needsEvaluation: false, reason: 'Read.', requirements: [{ text: 'price', kind: 'external_fact', status: 'met', evidenceIds: ['read-1'] }] });
      if (step === 1) return text(tool, { page: 1 }, 'read-1');
      if (step === 2) { addSupplement(chat.id, 'Also name the region.'); return 'STALE: Model A costs 100 AUD.'; }
      return 'Model A costs 100 AUD and is sold in AU.';
    });
    const checks = requests.filter(row => row.check);
    assert.equal(checks.length, 1, 'only the answer written after the supplement is checked');
    assert.doesNotMatch(checks[0].messages, /STALE/);
    assert.match(requests.filter(row => row.purpose === 'loop')[2].messages, /Also name the region/, 'the next work request carries the supplement');
    assert.match(result.normalizedReply.content, /sold in AU/);
  });

  await t.test('the check\'s feedback stays part of the same turn and the check sees the conversation, not tool traffic', async () => {
    const history = [{ id: 'h1', role: 'user', content: 'EARLIER-QUESTION: which models are in the local catalog?' }, { id: 'h2', role: 'assistant', content: 'EARLIER-ANSWER: Model A and Model B.' }];
    let verdicts = 0;
    const { requests } = await turn('feedback-context', 'And what does the first one cost?', 'legacy', (request, step) => {
      if (checker(request)) return ++verdicts === 1
        ? JSON.stringify({ decision: 'continue', evaluationValid: true, needsEvaluation: false, reasonType: 'lookup_missing', reason: 'Not read yet.', nextStep: 'Read page 6.', requirements: [{ text: 'price', kind: 'external_fact', status: 'missing', evidenceIds: [] }] })
        : JSON.stringify({ decision: 'partial', evaluationValid: true, needsEvaluation: false, reasonType: 'unavailable', reason: 'fixture', requirements: [{ text: 'price', kind: 'external_fact', status: 'unavailable', evidenceIds: [] }] });
      if (step <= 5) return text(tool, { page: step }, 'read-' + step);
      if (step === 6) return 'Model A costs 100 AUD.';
      if (step === 7) return text(tool, { page: 6 }, 'read-6');
      return 'Model A costs 100 AUD (page 6).';
    }, { history });
    const loops = requests.filter(row => row.purpose === 'loop'), checks = requests.filter(row => row.check);
    // After five tool rounds the last eight loop messages are calls and results; the check still gets the conversation.
    const context = JSON.parse(JSON.parse(checks[0].messages)[0].content).context.messages.map(row => row.content).join('\n');
    assert.match(context, /EARLIER-QUESTION/); assert.match(context, /EARLIER-ANSWER/); assert.match(context, /And what does the first one cost/);
    assert.doesNotMatch(context, /Catalog page|tool_call|tool_result/, 'no tool traffic is passed off as conversation');
    assert.doesNotMatch(JSON.stringify(JSON.parse(JSON.parse(checks[1].messages)[0].content).context.messages), /The task is not finished/, 'nor the host\'s own feedback');
    // The request after the feedback keeps the turn context where it was: the prefix up to the feedback is unchanged.
    const before = JSON.parse(loops[5].messages), after = JSON.parse(loops[6].messages);
    assert.equal(after.length > before.length, true);
    assert.deepEqual(after.slice(0, before.length), before, 'everything sent before the feedback is byte-for-byte the same');
    assert.match(after.at(-1).content, /The task is not finished/);
  });

  await t.test('a continued assignment is told what its earlier run found', async () => {
    const member = request => /You are the internal/.test(request.system || String(request.systemPrompt || ''));
    const seen = [];
    let lead = 0;
    await turn('resume-member', 'Read my local notes about the fixture catalog and tell me the price of Model A.', 'legacy', (request, step) => {
      if (checker(request)) return JSON.stringify({ decision: 'partial', evaluationValid: true, needsEvaluation: false, reasonType: 'unavailable', reason: 'fixture', requirements: [{ text: 'price', kind: 'external_fact', status: 'unavailable', evidenceIds: [] }] });
      if (member(request)) { seen.push(JSON.stringify(request.messages)); return seen.length === 1 ? 'FIRST-RUN-FINDING: the notes list Model A at 100 AUD; the region is still unknown.' : 'The region is AU.'; }
      lead++;
      if (lead === 1) return text('route_task', { role: 'lookup', task: 'Read the notes and report the price of Model A.' }, 'route-1');
      if (lead === 2) return text('route_task', { role: 'lookup', task: 'Now report the region of Model A.', resume: 'route-1' }, 'route-2');
      return 'Model A costs 100 AUD in AU.';
    });
    assert.equal(seen.length, 2, 'both member runs started');
    assert.doesNotMatch(seen[0], /Your earlier run on this assignment/);
    assert.match(seen[1], /Your earlier run on this assignment ended with this handoff/);
    assert.match(seen[1], /FIRST-RUN-FINDING/, 'the continuation sees what the first run reported');
  });

  await t.test('assignments that are refused again and again close routing instead of spending the allowance', async () => {
    const invalid = text('route_task', { role: 'no-such-role', task: 'Look it up.' });
    const { result, requests } = await turn('refused-routes', 'Read my local notes about the fixture catalog and tell me the price of Model A.', 'legacy', request => {
      if (checker(request)) return JSON.stringify({ decision: 'partial', evaluationValid: true, needsEvaluation: false, reasonType: 'unavailable', reason: 'fixture', requirements: [{ text: 'price', kind: 'external_fact', status: 'unavailable', evidenceIds: [] }] });
      return /Internal assignments are closed for this turn/.test(JSON.stringify(request.messages)) ? 'I could not assign this; the notes were not read.' : invalid;
    });
    const loops = requests.filter(row => row.purpose === 'loop');
    assert.equal(loops.length <= 5, true, `the refusals are bounded: ${loops.length} requests`);
    assert.match(result.normalizedReply.content, /could not assign/);
  });

  await t.test('what a member\'s tools did is kept with the saved reply', async () => {
    const member = request => /You are the internal/.test(String(request.systemPrompt || ''));
    let lead = 0, memberStep = 0;
    const { result } = await turn('member-record', 'Read my local notes about the fixture catalog and tell me the price of Model A.', 'legacy', request => {
      if (checker(request)) return JSON.stringify({ decision: 'partial', evaluationValid: true, needsEvaluation: false, reasonType: 'unavailable', reason: 'fixture', requirements: [{ text: 'price', kind: 'external_fact', status: 'unavailable', evidenceIds: [] }] });
      if (member(request)) return ++memberStep === 1 ? text('file_read', { path: 'notes.txt' }, 'member-read') : 'The notes could not be read.';
      return ++lead === 1 ? text('route_task', { role: 'lookup', task: 'Read notes.txt and report the price of Model A.' }, 'route-1') : 'The notes could not be read.';
    });
    const kept = result.normalizedReply.toolResults || [];
    const row = kept.find(entry => entry.toolCallId === 'job-1:member-read');
    assert.ok(row, 'the member\'s call is in the saved record: ' + JSON.stringify(kept.map(entry => entry.toolCallId)));
    assert.equal(row.toolName, 'file_read');
  });

  await t.test('an answer the check sent back is not published as the fallback when the allowance then ends', async () => {
    const rejected = 'REJECTED-DRAFT: Model A costs 999 AUD.';
    const { result, requests } = await turn('limit-rejected', 'Read the local fixture catalog and tell me the price of Model A.', 'legacy', (request, step) => {
      if (request.purpose === 'goal-check') return JSON.stringify({ decision: 'continue', evaluationValid: true, needsEvaluation: false, reasonType: 'lookup_missing', reason: 'The price was not read.', nextStep: 'Read the catalog.', requirements: [{ text: 'price', kind: 'external_fact', status: 'missing', evidenceIds: [] }] });
      if (request.purpose === 'limit-delivery') throw new Error('fixture: the delivery request failed');
      if (step === 1) return rejected;
      if (step === 2) return text(tool, { page: 1 }, 'read-1');
      // The allowance for work ends here (the delivery reserve remains): this call is refused and no new answer is ever written.
      request.onProviderResponse?.({ usage: { input_tokens: 340000 } });
      return text(tool, { page: 2 }, 'read-2');
    });
    assert.ok(requests.some(row => row.purpose === 'limit-delivery'), 'without a pending answer the delivery is written from the evidence');
    assert.doesNotMatch(result.normalizedReply.content, /REJECTED-DRAFT/, 'the answer the check rejected is not delivered as if it stood');
    assert.match(result.normalizedReply.content, /Catalog page 1/, 'what was read is still handed over');
  });
});
