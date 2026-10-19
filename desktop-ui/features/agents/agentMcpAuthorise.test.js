// Behavior tests for the agent → MCP-server authorisation decision
// table. Codex 四轮 audit 2026-04-29 ⚪: the chip-row's add/remove
// rules need a real test, not just visual wiring.
//
// Two precedence corner cases are critical:
//   1. Always-allow REMOVE — even on unpinned/globally-disabled
//      presets. Without this, a stale authorisation could
//      silently re-grant access if the user re-enabled the
//      preset later.
//   2. ADD precedence: unpinned > disabled > allowed. We refuse
//      with a specific reason so the toast text matches the
//      actual gate, not a generic "denied".

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAgentMcpAuthAction } from './agentMcpAuthorise.js';

// ─── REMOVE — always allowed ────────────────────────────────────────────────

test('REMOVE — always allowed even when preset is now globally disabled (stale-revoke path)', () => {
  // The historical 2026-04-28 audit: a re-enable later must NOT
  // silently restore a stale authorisation. So REVOKE wins
  // regardless of the preset's current global state.
  const decision = decideAgentMcpAuthAction({
    currentIds: ['playwright'],
    serverId: 'playwright',
    presetEnabled: false,
    presetUnpinned: false,
  });
  assert.equal(decision.action, 'remove');
  assert.deepEqual(decision.nextIds, []);
  assert.ok(!decision.toast, 'remove path should not show a toast');
});

test('REMOVE — always allowed even when preset is unpinned (Codex 四轮)', () => {
  // Same shape as the disabled case: an unpinned preset's
  // legacy authorisation must still be revocable.
  const decision = decideAgentMcpAuthAction({
    currentIds: ['browserless', 'playwright'],
    serverId: 'browserless',
    presetEnabled: true,    // legacy enableBrowserlessMcp:true config
    presetUnpinned: true,
  });
  assert.equal(decision.action, 'remove');
  assert.deepEqual(decision.nextIds, ['playwright']);
});

// ─── ADD — gated by preset state ────────────────────────────────────────────

test('ADD — refused with unpinned reason when preset is unpinned (priority over disabled)', () => {
  // Both flags set: rule precedence puts unpinned ahead of
  // disabled because the unpinned reason is more specific
  // (toast tells the user what to fix).
  const decision = decideAgentMcpAuthAction({
    currentIds: [],
    serverId: 'browserless',
    presetEnabled: false,
    presetUnpinned: true,
  });
  assert.equal(decision.action, 'refused-unpinned');
  assert.deepEqual(decision.nextIds, []);
  assert.match(decision.toast, /unpinned/);
  assert.match(decision.toast, /PINNED_VERSIONS/);
});

test('ADD — refused with disabled reason when preset is globally off', () => {
  const decision = decideAgentMcpAuthAction({
    currentIds: [],
    serverId: 'mermaid',
    presetEnabled: false,
    presetUnpinned: false,
  });
  assert.equal(decision.action, 'refused-disabled');
  assert.deepEqual(decision.nextIds, []);
  assert.match(decision.toast, /disabled globally/);
  assert.match(decision.toast, /Advanced/);
});

test('ADD — succeeds when preset is enabled and pinned', () => {
  const decision = decideAgentMcpAuthAction({
    currentIds: ['playwright'],
    serverId: 'mermaid',
    presetEnabled: true,
    presetUnpinned: false,
  });
  assert.equal(decision.action, 'add');
  assert.deepEqual(decision.nextIds.sort(), ['mermaid', 'playwright']);
});

// ─── Defensive shape ────────────────────────────────────────────────────────

test('null / non-array currentIds is treated as empty whitelist', () => {
  for (const bad of [null, undefined, 'string', 42, {}]) {
    const decision = decideAgentMcpAuthAction({
      currentIds: bad,
      serverId: 'mermaid',
      presetEnabled: true,
      presetUnpinned: false,
    });
    assert.equal(decision.action, 'add', `currentIds=${typeof bad} → fresh authorisation`);
    assert.deepEqual(decision.nextIds, ['mermaid']);
  }
});

test('empty / non-string serverId returns refused-invalid (defensive)', () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    const decision = decideAgentMcpAuthAction({
      currentIds: ['playwright'],
      serverId: bad,
      presetEnabled: true,
      presetUnpinned: false,
    });
    assert.equal(decision.action, 'refused-invalid');
    // currentIds passes through unchanged.
    assert.deepEqual(decision.nextIds, ['playwright']);
  }
});

test('idempotent toggle — remove + add same id round-trips to original whitelist', () => {
  // Sanity: clicking twice on the same chip ends where it started.
  let ids = ['playwright', 'mermaid'];
  const removed = decideAgentMcpAuthAction({
    currentIds: ids,
    serverId: 'mermaid',
    presetEnabled: true,
    presetUnpinned: false,
  });
  assert.equal(removed.action, 'remove');
  ids = removed.nextIds;
  const added = decideAgentMcpAuthAction({
    currentIds: ids,
    serverId: 'mermaid',
    presetEnabled: true,
    presetUnpinned: false,
  });
  assert.equal(added.action, 'add');
  assert.deepEqual(added.nextIds.sort(), ['mermaid', 'playwright']);
});
