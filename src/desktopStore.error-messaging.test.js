import test from 'node:test';
import assert from 'node:assert/strict';
import { formatProviderFailureMessage } from './desktopStore.js';

test('formatProviderFailureMessage recognizes codex oauth auth failures', () => {
  const message = formatProviderFailureMessage(
    new Error('Codex login has expired. Reconnect Codex OAuth inside Melo and retry.'),
  );

  assert.match(message, /Codex OAuth session needs attention/i);
});

test('formatProviderFailureMessage recognizes stream completion failures', () => {
  const message = formatProviderFailureMessage(
    new Error('Codex OAuth request completed without returning a final reply.'),
  );

  assert.match(message, /never received a final reply/i);
});

test('formatProviderFailureMessage recognizes provider-side 5xx failures', () => {
  const message = formatProviderFailureMessage(
    new Error('Codex OAuth request failed (503 Service Unavailable): upstream connect error'),
  );

  assert.match(message, /backend did not finish this request/i);
});

test('formatProviderFailureMessage explains Codex cyber policy failures', () => {
  const message = formatProviderFailureMessage(
    new Error('This content was flagged for possible cybersecurity risk. code=cyber_policy'),
  );

  assert.match(message, /thread context looked cybersecurity-sensitive/i);
});

test('formatProviderFailureMessage keeps a concise detail summary for unknown failures', () => {
  const message = formatProviderFailureMessage(
    new Error('Codex OAuth request failed (418 I am a teapot): unexpected policy branch'),
  );

  assert.equal(
    message,
    'Melo could not complete the model request right now. Details: unexpected policy branch',
  );
});
