import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

// Original schemas remain the execution contract. Never coerce values, insert
// defaults or remove caller-supplied properties as a side effect of validation.
const options = { strict: false, allErrors: true, validateFormats: false, addUsedSchema: false };
const validators = [new Ajv(options), new Ajv2020(options)];
const cache = new Map();
const MAX_SCHEMA_CACHE = 256;
const STRICT_KEYS = new Set(['type', 'description', 'title', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'anyOf', '$ref', '$defs', 'definitions', 'pattern', 'format', 'minLength',
  'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems']);

export function functionName(toolId) {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(toolId)) return toolId;
  const suffix = createHash('sha256').update(toolId).digest('hex').slice(0, 16);
  return `melo_${toolId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42)}_${suffix}`;
}

// Wire name for a tool: MCP tools carry a readable `functionName`
// (`mcp__server__tool`, see tools/mcpRegistry.js); everything else derives
// it from the id.
function wireName(tool) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(tool?.functionName || '') ? tool.functionName : functionName(tool.id);
}

function nullable(schema) {
  if (schema.type === 'null' || schema.type?.includes?.('null')) return schema;
  return { anyOf: [schema, { type: 'null' }] };
}

function strictSchema(schema, root = false) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Boolean or empty schema');
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['$schema', 'default', 'examples'].includes(key)) continue;
    if (!STRICT_KEYS.has(key)) throw new Error('Unsupported strict constraint');
    result[key] = structuredClone(value);
  }
  if (root && (schema.type !== 'object' || schema.anyOf || schema.$ref)) throw new Error('Non-object root');
  if (Array.isArray(schema.type) && schema.type.some(type => ['object', 'array'].includes(type))) throw new Error('Compound container');
  if (schema.anyOf?.some(part => !part.type || ['object', 'array'].includes(part.type))) throw new Error('Compound branch');
  if (schema.type === 'object' || schema.properties) {
    // Closing a free-form dictionary changes its meaning. Keep it non-strict.
    if (schema.additionalProperties && schema.additionalProperties !== false) throw new Error('Open dictionary');
    if (!schema.properties && schema.additionalProperties !== false) throw new Error('Unspecified object');
    result.properties = {};
    const required = new Set(schema.required || []);
    if ([...required].some(key => !Object.hasOwn(schema.properties || {}, key))) throw new Error('Unknown required property');
    for (const [key, property] of Object.entries(schema.properties || {})) {
      const converted = strictSchema(property);
      Object.defineProperty(result.properties, key, { value: required.has(key) ? converted : nullable(converted), enumerable: true });
    }
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  if (schema.items) result.items = strictSchema(schema.items);
  if (schema.anyOf) result.anyOf = schema.anyOf.map(part => strictSchema(part));
  for (const key of ['$defs', 'definitions']) {
    if (schema[key]) result[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, value]) => [name, strictSchema(value)]));
  }
  if (!schema.type && !schema.$ref && !schema.anyOf && !schema.enum && !Object.hasOwn(schema, 'const')) throw new Error('Unconstrained value');
  if (schema.type === 'array' && !schema.items) throw new Error('Unconstrained array');
  return result;
}

function resolveRef(schema, root) {
  const seen = new Set();
  while (schema?.$ref && !seen.has(schema)) {
    seen.add(schema);
    if (schema.$ref === '#') { schema = root; continue; }
    if (!schema.$ref.startsWith('#/')) break;
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => {
      const name = key.replace(/~1/g, '/').replace(/~0/g, '~');
      return node && Object.hasOwn(node, name) ? node[name] : undefined;
    }, root);
    if (!target) break;
    schema = target;
  }
  return schema;
}

function acceptsNull(schema, root, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return schema === true;
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (schema.$ref) return acceptsNull(resolveRef(schema, root), root, seen);
  if (schema.anyOf) return schema.anyOf.some(part => acceptsNull(part, root, new Set(seen)));
  if (schema.enum) return schema.enum.includes(null);
  if (Object.hasOwn(schema, 'const')) return schema.const === null;
  return schema.type === 'null' || Array.isArray(schema.type) && schema.type.includes('null');
}

