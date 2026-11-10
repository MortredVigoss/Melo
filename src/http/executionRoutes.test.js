import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRunAnswer, runAnswer } from './executionRoutes.js';
import { TOOL_TRACE_PREFIX } from '../services/chat/toolTraceReplay.js';
import { createExecutionScene, applyExecutionEvent, finishExecutionScene } from '../shared/executionScene.js';
import { recoverSceneObservations } from '../services/chat/executionScenes.js';

// A stopped run leaves a `[工具轨迹]` record that lists what it called, URLs
// included. Reopening the run took that record as the run's answer, so every
// URL it listed read "cited by the answer". 099a1c3b fixed the listing; the
// image-selection path still looked the answer up without the rule and saved
// the scene that way (agent audit 2026-11-10). Both use one function now.
const trace = { id: 't', role: 'assistant', kind: 'tool-trace', metadata: { runId: 'run-1' }, content: `${TOOL_TRACE_PREFIX} 本轮已停止\nfetch_url https://example.com/read-but-never-cited` };
const phoneTrace = { id: 'p', role: 'assistant', metadata: { runId: 'run-2' }, content: `${TOOL_TRACE_PREFIX} 本轮失败\nopen_url https://example.org/phone` };
const answer = { id: 'a', role: 'assistant', metadata: { runId: 'run-3' }, content: 'See [the page](https://example.com/cited).' };

test('a tool trace is never a run\'s answer, with or without its kind', () => {
  assert.equal(isRunAnswer(trace), false);
  assert.equal(isRunAnswer(phoneTrace), false, 'a trace synced from the phone has no kind');
  assert.equal(isRunAnswer(answer), true);
  assert.equal(isRunAnswer({ role: 'user', content: 'x', metadata: { runId: 'run-3' } }), false);
  const messages = [{ role: 'user', metadata: { runId: 'run-1' }, content: 'q' }, trace, phoneTrace, answer, { ...answer, id: 'a2', content: 'Second reply of the same run.' }];
  assert.equal(runAnswer(messages, 'run-1'), undefined, 'a stopped run has no answer');
  assert.equal(runAnswer(messages, 'run-2'), undefined);
  assert.equal(runAnswer(messages, 'run-3').id, 'a2', 'the last reply of the run');
  assert.equal(runAnswer(undefined, 'run-1'), undefined);
});

test('a stopped run re-read without an answer keeps its sources uncited; with the trace as answer they all read cited', () => {
  const scene = createExecutionScene({ runId: 'run-1', requestId: 'q', chatId: 'c' });
  applyExecutionEvent(scene, { kind: 'operation', id: '0:a', name: 'fetch_url', module: 'search', status: 'completed', sources: [{ url: 'https://example.com/read-but-never-cited', accessed: true, reading: 'partial' }] });
  finishExecutionScene(scene, { status: 'cancelled' });
  const correct = recoverSceneObservations(scene, { message: runAnswer([trace], 'run-1') });
  assert.deepEqual(correct.sources.map(source => source.cited), [false]);
  // What the image-selection path used to pass: the first assistant message of the run.
  const wrong = recoverSceneObservations(scene, { message: [trace].find(m => m.role === 'assistant' && m.metadata?.runId === 'run-1') });
  assert.deepEqual(wrong.sources.map(source => source.cited), [true], 'the defect this rule prevents');
});

test('both scene routes look the answer up through the same rule', async () => {
  const source = await readFile(new URL('./executionRoutes.js', import.meta.url), 'utf8');
  assert.equal(source.match(/message: runAnswer\(messages, body\.runId\)/g)?.length, 1, 'image selection');
  assert.equal(source.match(/if \(isRunAnswer\(message\)\) assistants\.set\(runId, message\)/g)?.length, 1, 'scene listing');
  assert.doesNotMatch(source, /messages\.find\(m => m\.role === 'assistant'/);
});
