// Portable metadata and call validation only. Native hosts own execution and grants.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const PHONE_WORKFLOW_TOOL = {
  name: 'phone_workflow', description: 'Run a published, verified phone action or subflow natively, without a device-model Probe. Choose workflow_id and revision from the current Skill Manifest; supply its exact parameters. A subflow receipt covers only its own goal; continue the remaining user task. Never invent IDs or replay a completed commit.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    workflow_id: { type: 'string', maxLength: 256 }, revision: { type: 'integer', minimum: 1, maximum: 2147483647 },
    parameters: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 }, maxProperties: 12 },
  }, required: ['workflow_id', 'revision', 'parameters'] },
};
export function validateWorkflowArguments(args) {
  if (!object(args) || Object.keys(args).some(key => !['workflow_id', 'revision', 'parameters'].includes(key)) ||
      !text(args.workflow_id, 256) || !Number.isSafeInteger(args.revision) || args.revision < 1 || args.revision > 2147483647 ||
      !object(args.parameters) || Object.keys(args.parameters).length > 12 || Object.entries(args.parameters).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(key) || !text(value, 4000))) fail('INVALID_TOOL_ARGUMENTS', 'Invalid phone workflow arguments.');
  return args;
}
function compatible(script, environment) {
  const saved = script.environment;
  return object(saved) && object(environment) && text(environment.layout, 500) && !environment.layout.includes('hinge-pending') && saved.layout === environment.layout &&
    object(saved.appVersions) && Object.keys(saved.appVersions).length > 0 && Object.entries(saved.appVersions).every(([pkg, version]) => Number.isSafeInteger(version) && version >= 0 && environment.appVersions?.[pkg] === version);
}
export function workflowCatalog({ scripts = [], scope, environment } = {}) {
  if (!Array.isArray(scripts) || !text(scope, 256)) return [];
  return scripts.slice(0, 100).filter(script => object(script) && script.scope === scope && script.enabled === true && script.verified === true && script.invalidated !== true &&
    text(script.id, 240) && Number.isSafeInteger(script.revision) && script.revision > 0 && script.revision <= 2147483647 && text(script.name, 100) && text(script.goalTemplate, 4000) &&
    Array.isArray(script.parameters) && script.parameters.length <= 12 && script.parameters.every(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(name)) && new Set(script.parameters).size === script.parameters.length && compatible(script, environment))
    .map(script => ({ id: 'script.' + script.id, revision: script.revision, name: script.name, goalTemplate: script.goalTemplate,
      kind: script.cacheKind || 'task', parameters: [...script.parameters],
      skill: { tool: 'phone_workflow', instruction: 'Reuse this verified action/subflow when it fits a part of the requested task. It executes native steps with fresh observations. Its success does not certify other requested work.' } }));
}
export function prepareWorkflowCall({ catalog = [], args } = {}) {
  validateWorkflowArguments(args);
  const found = Array.isArray(catalog) ? catalog.filter(item => item.id === args.workflow_id) : [];
  if (found.length !== 1) fail('WORKFLOW_NOT_AVAILABLE', 'Workflow is no longer available in the current granted scope/environment.');
  const entry = found[0];
  if (entry.revision !== args.revision) fail('WORKFLOW_REVISION_CHANGED', 'Workflow changed; use the current revision.');
  if (Object.keys(args.parameters).some(key => !entry.parameters.includes(key)) || entry.parameters.some(key => !Object.hasOwn(args.parameters, key))) fail('INVALID_TOOL_ARGUMENTS', 'Supply exactly the declared workflow parameters.');
  const goal = entry.goalTemplate.replace(/\{\{([A-Za-z][A-Za-z0-9_]{0,39})\}\}/gu, (_, name) => args.parameters[name] ?? '{{' + name + '}}');
  if (goal.length > 4000) fail('INVALID_TOOL_ARGUMENTS', 'Expanded workflow goal is too long.');
  return { scriptId: entry.id.slice('script.'.length), revision: entry.revision, parameters: { ...args.parameters }, goal };
}
