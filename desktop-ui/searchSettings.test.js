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
