// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage, LANGUAGES } from '../../i18n.js';
setLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { translations } from '../../translations.js';
import { PROVIDER_FAILURES, PROVIDER_FAILURE_DETAILS_PREFIX, isFailedRequest, failureDisplayText } from './providerFailureText.js';
import { PROVIDER_FAILURE_TEXT, formatProviderFailureMessage } from '../../../src/services/chat/providerErrors.js';
import { isProviderFailureContextText } from '../../../src/domain/chat/contextFilters.js';

// Agent audit 2026-11-10: a failed model request was answered in English in
// every language, named OpenAI whatever service the conversation used, and
// looked like an ordinary answer. The stored text stays English (later prompts
// and memory recognise it by that text); the chat shows it in the interface
// language. This list and the server's must stay the same sentences.
const failed = (content, extra = {}) => ({ role: 'assistant', content, metadata: { executionError: 'PROVIDER_ERROR', ...extra } });

test('the chat knows every sentence the server answers a failed request with', () => {
  const { detailsPrefix, ...sentences } = PROVIDER_FAILURE_TEXT;
  assert.deepEqual(Object.fromEntries(Object.entries(PROVIDER_FAILURES).map(([kind, [english]]) => [kind, english])), sentences);
  assert.equal(PROVIDER_FAILURE_DETAILS_PREFIX, detailsPrefix);
  for (const [kind, [english, source]] of Object.entries(PROVIDER_FAILURES)) {
    for (const { id } of LANGUAGES) assert.ok(translations[source]?.[id]?.trim(), `${kind} in ${id}`);
    assert.equal(translations[source].en, english, `${kind}: the English interface shows the stored sentence`);
  }
});

test('no failure sentence names a provider the conversation may not be using', () => {
  for (const [kind, text] of Object.entries(PROVIDER_FAILURE_TEXT)) if (!['policy', 'login'].includes(kind)) assert.doesNotMatch(text, /OpenAI/, kind);
  // What the server really produces for each kind of failure.
  assert.equal(formatProviderFailureMessage(new Error('429 insufficient_quota')), PROVIDER_FAILURE_TEXT.quota);
  assert.equal(formatProviderFailureMessage(new Error('401 Unauthorized: invalid_api_key')), PROVIDER_FAILURE_TEXT.key);
  assert.equal(formatProviderFailureMessage(new Error('model_not_found: claude-x')), PROVIDER_FAILURE_TEXT.model);
  assert.equal(formatProviderFailureMessage(new Error('rate_limit_exceeded')), PROVIDER_FAILURE_TEXT.rate);
  // The unknown-failure texts are still the ones later prompts leave out.
  assert.equal(isProviderFailureContextText(PROVIDER_FAILURE_TEXT.unknown), true);
  assert.equal(isProviderFailureContextText(formatProviderFailureMessage(new Error('Provider request failed (418): teapot'))), true);
});

test('a failed request is shown in the interface language and an ordinary reply is left alone', () => {
  assert.equal(failureDisplayText(failed(formatProviderFailureMessage(new Error('rate_limit_exceeded')))), '模型服务对这次请求限流了。请稍等片刻再试。');
  assert.equal(failureDisplayText(failed(formatProviderFailureMessage(new Error('Codex OAuth request failed (503 Service Unavailable): upstream connect error')))), '模型后端没有完成这次请求。这通常是暂时的或服务方的问题，请稍后重试。');
  assert.equal(failureDisplayText(failed(formatProviderFailureMessage(new Error('Provider request failed (418): unexpected policy branch')))), 'Melo 暂时无法完成这次模型请求。详情：unexpected policy branch');
  // Replies stored before this change named OpenAI; they read the same now.
  assert.equal(failureDisplayText(failed('OpenAI rate-limited this request. Wait a moment and try again.')), '模型服务对这次请求限流了。请稍等片刻再试。');
  // A text that is not one of the fixed sentences is shown as stored.
  assert.equal(failureDisplayText(failed('Something the server never writes.')), null);
  // The same sentence in an ordinary answer (no failure record) is the model's own text.
  const ordinary = { role: 'assistant', content: PROVIDER_FAILURE_TEXT.rate, metadata: {} };
  assert.equal(isFailedRequest(ordinary), false); assert.equal(failureDisplayText(ordinary), null);
  assert.equal(isFailedRequest({ role: 'user', content: 'x', metadata: { executionError: 'X' } }), false);
  try { setLanguage('en'); assert.equal(failureDisplayText(failed(PROVIDER_FAILURE_TEXT.empty)), PROVIDER_FAILURE_TEXT.empty); }
  finally { setLanguage('zh-CN'); }
});

test('the thread marks a failed request and renders its text through the display form', async () => {
  const source = await readFile(new URL('./viewThread.js', import.meta.url), 'utf8');
  assert.match(source, /\$\{isFailedRequest\(message\) \? ui`<span class="chip is-muted message-failed-request">这次请求没有完成<\/span>` : ''\}/);
  assert.match(source, /\$\{renderMessageBlocks\(shownMessage\(message\)\)\}/);
  assert.ok(translations['这次请求没有完成']);
});
