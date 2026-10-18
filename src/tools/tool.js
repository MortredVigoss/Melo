/**
 * Tool interface contract for Melo's tool system.
 *
 * Every tool is a plain object (not a class) that satisfies this shape.
 * Validated at registration time.
 *
 * Execution contract:
 *   - run() resolves to a ToolResult
 *   - Errors should throw — the executor wraps them as { ok: false, error }
 *   - Long-running tools should honour the AbortSignal
 *
 * Concurrency contract:
 *   - concurrency: boolean | (args) => boolean — per-call verdict; wins over
 *     isConcurrencySafe when present (a tool with read and write actions can
 *     overlap its reads and serialise its writes)
 *   - isConcurrencySafe: true  → may run in parallel with other safe tools
 *   - isConcurrencySafe: false → must run serially (default)
 *
 * Permission contract:
 *   - requiresPermission: true  → executor asks user before running (default for destructive tools)
 *   - requiresPermission: false → runs immediately (read-only, safe tools)
 *
 * Self-description (design audit T8/T9, option F2). Every field is optional;
 * an undeclared field falls back to the built-in id tables that predate it:
 *   - capability:     CapabilityRequirement | (args) => CapabilityRequirement
 *                     Agent capability the call consumes (domain/agent/capabilities.js).
 *                     `null` means "no capability needed" (calculator-class).
 *                     Visibility checks call the function with `undefined` args.
 *                     Fallback: capabilities.js id tables; unmapped ids are denied.
 *   - needsWorkspace: boolean | (args) => boolean
 *                     Whether the call must run inside a bound workspace.
 *                     Fallback: services/workspace/toolWorkspace.js localTools.
 *   - uiModule:       string | (args) => string — EXECUTION_MODULES id used by
 *                     the execution scene. Fallback: executionScene.moduleForOperation.
 *   - inputKeys:      string[] — argument keys shown in the observation input
 *                     summary. Fallback: executionObservation default key list.
 *   - concurrency:    see above. Fallback: isConcurrencySafe.
 * desktop-ui/runSteps.js labels cannot read tool objects and stay hand-maintained.
 */

import { CAPABILITY_LABELS } from '../domain/agent/capabilities.js';

/**
 * @typedef {'readFiles'|'writeFiles'|'runCommands'|'network'|'knowledgeMemory'|'generateMedia'|'delegate'} CapabilityKey
 */
/**
 * @typedef {null|CapabilityKey|CapabilityKey[]|{anyOf: CapabilityKey[]}} CapabilityRequirement
 *   - null            → always allowed
 *   - key             → that capability must be enabled
 *   - key[]           → every listed capability must be enabled
 *   - { anyOf: [...] } → at least one must be enabled (used for visibility
 *                        checks of multi-action tools when args are unknown)
 */

/**
 * @typedef {Object} EvidenceTrailItem
 * @property {string}  tier        - which fallback layer this entry came from (e.g. 'jina', 'direct', 'playwright')
 * @property {string}  outcome     - 'ok' | 'fail' | 'aborted' | 'skip' | 'unknown'
 * @property {number}  [latencyMs] - how long the attempt took
 * @property {string}  [reason]    - short failure-category string (e.g. 'timeout', 'parse-empty', 'http-403')
 * @property {string}  [method]    - subtype within the tier (e.g. for social-link: 'yt-dlp', 'oembed', 'meta')
 * @property {Object}  [extra]     - tier-specific debug payload
 */

/**
 * @typedef {Object} ToolResult
 * @property {boolean} ok
 * @property {string}  output   - human-readable output (shown in chat)
 * @property {string}  [error]  - error message when ok=false
 * @property {Object}  [meta]   - optional structured metadata (exit codes, paths, etc.)
 * @property {EvidenceTrailItem[]} [evidenceTrail]
 *   - Phase G-1a/b/c: ordered diagnostic trail of fallback attempts. Currently
 *     populated by `fetchUrlTool` / `socialLinkTool` / `webSearchTool`. The
 *     executor preserves this field through normalization (G-1d slice 1, c3285d2)
 *     so downstream consumers (chatExecutionRunner / subAgent / skillExecutor)
 *     can inspect it. Only attached when the tool actually produced a non-empty
 *     array — absent on tools that don't fall through tiers.
 */

/**
 * @typedef {Object} ToolRunContext
 * @property {AbortSignal}         signal         - propagated abort signal
 * @property {string}              [workspacePath] - active project workspace root
 * @property {Function}            [onOutput]      - streaming output callback (chunk: string) => void
 * @property {string}              [chatId]        - active chat id (for scoped state)
 */

