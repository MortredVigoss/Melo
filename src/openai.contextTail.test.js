import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexResponsesInput, contentWithContextTail } from './openai.js';

test('the context tail is joined to the newest user message only when serializing', async () => {
  assert.equal(contentWithContextTail({ role: 'user', content: '问题', contextTail: '[参考]' }), '问题\n\n[参考]');
  assert.deepEqual(contentWithContextTail({ role: 'user', content: [{ type: 'text', text: '看图' }], contextTail: '[参考]' }),
    [{ type: 'text', text: '看图' }, { type: 'text', text: '[参考]' }]);
  assert.equal(contentWithContextTail({ role: 'assistant', content: '回答', contextTail: '[参考]' }), '回答');
  const message = { role: 'user', content: '问题', contextTail: '[参考]' };
  const input = await buildCodexResponsesInput([{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }, message]);
  assert.equal(JSON.stringify(input[0]).includes('[参考]'), false);
  assert.ok(JSON.stringify(input.at(-1)).includes('问题') && JSON.stringify(input.at(-1)).includes('[参考]'));
  assert.equal(message.content, '问题', 'the chat message itself is never modified');
});
