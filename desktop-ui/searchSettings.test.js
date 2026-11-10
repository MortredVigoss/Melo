import test from 'node:test';
import assert from 'node:assert/strict';

test('Search configuration requires explicit save, retains failed drafts, and cancellation restores saved values', async () => {
  const ui = await import('./searchSettings.js?edit-flow');
  const config = { agentRuntime: { search: { backend: 'http', endpoint: 'https://saved.invalid/search' } } };
  const writes = []; let refreshes = 0;
  const callbacks = { render() {}, refresh: async () => { refreshes++; }, api: async (_, request) => { writes.push(request.body); throw new Error('Fixture save failed'); } };
  ui.renderSearchSettings(config);
  await ui.handleSearchSettings('search-settings-edit', callbacks);
  const input = (name, value) => ui.editSearchSettings({ name, value, type: 'text', closest: () => true });
  input('endpoint', 'https://draft.invalid/search'); input('apiKey', 'fixture-ui-key');
  assert.equal(writes.length, 0);
  await ui.handleSearchSettings('search-settings-save', callbacks);
  const failed = ui.renderSearchSettings(config);
  assert.match(failed, /Fixture save failed/); assert.match(failed, /draft.invalid/);
  assert.match(failed, /type="password"/); assert.equal(refreshes, 0);
  await ui.handleSearchSettings('search-settings-cancel', callbacks);
  const cancelled = ui.renderSearchSettings(config);
  assert.match(cancelled, /saved.invalid/); assert.equal(cancelled.includes('fixture-ui-key'), false);
  await ui.handleSearchSettings('search-settings-edit', callbacks);
  input('endpoint', 'https://final.invalid/search');
  await ui.handleSearchSettings('search-settings-save', { ...callbacks, api: async (_, request) => { writes.push(request.body); } });
  assert.equal(writes.at(-1).agentRuntime.search.endpoint, 'https://final.invalid/search');
  assert.equal(writes.at(-1).agentRuntime.search.browserFallback, false); assert.equal(refreshes, 1);
});

// Settings audit 2026-11-10: the two number inputs show a default while nothing
// is saved. Saving the page for another reason used to write those defaults
// back, which changed how searches run (the count a search asks for by default,
// the built-in search's time limit). Only what the user set is written.
test('saving the page writes a result count or a timeout only when the user set one', async () => {
  const run = async (config, edits) => {
    const ui = await import(`./searchSettings.js?limits-${Math.random()}`);
    const writes = [];
    const callbacks = { render() {}, refresh: async () => {}, api: async (_, request) => { writes.push(request.body.agentRuntime.search); } };
    const html = ui.renderSearchSettings(config);
    await ui.handleSearchSettings('search-settings-edit', callbacks);
    for (const [name, value] of edits) ui.editSearchSettings({ name, value, type: 'text', closest: () => true });
    await ui.handleSearchSettings('search-settings-save', callbacks);
    return { html, saved: writes.at(-1) };
  };
  // Nothing saved yet, another field edited: the shown defaults are not written.
  const untouched = await run({ agentRuntime: { search: { backend: 'none', browserFallback: true } } }, [['endpoint', 'https://search.invalid/api']]);
  assert.match(untouched.html, /name="maxResults"[^>]*value="8"/); assert.match(untouched.html, /name="timeoutMs"[^>]*value="20000"/);
  assert.equal('maxResults' in untouched.saved, false); assert.equal('timeoutMs' in untouched.saved, false);
  assert.equal(untouched.saved.endpoint, 'https://search.invalid/api');
  // What the user typed is written, also when it equals the shown default.
  const typed = await run({ agentRuntime: { search: { backend: 'none' } } }, [['maxResults', '8'], ['timeoutMs', '45000']]);
  assert.deepEqual([typed.saved.maxResults, typed.saved.timeoutMs], [8, 45000]);
  // Values saved before stay saved when another field changes.
  const kept = await run({ agentRuntime: { search: { backend: 'http', endpoint: 'https://a.invalid', maxResults: 5, timeoutMs: 30000 } } }, [['endpoint', 'https://b.invalid']]);
  assert.deepEqual([kept.saved.maxResults, kept.saved.timeoutMs], [5, 30000]);
  // The server keeps its own defaults for what was not written.
  const { normalizeRuntimeConfig } = await import('../shared/agent/tools.js');
  const normalized = normalizeRuntimeConfig({ version: 1, search: JSON.parse(JSON.stringify(untouched.saved)) }).search;
  assert.equal('maxResults' in normalized || 'timeoutMs' in normalized, false);
});
