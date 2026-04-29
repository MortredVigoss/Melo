// Behavior tests for the first-boot productivity-MCP consent dispatcher.
//
// Codex audit 2026-04-29 ⚪: the modal's two click paths (Skip / Enable
// all) need behavioural coverage, not just markup wiring assertions.
// The pure helper `runProductivityMcpsConsentChoice` accepts an
// injected `apiFn`, so we can record the exact sequence of POSTs
// without any DOM. Each test asserts the dispatched call list verbatim.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductivityMcpsConsentChoice, PRODUCTIVITY_MCP_FLAGS } from './productivityMcpConsent.js';

function makeFakeApi(responses = {}) {
  const calls = [];
  const fn = async (path, init) => {
    calls.push({ path, init });
    return responses[path] ?? { ok: true };
  };
  fn.calls = calls;
  return fn;
}

// ─── ownership ─────────────────────────────────────────────────────────────

test('PRODUCTIVITY_MCP_FLAGS lists exactly the three productivity-MCP flags', () => {
  assert.deepEqual([...PRODUCTIVITY_MCP_FLAGS].sort(), [
    'enableAntvChartMcp',
    'enableMarkdown2PdfMcp',
    'enableMermaidMcp',
  ]);
});

// ─── Skip path ─────────────────────────────────────────────────────────────

test('Skip path — only writes productivityMcpsConsented:true, no preset toggles', async () => {
  // The user dismissed the modal without enabling anything. We
  // must NOT fire any /api/mcp/preset-toggle (those would be
  // unsolicited boots of npm packages — exactly the supply-chain
  // surface the consent gate exists to prevent).
  const apiFn = makeFakeApi();
  const dispatched = await runProductivityMcpsConsentChoice({ enableAll: false, apiFn });

  assert.equal(dispatched.length, 1, 'Skip should fire exactly one POST');
  assert.deepEqual(dispatched, [
    { path: '/api/settings/model', body: { productivityMcpsConsented: true } },
  ]);
  // Same shape on the recorded fake-api call list (defends against
  // a future refactor that returns a different summary shape).
  assert.equal(apiFn.calls.length, 1);
  assert.equal(apiFn.calls[0].path, '/api/settings/model');
  assert.deepEqual(apiFn.calls[0].init.body, { productivityMcpsConsented: true });
});

// ─── Enable all path ───────────────────────────────────────────────────────

test('Enable-all path — toggles all three flags THEN writes consent (in that order)', async () => {
  // Order matters for at least one reason: if a preset-toggle
  // throws (e.g. backend rejects), the consent write must NOT
  // happen — otherwise the user would see "consent saved" UX but
  // no flags actually flipped, and the modal would never show
  // again to retry. The throw-stops-the-loop behaviour falls out
  // of the await sequence here.
  const apiFn = makeFakeApi();
  const dispatched = await runProductivityMcpsConsentChoice({ enableAll: true, apiFn });

  assert.equal(dispatched.length, 4, 'Enable-all should fire 3 toggles + 1 consent = 4 POSTs');
  assert.deepEqual(dispatched.slice(0, 3).map(c => c.body), [
    { flag: 'enableAntvChartMcp', enabled: true },
    { flag: 'enableMarkdown2PdfMcp', enabled: true },
    { flag: 'enableMermaidMcp', enabled: true },
  ]);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(dispatched[i].path, '/api/mcp/preset-toggle');
  }
  assert.deepEqual(dispatched[3], {
    path: '/api/settings/model',
    body: { productivityMcpsConsented: true },
  });
});

test('Enable-all path — preset-toggle order matches PRODUCTIVITY_MCP_FLAGS sequence', async () => {
  // Catches a future refactor that switches to Promise.all() for
  // performance — fine for behaviour, but the wiring assertion
  // is here so any reordering surfaces immediately.
  const apiFn = makeFakeApi();
  await runProductivityMcpsConsentChoice({ enableAll: true, apiFn });
  const observedFlagOrder = apiFn.calls
    .filter(c => c.path === '/api/mcp/preset-toggle')
    .map(c => c.init.body.flag);
  assert.deepEqual(observedFlagOrder, [...PRODUCTIVITY_MCP_FLAGS]);
});

// ─── Failure modes ─────────────────────────────────────────────────────────

test('Enable-all path — a preset-toggle throw bubbles up + consent is NOT written', async () => {
  // Critical correctness: if any flag-flip fails, we must not
  // record consent, otherwise the user thinks the install
  // succeeded but the flags are still off and the modal never
  // returns to retry.
  const apiFn = async (path, init) => {
    if (path === '/api/mcp/preset-toggle' && init.body.flag === 'enableMarkdown2PdfMcp') {
      throw new Error('simulated backend reject');
    }
    return { ok: true };
  };
  await assert.rejects(
    runProductivityMcpsConsentChoice({ enableAll: true, apiFn }),
    /simulated backend reject/,
  );
  // Wrap in a separate fake-api that records calls, replay the
  // throw, confirm /api/settings/model was NEVER called.
  const recorder = makeFakeApi();
  const wrapped = async (path, init) => {
    await recorder(path, init);
    if (path === '/api/mcp/preset-toggle' && init.body.flag === 'enableMarkdown2PdfMcp') {
      throw new Error('simulated backend reject');
    }
  };
  try { await runProductivityMcpsConsentChoice({ enableAll: true, apiFn: wrapped }); }
  catch {}
  const consentCalls = recorder.calls.filter(c => c.path === '/api/settings/model');
  assert.equal(
    consentCalls.length,
    0,
    'consent flag must not commit if a preset-toggle threw — the modal must remain so user can retry',
  );
});

test('Skip path — a consent-write throw bubbles up (so the toast logic in app.js can paint the error)', async () => {
  const apiFn = async () => { throw new Error('disk full'); };
  await assert.rejects(
    runProductivityMcpsConsentChoice({ enableAll: false, apiFn }),
    /disk full/,
  );
});

test('runProductivityMcpsConsentChoice — invalid apiFn rejects with TypeError (defensive)', async () => {
  for (const bad of [null, undefined, 'not-a-fn', 42, {}]) {
    await assert.rejects(
      runProductivityMcpsConsentChoice({ enableAll: false, apiFn: bad }),
      /apiFn must be a function/,
      `apiFn=${typeof bad} should reject early`,
    );
  }
});
