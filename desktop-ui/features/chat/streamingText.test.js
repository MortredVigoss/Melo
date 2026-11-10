import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { streamingDisplayText } from './streamingText.js';
import { AGENT_LOOP_CONTRACT } from '../../../shared/agent/loopContract.js';
import { parseUncertaintyMarker } from '../../../src/retrieval/selfVerification.js';

// Agent audit 2026-11-10: the model ends a reply it is unsure about with
// `[UNCERTAIN: …]` on its own last line. The finished reply never has it, but
// the streaming bubble showed the marker until the final text replaced it.
const answer = '东京塔高 333 米。';

test('the uncertainty marker never reaches the streaming bubble, complete or half written', () => {
  // The contract's own fixture and the server's own extraction agree with what the bubble shows.
  const full = `${answer}\n[UNCERTAIN: 东京塔的确切高度]`;
  assert.equal(parseUncertaintyMarker(full).cleanReply, answer);
  assert.equal(streamingDisplayText(full), answer);
  assert.equal(streamingDisplayText(`${answer}\n[uncertain: the exact height]  `), answer, 'the marker is matched as the contract does, in any case');
  // While it is being written, character by character.
  for (let cut = 1; cut <= '[UNCERTAIN: 东京塔的确切高度'.length; cut++) {
    assert.equal(streamingDisplayText(`${answer}\n${'[UNCERTAIN: 东京塔的确切高度'.slice(0, cut)}`), answer, `after ${cut} characters`);
  }
  // Text that only looks similar stays: a bracket in the answer, a marker in the middle, a closed marker too short to be one.
  assert.equal(streamingDisplayText(`${answer}\n[1] 来源`), `${answer}\n[1] 来源`);
  assert.equal(streamingDisplayText('Answer [UNCERTAIN: middle marker] continues.'), 'Answer [UNCERTAIN: middle marker] continues.');
  assert.equal(streamingDisplayText(`${answer}\n[UNCERTAIN: x]`), `${answer}\n[UNCERTAIN: x]`, 'the server keeps this one too');
  assert.equal(parseUncertaintyMarker(`${answer}\n[UNCERTAIN: x]`).cleanReply, `${answer}\n[UNCERTAIN: x]`);
  assert.equal(AGENT_LOOP_CONTRACT.uncertainty.marker.flags, 'i');
});

test('tool-call blocks and the viz trailer are still removed, whole or partial', () => {
  assert.equal(streamingDisplayText('Looking it up.<tool_call>{"name":"web_search"}</tool_call>'), 'Looking it up.');
  assert.equal(streamingDisplayText('Looking it up.<tool_call>{"name":"web_se'), 'Looking it up.');
  assert.equal(streamingDisplayText('Chart below.<viz-spec>{"type":"bar"}</viz-spec>'), 'Chart below.');
  assert.equal(streamingDisplayText('Chart below.<VIZ-SPEC>{"type":'), 'Chart below.');
  assert.equal(streamingDisplayText(''), ''); assert.equal(streamingDisplayText(undefined), '');
});

test('the first paint and the in-place update of the bubble use the same clean-up', async () => {
  const source = await readFile(new URL('./viewThread.js', import.meta.url), 'utf8');
  assert.equal(source.match(/const displayText = streamingDisplayText\(chatState\.streamingAssistantText\);/g)?.length, 2);
  assert.doesNotMatch(source, /\.replace\(\/<tool_call>/, 'no second copy of the strip passes');
});
