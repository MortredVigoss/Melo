import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestInternalRole, internalRoleSuggestions } from './internalRoles.js';
import { internalRouteCatalog } from '../../../../shared/agent/internalRouting.js';
import { bootstrapBuiltinTools, getAllTools } from '../../../tools/registry.js';

test('declarations decide the job: capability, shared effect, MCP read-only; unknown effects stay with the lead', () => {
  assert.equal(suggestInternalRole({ id: 'x_write', capability: 'writeFiles' }), 'execute');
  assert.equal(suggestInternalRole({ id: 'x_cmd', capability: 'runCommands' }), 'execute');
  assert.equal(suggestInternalRole({ id: 'x_dyn', capability: () => 'readFiles' }), 'execute');
  assert.equal(suggestInternalRole({ id: 'x_read', capability: 'readFiles', effect: 'read' }), 'lookup');
  assert.equal(suggestInternalRole({ id: 'x_read_unknown', capability: 'readFiles' }), null);
  assert.equal(suggestInternalRole({ id: 'x_search', capability: 'network', uiModule: 'search' }), 'research');
  assert.equal(suggestInternalRole({ id: 'x_net_unknown', capability: 'network' }), null);
  assert.equal(suggestInternalRole({ id: 'x_calc', capability: null, effect: 'compute' }), 'calculate');
  assert.equal(suggestInternalRole({ id: 'mcp:s:read', readOnly: true }), null, 'read-only MCP tools (charts, browser inspection) stay with the lead');
  assert.equal(suggestInternalRole({ id: 'mcp:antv-chart:generate_bar_chart', readOnly: true }), null);
  assert.equal(suggestInternalRole({ id: 'mcp:s:act' }), 'execute');
  for (const id of ['route_task', 'delegate', 'agent', 'melo_escalate', 'development_job', 'fake', 'skill:draft']) assert.equal(suggestInternalRole({ id, capability: 'writeFiles' }), null, id);
  assert.equal(suggestInternalRole(null), null);
  assert.deepEqual(internalRoleSuggestions([{ id: 'x_write', capability: 'writeFiles' }, { id: 'x_none' }]), { x_write: 'execute' });
});

test('every registered desktop tool lands where its declaration says, or stays with the lead', () => {
  bootstrapBuiltinTools();
  const suggestions = internalRoleSuggestions(getAllTools());
  const expect = { bash: 'execute', pdf: 'execute', image: 'execute', xlsx: 'execute', knowledge: 'execute', file_delete: 'execute', file_move: 'execute', file_mkdir: 'execute',
    glob: 'lookup', grep: 'lookup', media_info: 'lookup', device_location: 'lookup', translate: 'calculate',
    browser_open: 'research', browser_snapshot: 'research', browser_wait_for: 'research', browser_close: 'research', browser_click: 'execute', browser_fill: 'execute' };
  const registered = new Set(getAllTools().map(tool => tool.id));
  for (const [id, role] of Object.entries(expect)) if (registered.has(id)) assert.equal(suggestions[id], role, id);
  for (const id of ['delegate', 'agent', 'development_job', 'clipboard', 'reminder', 'media_api']) assert.ok(!(id in suggestions), id + ' must stay with the lead');
  // The static whitelists already own the retrieval and file tools; the catalog adds the suggested ones after them.
  const ids = getAllTools().map(tool => tool.id);
  const catalog = internalRouteCatalog('Find the venue forecast, then convert the temperature and save a note', ids, suggestions);
  assert.ok(catalog.roles.execute.includes('bash') && catalog.roles.execute.indexOf('file_write') < catalog.roles.execute.indexOf('bash'));
  assert.ok(catalog.roles.lookup.includes('media_info') && catalog.roles.calculate.includes('translate'));
  assert.ok(!Object.values(catalog.roles).flat().some(id => ['delegate', 'development_job', 'route_task'].includes(id)));
});
