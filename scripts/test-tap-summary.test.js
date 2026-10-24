import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTapSummary, isTimeoutClass, isolatedRerunFiles, describeFailures } from './test-tap-summary.js';

const root = '/repo';
const tap = `TAP version 13
# Subtest: ok one
ok 1 - ok one
  ---
  duration_ms: 1.2
  type: 'test'
  ...
# Subtest: timed out by node
not ok 2 - timed out by node
  ---
  duration_ms: 60001
  type: 'test'
  location: '/repo/desktop-ui/slow.browser.test.js:11:1'
  failureType: 'testTimeoutFailure'
  error: 'test timed out after 60000ms'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: server never came up
not ok 3 - server never came up
  ---
  duration_ms: 15340
  type: 'test'
  location: '/repo/desktop-ui/start.browser.test.js:71:1'
  failureType: 'testCodeFailure'
  error: ''
  code: 'ERR_TEST_FAILURE'
  stack: |-
    Timeout.<anonymous> (file:///repo/desktop-ui/start.browser.test.js:29:43)
    listOnTimeout (node:internal/timers:585:17)
  ...
# Subtest: cancelled sibling
not ok 4 - cancelled sibling
  ---
  duration_ms: 0.1
  type: 'test'
  location: '/repo/desktop-ui/start.browser.test.js:90:1'
  failureType: 'cancelledByParent'
  error: 'test did not finish before its parent and was cancelled'
  code: 'ERR_TEST_FAILURE'
  ...
# tests 4
# pass 1
# fail 2
# cancelled 1
# skipped 0
# todo 0
`;

test('TAP summary reads counts, locations and error lines without the passing noise', () => {
  const summary = parseTapSummary(tap);
  assert.deepEqual({ tests: summary.tests, pass: summary.pass, fail: summary.fail, cancelled: summary.cancelled, skipped: summary.skipped }, { tests: 4, pass: 1, fail: 2, cancelled: 1, skipped: 0 });
  assert.deepEqual(summary.failures.map(f => [f.name, f.file, f.line, f.failureType]), [
    ['timed out by node', '/repo/desktop-ui/slow.browser.test.js', 11, 'testTimeoutFailure'],
    ['server never came up', '/repo/desktop-ui/start.browser.test.js', 71, 'testCodeFailure'],
    ['cancelled sibling', '/repo/desktop-ui/start.browser.test.js', 90, 'cancelledByParent'],
  ]);
  assert.equal(summary.failures[1].stack, 'Timeout.<anonymous> (file:///repo/desktop-ui/start.browser.test.js:29:43)');
  assert.deepEqual(describeFailures(summary, root), [
    'timeout [desktop-ui/slow.browser.test.js:11] timed out by node — test timed out after 60000ms',
    'timeout [desktop-ui/start.browser.test.js:71] server never came up',
    'cancelled [desktop-ui/start.browser.test.js:90] cancelled sibling — test did not finish before its parent and was cancelled',
  ]);
});

test('timeout class covers node timeouts, timer rejections and timeout text; cancellations are derived', () => {
  const summary = parseTapSummary(tap);
  assert.deepEqual(summary.failures.map(isTimeoutClass), [true, true, false]);
  assert.equal(isTimeoutClass({ failureType: 'testCodeFailure', error: 'Server startup timed out' }), true);
  assert.equal(isTimeoutClass({ failureType: 'testCodeFailure', error: 'fetch failed: ETIMEDOUT' }), true);
  assert.equal(isTimeoutClass({ failureType: 'testCodeFailure', error: 'Expected values to be strictly deep-equal', stack: 'TestContext.<anonymous> (file:///x.test.js:49:10)' }), false);
});

test('an isolated rerun is offered only when every real failure is timeout class', () => {
  assert.deepEqual(isolatedRerunFiles(parseTapSummary(tap), root), ['desktop-ui/slow.browser.test.js', 'desktop-ui/start.browser.test.js']);
  const real = tap.replace("failureType: 'testTimeoutFailure'\n  error: 'test timed out after 60000ms'", "failureType: 'testCodeFailure'\n  error: 'Expected values to be strictly deep-equal'");
  assert.equal(isolatedRerunFiles(parseTapSummary(real), root), null, 'a deterministic failure next to a timeout is never retried');
  assert.equal(isolatedRerunFiles(parseTapSummary('# tests 3\n# pass 3\n# fail 0\n'), root), null, 'nothing failed, nothing to rerun');
  const fileLevel = parseTapSummary("not ok 4 - desktop-pet/tests/skin-store.test.js\n  ---\n  duration_ms: 107\n  type: 'test'\n  failureType: 'testCodeFailure'\n  exitCode: 1\n  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'\n  ...\n# tests 1\n# pass 0\n# fail 1\n");
  assert.equal(fileLevel.failures[0].file, 'desktop-pet/tests/skin-store.test.js', 'a crashed file is attributed to itself');
  assert.equal(isolatedRerunFiles(fileLevel, root), null, 'a crashed file is a real failure');
});

test('multi-line error blocks keep their first meaningful line', () => {
  const block = "not ok 1 - deep\n  ---\n  location: '/repo/a.test.js:5:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly deep-equal:\n    + actual - expected\n  code: 'ERR_ASSERTION'\n  ...\n# tests 1\n# pass 0\n# fail 1\n";
  const summary = parseTapSummary(block);
  assert.equal(summary.failures[0].error, 'Expected values to be strictly deep-equal:');
  assert.equal(isTimeoutClass(summary.failures[0]), false);
});