/**
 * Validate that an object satisfies the Tool interface.
 * @param {Object} tool
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateTool(tool) {
  if (!tool || typeof tool !== 'object') {
    return { valid: false, reason: 'Tool must be a plain object.' };
  }
  if (typeof tool.id !== 'string' || !tool.id.trim()) {
    return { valid: false, reason: 'Tool must have a non-empty string id.' };
  }
  if (typeof tool.name !== 'string' || !tool.name.trim()) {
    return { valid: false, reason: 'Tool must have a non-empty string name.' };
  }
  if (typeof tool.description !== 'string' || !tool.description.trim()) {
    return { valid: false, reason: 'Tool must have a non-empty string description.' };
  }
  if (typeof tool.parametersSchema !== 'object' || !tool.parametersSchema) {
    return { valid: false, reason: 'Tool must have a parametersSchema object.' };
  }
  if (typeof tool.run !== 'function') {
    return { valid: false, reason: 'Tool must have a run(args, context) function.' };
  }
  return validateSelfDescription(tool);
}

/**
 * @typedef {Object} ToolSelfDescription
 * @property {CapabilityRequirement|((args: Object|undefined) => CapabilityRequirement)} [capability]
 * @property {boolean|((args: Object) => boolean)} [needsWorkspace]
 * @property {string|((args: Object) => string)} [uiModule]
 * @property {string[]} [inputKeys]
 * @property {boolean|((args: Object) => boolean)} [concurrency]
 */

const CAPABILITY_KEYS = new Set(Object.keys(CAPABILITY_LABELS));
const isCapabilityKey = value => typeof value === 'string' && CAPABILITY_KEYS.has(value);
/** Static shape check for a CapabilityRequirement (function results are checked at call time by the domain). */
export function isCapabilityRequirement(value) {
  if (value === null || isCapabilityKey(value)) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(isCapabilityKey);
  return !!value && typeof value === 'object' && Array.isArray(value.anyOf) && value.anyOf.length > 0 && value.anyOf.every(isCapabilityKey);
}

/** Validate the optional self-description fields; all may be absent. */
export function validateSelfDescription(tool) {
  const boolOrFn = (key) => tool[key] === undefined || typeof tool[key] === 'boolean' || typeof tool[key] === 'function';
  if (!boolOrFn('needsWorkspace')) return { valid: false, reason: 'Tool needsWorkspace must be a boolean or (args) => boolean.' };
  if (!boolOrFn('concurrency')) return { valid: false, reason: 'Tool concurrency must be a boolean or (args) => boolean.' };
  if (tool.capability !== undefined && typeof tool.capability !== 'function' && !isCapabilityRequirement(tool.capability)) {
    return { valid: false, reason: `Tool capability must be null, one of ${[...CAPABILITY_KEYS].join('|')}, an array of those, {anyOf:[...]}, or (args) => requirement.` };
  }
  if (tool.uiModule !== undefined && typeof tool.uiModule !== 'function' && (typeof tool.uiModule !== 'string' || !tool.uiModule.trim())) {
    return { valid: false, reason: 'Tool uiModule must be a non-empty string or (args) => string.' };
  }
  if (tool.inputKeys !== undefined && (!Array.isArray(tool.inputKeys) || !tool.inputKeys.every(key => typeof key === 'string' && key))) {
    return { valid: false, reason: 'Tool inputKeys must be an array of non-empty strings.' };
  }
  return { valid: true };
}

// ─── Self-description resolvers ──────────────────────────────────────────────
// Each returns `undefined` when the tool did not declare the field so callers
// can fall back to their legacy id tables. `capability` is resolved by
// domain/agent/capabilities.js (declaredCapabilityRequirement) because the
// domain layer cannot import this module.

const resolveField = (tool, key, args) => {
  const value = tool?.[key];
  return typeof value === 'function' ? value(args ?? {}) : value;
};

/**
 * Per-call concurrency verdict: `concurrency` (boolean or function of args)
 * wins; otherwise the legacy static `isConcurrencySafe` flag.
 * @returns {boolean}
 */
export function toolConcurrencySafe(tool, args) {
  if (tool?.concurrency !== undefined) return resolveField(tool, 'concurrency', args) === true;
  return tool?.isConcurrencySafe === true;
}

/** Declared workspace requirement, or `undefined` when the tool did not declare one. */
export function declaredWorkspaceRequirement(tool, args) {
  if (tool?.needsWorkspace === undefined) return undefined;
  return resolveField(tool, 'needsWorkspace', args) === true;
}

/** Declared execution-scene module, or `undefined` when the tool did not declare one. */
export function declaredUiModule(tool, args) {
  if (tool?.uiModule === undefined) return undefined;
  const value = resolveField(tool, 'uiModule', args);
  return typeof value === 'string' && value ? value : undefined;
}

/** Declared input-summary keys, or `undefined` when the tool did not declare them. */
export function declaredInputKeys(tool) {
  return Array.isArray(tool?.inputKeys) ? tool.inputKeys : undefined;
}

/**
 * Default values for optional tool properties.
 */
export function normalizeToolDefaults(tool) {
  return {
    isConcurrencySafe: false,
    requiresPermission: true,
    category: 'general',
    examples: [],
    ...tool,
  };
}
