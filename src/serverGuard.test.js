/**
 * src/serverGuard.test.js
 *
 * Regression tests for the 2026-05-11 server-guard cross-repo bug.
 *
 * The bug: user reported Melo Desktop refused to launch because their
 * other Electron app (aihelper/desktop-pet) had spawned a `node
 * src/server.js` from a DIFFERENT repo, which the old guard regex
 * (`/src\/server\.js/`) matched and classified as a duplicate Melo
 * instance.  Fix (6d925a4): match by THIS server.js's absolute path.
 *
 * These tests pin every branch of `_matchOtherServerLine` so a future
 * "loosen the regex back to substring" refactor breaks the suite
 * loudly instead of silently re-blocking launches.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { _matchOtherServerLine } from './serverGuard.js';

const MELO_PATH = '/Users/mortred/Desktop/melo/Melo Desktop Project/src/server.js';
const AIHELPER_PATH = '/Users/mortred/Desktop/aihelper/desktop-pet/src/server.js';
const SELF_PID = 99999;

// ─── happy path: another instance of THIS server.js ──────────────────────────

test('matches absolute path of THIS server.js (Swift launcher form)', () => {
  const line = `38832 node ${MELO_PATH} --host 127.0.0.1 --port 43128`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.deepEqual(hit, {
    pid: 38832,
    command: `node ${MELO_PATH} --host 127.0.0.1 --port 43128`,
  });
});

test('matches when extra leading whitespace + tabs surround pid (ps output variants)', () => {
  const line = `   12345 \tnode ${MELO_PATH}`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.ok(hit);
  assert.equal(hit.pid, 12345);
});

test('matches when the node binary is under nvm (`/Users/.../node/v22.../bin/node`)', () => {
  // Real-world `ps -axo command` output from the user environment.
  const line = `38832 /Users/mortred/.nvm/versions/node/v22.22.2/bin/node ${MELO_PATH} --host 127.0.0.1 --port 43128`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.ok(hit, 'absolute-path node binary form must still match');
  assert.equal(hit.pid, 38832);
});

// ─── the cross-repo bug (regression guard) ───────────────────────────────────

test('does NOT match another repo\'s server.js — even with the same `src/server.js` suffix (the 6d925a4 bug)', () => {
  // The exact user-reported case: aihelper's own server.js, spawned
  // by aihelper's Electron, has command `node src/server.js --port 43127`.
  // The old regex `/src\/server\.js/` matched this and falsely blocked
  // Melo launch.  The new policy MUST NOT match it.
  const aihelperLine = `38832 node src/server.js --host 127.0.0.1 --port 43127`;
  const hit = _matchOtherServerLine(aihelperLine, SELF_PID, MELO_PATH);
  assert.equal(hit, null,
    'aihelper-style relative `node src/server.js` must NOT match Melo\'s guard');
});

test('does NOT match another repo where the absolute path is different but suffix-similar', () => {
  const line = `12345 node ${AIHELPER_PATH} --port 1234`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.equal(hit, null,
    'a different absolute path must not match — even if it ends with src/server.js');
});

// ─── self / malformed / non-node lines ───────────────────────────────────────

test('does NOT match own pid (caller is filtered out)', () => {
  const line = `${SELF_PID} node ${MELO_PATH}`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.equal(hit, null, 'own pid must be skipped');
});

test('does NOT match a non-node process — even if the path is in cmdline', () => {
  // A `tail -f /path/to/melo/src/server.js` would mention the path but
  // is not a server instance.  The `\bnode\b` gate stops this.
  const line = `5555 tail -f ${MELO_PATH}`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.equal(hit, null);
});

test('does NOT match a process whose name CONTAINS "node" as a substring (e.g. nodemon)', () => {
  // `nodemon` is not `node`. The `\bnode\b` word-boundary regex blocks it.
  // Tests defensively: if someone runs nodemon on Melo's server.js, we
  // should still match because `node` appears (nodemon spawns node...).
  // Actually nodemon's child is a `node` process — it would show as
  // `node ${MELO_PATH}` in ps. The nodemon parent shows as `nodemon …`.
  // We want to NOT match the parent (it's the supervisor, not the server),
  // and the child node process matches naturally.
  const line = `4444 nodemon --watch src ${MELO_PATH}`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.equal(hit, null,
    'nodemon supervisor (not the inner node) must not be flagged');
});

test('does NOT match malformed line missing pid prefix', () => {
  const line = `not-a-pid node ${MELO_PATH}`;
  assert.equal(_matchOtherServerLine(line, SELF_PID, MELO_PATH), null);
});

test('does NOT match empty / whitespace-only / null lines', () => {
  assert.equal(_matchOtherServerLine('', SELF_PID, MELO_PATH), null);
  assert.equal(_matchOtherServerLine('   ', SELF_PID, MELO_PATH), null);
  assert.equal(_matchOtherServerLine(null, SELF_PID, MELO_PATH), null);
  assert.equal(_matchOtherServerLine(undefined, SELF_PID, MELO_PATH), null);
});

test('does NOT match pid=0 (init / kernel placeholder)', () => {
  const line = `0 node ${MELO_PATH}`;
  assert.equal(_matchOtherServerLine(line, SELF_PID, MELO_PATH), null);
});

// ─── policy boundary: serverPath substring containment, not regex ────────────

test('does match when extra args follow the server path (Swift launcher)', () => {
  const line = `12345 node ${MELO_PATH} --host 127.0.0.1 --port 43128 --some-flag`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.ok(hit);
  assert.equal(hit.pid, 12345);
});

test('does match when server path is at the END of the cmd line', () => {
  const line = `12345 /usr/local/bin/node ${MELO_PATH}`;
  const hit = _matchOtherServerLine(line, SELF_PID, MELO_PATH);
  assert.ok(hit);
});
