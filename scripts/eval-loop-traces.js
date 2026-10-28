#!/usr/bin/env node
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoreTurn } from '../src/runtime/sharedAgentCore.js';
import { withLoopTrace, currentLoopTrace, traceEvent, traceModelCall, readLocalTrace } from '../src/runtime/loopTrace.js';

export async function inspectTrace(directory, labels = null) {
  const trace = await readLocalTrace(directory);
  const tools = trace.events.filter(row => row.type === 'tool.result');
  const models = trace.events.filter(row => row.type === 'model.request.started');
  const metrics = { modelRequests: models.length, toolDispatches: trace.events.filter(row => row.type === 'tool.dispatch.started').length,
    tools: [...new Set(tools.map(row => row.data.name))], effectStates: [...new Set(tools.map(row => row.data.effectState))],
    screenshots: tools.filter(row => row.data.screenshotCaptured === true).length,
    unknownEffects: tools.filter(row => row.data.effectState === 'unknown').length,
    taskOutcome: trace.manifest?.status || 'unknown' };
  const failures = trace.errors.map(row => row.code);
  if (labels) {
    for (const name of labels.requiredTools || []) if (!metrics.tools.includes(name)) failures.push('MISSING_TOOL:' + name);
    for (const name of labels.forbiddenTools || []) if (metrics.tools.includes(name)) failures.push('FORBIDDEN_TOOL:' + name);
    for (const type of labels.requiredEvents || []) if (!trace.events.some(row => row.type === type)) failures.push('MISSING_EVENT:' + type);
    for (const value of labels.requiredEffectStates || []) if (!metrics.effectStates.includes(value)) failures.push('MISSING_EFFECT_STATE:' + value);
    if (labels.minModelRequests != null && metrics.modelRequests < labels.minModelRequests) failures.push('MODEL_CONTINUATION_MISSING');
    if (labels.maxToolDispatches != null && metrics.toolDispatches > labels.maxToolDispatches) failures.push('TOO_MANY_DISPATCHES');
    if (labels.maxScreenshots != null && metrics.screenshots > labels.maxScreenshots) failures.push('TOO_MANY_SCREENSHOTS');
    if (labels.taskOutcome != null && metrics.taskOutcome !== labels.taskOutcome) failures.push('TASK_OUTCOME');
    if (labels.requiredOfferedTools) {
      const snapshots = trace.events.filter(row => row.type === 'capabilities.snapshot' && row.data.toolSchemaCaptured === true && row.data.contentRef && !['goal-check','finalize-verification'].includes(row.data.purpose));
      if (!snapshots.length) failures.push('UNKNOWN_TOOL_CATALOG');
      for (const row of snapshots) {
        const snapshot = JSON.parse(await readFile(join(directory, row.data.contentRef), 'utf8'));
        const definitions = snapshot.tools || [];
        if (!Array.isArray(definitions)) { failures.push('UNKNOWN_TOOL_CATALOG'); continue; }
        const names = definitions.map(tool => tool.function?.name || tool.name || tool.id);
        for (const name of labels.requiredOfferedTools) if (!names.includes(name)) failures.push('MISSING_OFFERED_TOOL:' + name);
      }
    }
  }
  return { version: 1, traceId: trace.manifest?.traceId, complete: trace.complete, labelStatus: labels ? 'explicit' : 'unlabeled',
    passed: labels ? failures.length === 0 : null, failures, metrics, qualityClaim: 'trace-contract-only-not-live-model-quality' };
}
export async function createTraceFixtures(output, datasetPath = fileURLToPath(new URL('../shared/agent/fixtures/trace-cases.json', import.meta.url))) {
  const dataset = JSON.parse(await readFile(datasetPath, 'utf8'));
  if (dataset.version !== 1 || dataset.kind !== 'controlled-trace-fixtures' || !Array.isArray(dataset.cases) || dataset.cases.length > 32) throw Error('Invalid trace fixture dataset');
  const reports = [];
  for (const fixture of dataset.cases) {
    if (!/^[a-z0-9-]{1,80}$/u.test(fixture.id) || !fixture.expected || !Array.isArray(fixture.frames) || fixture.frames.length > 64) throw Error('Unbounded/invalid fixture');
    let directory;
    await withLoopTrace({ home: output, runId: fixture.id, kind: 'fixture', goal: fixture.request, metadata: { simulated: true, qualityClaim: dataset.qualityClaim } }, async () => {
      directory = currentLoopTrace().root.directory;
      const core = createCoreTurn({ runId: fixture.id, allowedTools: fixture.tools, toolDependencies: fixture.dependencies || {}, tools: fixture.tools.map(id => ({ id, effect: 'read' })), limits: { rounds: 40 }, hostToolSchemas: true });
      const history = [{ role: 'user', content: fixture.request }];
      const definitions = fixture.tools.map(name => ({ name, parameters: { type: 'object' } }));
      let round = 0;
      for (const frame of fixture.frames) {
        if (core.status !== 'running') break;
        if (frame.cancel) { core.update('cancel'); break; }
        core.update('request'); if (core.status !== 'running') break;
        const calls = (frame.calls || []).map((call, i) => ({ id: 'call-' + round + '-' + i, name: call.name, arguments: call.arguments }));
        const reply = await traceModelCall({ model: 'controlled-fixture', purpose: 'fixture', messages: history, tools: definitions }, async () => ({ text: frame.text || '', calls, simulated: true }));
        history.push({ role: 'assistant', content: reply.text, toolCalls: calls });
        if (!calls.length) { core.update('complete'); break; }
        core.update('calls', { calls });
        const results = [];
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i], executed = core.permits(call.id);
          let result = frame.calls[i].receipt;
          if (executed) traceEvent('tool.dispatch.started', { callId: call.id, name: call.name, effectState: 'dispatched', simulated: true });
          else result = { ok: false, code: core.rejection(call.id), output: 'Fixture call refused before execution', meta: { executionStarted: false } };
          traceEvent('tool.result', { callId: call.id, name: call.name, ok: result.ok,
            effectState: !executed ? 'not_started' : result.effectState || (result.ok ? 'returned' : 'error_returned'), screenshotCaptured: result.screenshotCaptured === true, simulated: true }, result);
          history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          traceEvent('tool.feedback.appended', { callId: call.id, simulated: true }, history.at(-1));
          results.push({ call, result });
        }
        core.results(results);
        if (frame.cache) traceEvent(frame.cache.type, { ...frame.cache.data, simulated: true });
        round++;
      }
      return { completion: { outcome: core.status === 'cancelled' ? 'cancelled' : core.status === 'blocked' ? 'blocked' : 'unknown', verification: 'not_evaluated', reason: core.reason } };
    });
    await writeFile(join(directory, 'labels.json'), JSON.stringify({ version: 1, fixtureId: fixture.id, source: 'controlled-fixture', expected: fixture.expected }, null, 2));
    const report = await inspectTrace(directory, fixture.expected); reports.push({ id: fixture.id, directory, ...report });
  }
  return reports;
}
async function main(args) {
  if (args[0] === '--write-fixtures' && args[1]) {
    const reports = await createTraceFixtures(resolve(args[1])); console.log(JSON.stringify(reports, null, 2));
    if (reports.some(row => !row.passed)) process.exitCode = 1;
    return;
  }
  if (args[0] !== '--trace-dir' || !args[1]) throw Error('Usage: eval-loop-traces.js --trace-dir DIR [--labels FILE] | --write-fixtures DIR');
  const labels = args[2] === '--labels' && args[3] ? JSON.parse(await readFile(args[3], 'utf8')).expected : null;
  const report = await inspectTrace(resolve(args[1]), labels); console.log(JSON.stringify(report, null, 2));
  if (!report.complete || report.passed === false) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
