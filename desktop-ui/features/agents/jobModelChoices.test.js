// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderJobModelChoices, jobModelsFromForm } from './jobModelChoices.js';
import { buildAgentProfilePatch } from './agentProfilePatch.js';
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('per-job model selects follow the conversation by default, list saved connections, keep an unavailable id and feed the profile patch', () => {
  const profiles = [{ id: 'existing', nameKey: '原有连接', model: 'gpt-6.1-sol' }, { id: 'fast', name: '<Fast>', model: 'fast-model' }];
  const html = renderJobModelChoices({ research: 'fast', execute: 'gone' }, profiles, esc);
  assert.equal((html.match(/<select class="config-input" name="jobModel_/g) || []).length, 5, 'research, social (2026-11-07), lookup, calculate, execute');
  assert.match(html, /name="jobModel_social"><option value="" selected>跟随对话/);
  assert.match(html, /name="jobModel_research"><option value="">跟随对话<\/option><option value="existing">原有连接 · gpt-6.1-sol<\/option><option value="fast" selected>&lt;Fast> · fast-model<\/option>/);
  assert.match(html, /name="jobModel_lookup"><option value="" selected>跟随对话/);
  assert.match(html, /name="jobModel_execute">.*<option value="gone" selected>gone · 当前不可用<\/option>/);
  assert.doesNotMatch(html, /<Fast>/);
  const form = { elements: { namedItem: () => null } }, fd = new FormData();
  fd.set('capabilityVersion', '1'); fd.set('delegateTargets__choices', '1');
  fd.set('jobModel_research', 'fast'); fd.set('jobModel_social', 'fast'); fd.set('jobModel_lookup', ''); fd.set('jobModel_calculate', ''); fd.set('jobModel_execute', 'existing');
  const patch = buildAgentProfilePatch(form, fd);
  assert.deepEqual(patch.collaboration.jobModels, { research: 'fast', social: 'fast', execute: 'existing' });
  for (const role of ['research', 'social', 'lookup', 'calculate', 'execute']) fd.set('jobModel_' + role, '');
  assert.deepEqual(buildAgentProfilePatch(form, fd).collaboration.jobModels, {}, 'clearing every select sends an empty map so the server drops the field');
  const withoutFields = new FormData(); withoutFields.set('capabilityVersion', '1'); withoutFields.set('delegateTargets__choices', '1');
  assert.equal('jobModels' in buildAgentProfilePatch(form, withoutFields).collaboration, false, 'older forms without the selects leave the setting alone');
  assert.equal(jobModelsFromForm(withoutFields, () => false), undefined);
});