function restoreOptionalFields(value, schema, root, depth = 0) {
  if (depth > 64) throw new Error('Tool arguments exceed nesting limit');
  schema = resolveRef(schema, root);
  if (Array.isArray(value)) return value.map(item => restoreOptionalFields(item, schema?.items || {}, root, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  const required = new Set(schema?.required || []);
  for (const [key, item] of Object.entries(value)) {
    const property = schema?.properties?.[key];
    if (property && !required.has(key) && item === null && !acceptsNull(property, root)) continue;
    Object.defineProperty(result, key, { value: restoreOptionalFields(item, property || {}, root, depth + 1), enumerable: true, writable: true });
  }
  return result;
}

function checkDepth(value, depth = 0) {
  if (depth > 64) throw new Error('Tool arguments exceed nesting limit');
  if (value && typeof value === 'object') for (const child of Object.values(value)) checkDepth(child, depth + 1);
}

export function compileFunctionTool(tool) {
  const schema = tool.parametersSchema;
  const key = JSON.stringify(schema);
  let compiled = cache.get(key);
  if (!compiled) {
    let parameters, strict = true, validate, validateWire, validationError;
    try { parameters = strictSchema(schema, true); }
    catch { parameters = structuredClone(schema); strict = false; }
    const validator = validators[/2020-12/.test(schema.$schema || '') ? 1 : 0];
    const schemaKey = `urn:melo:function:${createHash('sha256').update(key).digest('hex')}`;
    const wireKey = `${schemaKey}:wire`;
    try {
      // Give every root a stable, isolated base URI. Anonymous recursive '#'
      // references otherwise cannot resolve with addUsedSchema disabled.
      validator.addSchema(schema, schemaKey);
      validate = validator.getSchema(schemaKey);
      if (strict) {
        validator.addSchema(parameters, wireKey);
        validateWire = validator.getSchema(wireKey);
      }
    }
    catch { validationError = 'This tool has an unsupported or invalid parameter schema.'; }
    compiled = { parameters, strict, validate, validateWire, validationError, schema, validator, schemaKey, wireKey };
    if (cache.size >= MAX_SCHEMA_CACHE) {
      const oldestKey = cache.keys().next().value;
      const oldest = cache.get(oldestKey);
      oldest.validator.removeSchema(oldest.schema);
      oldest.validator.removeSchema(oldest.schemaKey);
      if (oldest.strict) oldest.validator.removeSchema(oldest.parameters);
      oldest.validator.removeSchema(oldest.wireKey);
      cache.delete(oldestKey);
    }
    cache.set(key, compiled);
  }
  return {
    schemaError: compiled.validationError || null,
    definition: { type: 'function', name: wireName(tool), description: tool.description,
      parameters: compiled.parameters, strict: compiled.strict },
    // Protocol adapter (E1): Anthropic and chat-completions providers do not
    // enforce strict mode, so they receive the original schema and their
    // arguments are validated against it only (`parse(raw, { strict: false })`).
    looseDefinition: { type: 'function', name: wireName(tool), description: tool.description,
      parameters: structuredClone(schema), strict: false },
    parse(raw, { strict = true } = {}) {
      let args;
      try {
        if (typeof raw !== 'string' || raw.length > 256 * 1024) throw new Error('Invalid argument payload');
        // Bug audit T11: local chat-completions servers send `arguments: ""`
        // for parameterless calls; treat an empty payload as `{}`.
        args = raw.trim() === '' ? {} : JSON.parse(raw);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected an object');
        checkDepth(args);
        if (strict && compiled.validateWire && !compiled.validateWire(args)) {
          return { error: 'INVALID_TOOL_ARGUMENTS', output: 'Arguments do not match the supplied function schema; supply every declared field, using null for omitted optional values.' };
        }
        // Loose mode also drops `null` sent for optional non-nullable fields
        // (models trained on strict schemas keep doing that).
        if ((strict && compiled.strict) || !strict) args = restoreOptionalFields(args, schema, schema);
      } catch {
        return { error: 'INVALID_TOOL_ARGUMENTS', output: 'Tool arguments must be a complete JSON object within the size and nesting limits.' };
      }
      if (compiled.validationError) return { error: 'INVALID_TOOL_SCHEMA', output: compiled.validationError };
      if (!compiled.validate(args)) {
        // Paths/keywords only: do not echo possibly sensitive argument values.
        const issues = compiled.validate.errors.slice(0, 5).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
        return { error: 'INVALID_TOOL_ARGUMENTS', output: `Correct the tool arguments before retrying: ${issues}` };
      }
      return { args };
    },
  };
}
