/**
 * 2026-06-04 audit闭环: structural guards for the poller offset-advancement
 * fix (telegram + discord). The bug: lastUpdateId was advanced to the batch
 * max BEFORE the per-message processing loop, so a throw mid-batch still
 * persisted the advanced offset → the next fetch acked/skipped the unprocessed
 * messages → silent data loss.
 *
 * Why source-level (not a behavioral cycle test): processTelegramPollingCycle /
 * the discord equivalent have NO dependency-injection seams — they call the
 * real telegram/discord APIs, sendChatMessage, getResolvedConfig, and
 * updateStateAtomically directly. Driving one cycle in a unit test would
 * require building a mock harness for ~6 deps, a disproportionate refactor of
 * untouched core. These structural assertions instead lock the EXACT bug
 * shape: (1) the offset is NOT advanced before the message loop, and (2) it IS
 * advanced inside a per-message `finally`. A regression that moves the offset
 * back to a pre-loop batch-max assignment fails these. A full behavioral test
 * remains a known follow-up gap (would need poller DI seams first).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tgSource = readFileSync(join(here, 'telegramPolling.js'), 'utf8');
const dcSource = readFileSync(join(here, 'discordPolling.js'), 'utf8');

// ─── Telegram ──────────────────────────────────────────────────────────────

test('telegram: lastUpdateId is NOT advanced to batch-max before the message loop (the bug shape)', () => {
  const loopAt = tgSource.indexOf('for (const update of updates)');
  assert.ok(loopAt > 0, 'message loop must exist');
  const beforeLoop = tgSource.slice(0, loopAt);
  // The bug pattern: a Math.max over all update_ids assigned to lastUpdateId
  // before the loop. It must be gone.
  assert.doesNotMatch(
    beforeLoop,
    /lastUpdateId\s*=\s*Math\.max\([\s\S]*?updates\.map/,
    'offset must NOT be set to max(batch) before the loop — that re-introduces the data-loss bug',
  );
});

test('telegram: offset advances inside a per-message finally (forward progress on every outcome)', () => {
  const loopAt = tgSource.indexOf('for (const update of updates)');
  const afterLoop = tgSource.slice(loopAt);
  // Inside the loop region there must be a finally that advances lastUpdateId
  // from this update's id.
  assert.match(
    afterLoop,
    /finally\s*\{[\s\S]*?lastUpdateId\s*=\s*Math\.max\([\s\S]*?update\?\.update_id/,
    'per-message finally must advance lastUpdateId to this update_id',
  );
  // And a per-message catch that does NOT rethrow (isolation).
  assert.match(
    afterLoop,
    /catch\s*\(perMessageError\)/,
    'each message must be wrapped in its own catch so one failure does not abort the batch',
  );
});

// ─── Discord ─────────────────────────────────────────────────────────────────

test('discord: lastUpdateId is NOT advanced to the highest snowflake before the message loop (the bug shape)', () => {
  const loopAt = dcSource.indexOf('for (const rawMessage of messages)');
  assert.ok(loopAt > 0, 'message loop must exist');
  const beforeLoop = dcSource.slice(0, loopAt);
  // The bug pattern: a snowflake reduce assigned to lastUpdateId before the
  // loop. The reduce-with-snowflakeGt that fed `latestId` must be gone from
  // the pre-loop region.
  assert.doesNotMatch(
    beforeLoop,
    /lastUpdateId\s*=\s*latestId/,
    'offset must NOT be set to the batch-max snowflake before the loop',
  );
});

test('discord: offset advances inside a per-message finally via snowflakeGt', () => {
  const loopAt = dcSource.indexOf('for (const rawMessage of messages)');
  const afterLoop = dcSource.slice(loopAt);
  assert.match(
    afterLoop,
    /finally\s*\{[\s\S]*?snowflakeGt\([\s\S]*?lastUpdateId\s*=\s*thisId/,
    'per-message finally must advance lastUpdateId to this message id (snowflake-gt guarded)',
  );
  assert.match(
    afterLoop,
    /catch\s*\(perMessageError\)/,
    'each message must be wrapped in its own catch (isolation)',
  );
});
