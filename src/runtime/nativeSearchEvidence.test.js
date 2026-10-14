import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexSseResponse } from '../openai.js';

test('native search evidence requires a completed tool item and is deduplicated', async () => {
  const item = { id: 'search-1', type: 'web_search_call', status: 'completed' };
  const events = [
    { type: 'response.output_item.done', item: { ...item, status: 'in_progress' } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { status: 'completed', output: [item, {
      type: 'message', content: [{ type: 'output_text', text: 'Search reply.' }],
    }] } },
  ];
  const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  let calls = 0;
  const reply = await readCodexSseResponse(new Response(body), { onNativeSearch: () => { calls += 1; } });
  assert.equal(calls, 1);
  assert.equal(reply, 'Search reply.');
});
