import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowCatalog, prepareWorkflowCall, validateWorkflowArguments } from './workflows.js';
import { evaluate } from './index.js';
const environment = { layout: 'outer', appVersions: { 'fixture.app': 1 } };
const script = { id: 'open-app', revision: 1, name: 'Open fixture', goalTemplate: 'Open fixture', scope: 'owner', enabled: true, verified: true, invalidated: false, parameters: [], cacheKind: 'action', environment, steps: [{ secret: 'never publish raw steps' }] };
const catalog = scripts => workflowCatalog({ scripts, scope: 'owner', environment });
const args = { workflow_id: 'script.open-app', revision: 1, parameters: {} };
test('verified action catalog is independent of parent task status and intent wording, with no raw steps', () => {
  const entries = catalog([script]);
  assert.equal(entries.length, 1); assert.equal(entries[0].kind, 'action'); assert.equal(entries[0].skill.tool, 'phone_workflow');
  assert.equal(JSON.stringify(entries).includes('secret'), false);
  assert.deepEqual(prepareWorkflowCall({ catalog: entries, args }), { scriptId: 'open-app', revision: 1, parameters: {}, goal: 'Open fixture' });
});
test('different fold posture/version, unbound legacy, disabled, invalidated, edited and other owner are not published', () => {
  for (const patch of [{ environment: null }, { environment: { ...environment, layout: 'inner' } }, { environment: { ...environment, appVersions: { 'fixture.app': 2 } } }, { verified: false }, { enabled: false }, { invalidated: true }, { scope: 'another-owner' }]) assert.deepEqual(catalog([{ ...script, ...patch }]), []);
  assert.deepEqual(workflowCatalog({ scripts: [script], scope: 'owner', environment: { ...environment, layout: 'hinge-pending' } }), []);
});
test('workflow call rejects stale/deleted/ambiguous IDs and changed revisions', () => {
  for (const entries of [[], [...catalog([script]), ...catalog([script])]]) assert.throws(() => prepareWorkflowCall({ catalog: entries, args }), { code: 'WORKFLOW_NOT_AVAILABLE' });
  assert.throws(() => prepareWorkflowCall({ catalog: catalog([script]), args: { ...args, revision: 2 } }), { code: 'WORKFLOW_REVISION_CHANGED' });
});
test('parameter changes use the saved recipe; extra/missing/overlong or malformed values are rejected', () => {
  const entries = catalog([{ ...script, parameters: ['query'], goalTemplate: 'Search {{query}} in fixture' }]);
  assert.equal(prepareWorkflowCall({ catalog: entries, args: { ...args, parameters: { query: 'different song' } } }).goal, 'Search different song in fixture');
  for (const parameters of [{}, { query: 'x', extra: 'y' }, { query: 'x'.repeat(4001) }, { query: 9 }]) assert.throws(() => prepareWorkflowCall({ catalog: entries, args: { ...args, parameters } }));
  for (const invalid of [{ ...args, revision: '1' }, { ...args, parameters: [] }, { ...args, code: 'execute()' }]) assert.throws(() => validateWorkflowArguments(invalid));
});
test('the shared bridge provides the same tool schema, call validator and capability manifest', () => {
  const call = (op, values) => evaluate({ version: 1, op, ...values });
  assert.equal(call('catalog', { names: ['phone_workflow'] }).value[0].name, 'phone_workflow');
  assert.equal(call('validateTool', { name: 'phone_workflow', arguments: args }).ok, true);
  assert.equal(call('toolEffect', { name: 'phone_workflow' }).value, 'write');
  assert.equal(call('workflowCatalog', { catalog: { scripts: [script], scope: 'owner', environment } }).value.length, 1);
});

// A native Workflow performs a phone effect, so it must both inherit the phone
// prerequisites and satisfy the phone-effect requirement after a real success.
import { startTurn, advanceTurn } from './turn.js';
function turnFixture(options = {}) {
  let state = startTurn({ runId: 'workflow-run', turnId: 'turn', now: 0, allowedTools: ['phone_use', 'phone_workflow', 'web_search'], requiredTools: ['phone_use'], ...options });
  let clock = 0;
  return { get state() { return state; }, event(event) { state = advanceTurn(state, { runId: 'workflow-run', turnId: 'turn', ...event }, ++clock); return state; } };
}
test('a successful native Workflow satisfies required phone evidence; a failed Workflow never does', () => {
  for (const ok of [true, false]) {
    const turn = turnFixture(); turn.event({ type: 'request' });
    const issued = turn.event({ type: 'calls', calls: [{ id: 'native', name: 'phone_workflow', arguments: args }] });
    assert.deepEqual(issued.permitted, ['native']);
    turn.event({ type: 'result', callId: 'native', ok }); turn.event({ type: 'request' });
    assert.equal(turn.event({ type: 'complete' }).status, ok ? 'completed' : 'blocked');
  }
});
test('Workflow reuse cannot bypass an existing research-before-phone dependency', () => {
  const turn = turnFixture({ toolDependencies: { phone_use: ['web_search'] } });
  turn.event({ type: 'request' });
  const denied = turn.event({ type: 'calls', calls: [{ id: 'too-early', name: 'phone_workflow', arguments: args }] });
  assert.deepEqual(denied.permitted, []); assert.equal(denied.rejections['too-early'], 'PREREQUISITE_MISSING');
  turn.event({ type: 'result', callId: 'too-early', ok: false }); turn.event({ type: 'request' });
  turn.event({ type: 'calls', calls: [{ id: 'search', name: 'web_search', arguments: { query: 'requested facts' } }] });
  turn.event({ type: 'result', callId: 'search', ok: true }); turn.event({ type: 'request' });
  assert.deepEqual(turn.event({ type: 'calls', calls: [{ id: 'native', name: 'phone_workflow', arguments: args }] }).permitted, ['native']);
});
