// Temporary capability elevation and just-in-time enabling (2026-10-20).
//
// Pure decision core shared by every agent loop (main chat, delegated
// members, team members, skills, plain sub-agents). The rules, labels, texts
// and fixtures come from shared/protocol/agent-loop.json `capabilityElevation`
// so the iPhone port decides the same way (ios/Tests/SharedContractTests.swift).
//
//   ceiling   = the Agent's own settings (global ∩ project override)
//   base      = ceiling ∩ parent scope for a member; the ceiling at top level
//   effective = base ∪ (ceiling ∩ active beyond-parent grants)
//                    ∪ active enable-own (run) grants
//
// A capability is written as an *atom*: a boolean key (`writeFiles`) or
// `<list>:<id>` for MCP servers, skills and connectors (`mcpServers:github`).
// Grants are plain records from the desktop-local ledger
// (src/persistence/capabilityGrantLedger.js); this module never reads or
// writes them, it only evaluates the ones it is handed.
//
// No imports beyond the domain and the contract loader.

import { AGENT_LOOP_CONTRACT, fillTemplate } from '../../runtime/agentLoopContract.js';
import { normalizeCapabilities, intersectCapabilities, toolCapabilityAllowed } from './capabilities.js';
import { parseMcpToolId } from '../../mcp/toolId.js';

export const CAPABILITY_ELEVATION = AGENT_LOOP_CONTRACT.capabilityElevation;
const BOOLEAN_KEYS = CAPABILITY_ELEVATION.booleanCapabilities;
const LIST_KEYS = CAPABILITY_ELEVATION.listCapabilities;
export const ELEVATION_DECISIONS = Object.freeze(Object.fromEntries(CAPABILITY_ELEVATION.decisions.map(d => [d, d])));
const PROMPT_DECISIONS = new Set(['elevate-beyond-parent', 'enable-own']);

// ── Atoms ────────────────────────────────────────────────────────────────────

export function isCapabilityAtom(atom) {
  if (typeof atom !== 'string' || !atom || atom.length > 240) return false;
  if (BOOLEAN_KEYS.includes(atom)) return true;
  const separator = atom.indexOf(':');
  if (separator <= 0) return false;
  const list = atom.slice(0, separator), id = atom.slice(separator + 1);
  return LIST_KEYS.includes(list) && id.trim().length > 0 && id.length <= 200 && id === id.trim();
}

function atomRank(atom) {
  const index = BOOLEAN_KEYS.indexOf(atom);
  if (index >= 0) return [index, ''];
  const separator = atom.indexOf(':');
  return [BOOLEAN_KEYS.length + LIST_KEYS.indexOf(atom.slice(0, separator)), atom.slice(separator + 1)];
}

/** Canonical order: booleans in contract order, then MCP servers, skills, connectors by id. */
export function sortAtoms(atoms) {
  return [...new Set(atoms)].sort((a, b) => {
    const [x, y] = [atomRank(a), atomRank(b)];
    return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
  });
}

/** Atoms held by a normalized capability object; null (legacy) stays null. */
export function atomsOfCapabilities(capabilities) {
  const c = normalizeCapabilities(capabilities);
  if (!c) return null;
  return sortAtoms([
    ...BOOLEAN_KEYS.filter(key => c[key] === true),
    ...LIST_KEYS.flatMap(list => c[list].map(id => `${list}:${id}`)),
  ]);
}

/** Normalized capability object from atoms; unknown atoms are ignored (fail closed). */
export function capabilitiesFromAtoms(atoms) {
  const value = { version: 1, mcpServers: [], skills: [], connectors: [] };
  for (const atom of Array.isArray(atoms) ? atoms : []) {
    if (!isCapabilityAtom(atom)) continue;
    if (BOOLEAN_KEYS.includes(atom)) value[atom] = true;
    else {
      const separator = atom.indexOf(':');
      value[atom.slice(0, separator)].push(atom.slice(separator + 1));
    }
  }
  return normalizeCapabilities(value);
}

/** Union of capability objects (null entries are skipped; all null → null). */
export function unionCapabilities(...values) {
  const present = values.map(normalizeCapabilities).filter(Boolean);
  if (!present.length) return null;
  return capabilitiesFromAtoms(present.flatMap(atomsOfCapabilities));
}

export function hasAtom(capabilities, atom) {
  const c = normalizeCapabilities(capabilities);
  if (!c || !isCapabilityAtom(atom)) return false;
  if (BOOLEAN_KEYS.includes(atom)) return c[atom] === true;
  const separator = atom.indexOf(':');
  return c[atom.slice(0, separator)].includes(atom.slice(separator + 1));
}

const LABELS = CAPABILITY_ELEVATION.labels;
export function atomLabel(atom) {
  if (BOOLEAN_KEYS.includes(atom)) return LABELS.capabilities[atom] || atom;
  const separator = atom.indexOf(':');
  const template = LABELS.lists[atom.slice(0, separator)];
  return template ? fillTemplate(template, { id: atom.slice(separator + 1) }) : atom;
}
export const atomsLabel = atoms => sortAtoms(atoms).map(atomLabel).join(LABELS.separator);

// ── Grants ───────────────────────────────────────────────────────────────────

/**
 * Whether a grant is in force for this Agent in this context at `now`.
 * run → same run; project → same project; chat → same chat (no project).
 */
export function grantIsActive(grant, { agentId, runId = null, projectId = null, chatId = null } = {}, now = Date.now()) {
  if (!grant || typeof grant !== 'object' || grant.agentId !== agentId) return false;
  if (grant.revokedAt || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) return false;
  if (!CAPABILITY_ELEVATION.grantKinds.includes(grant.kind)) return false;
  if (!Array.isArray(grant.atoms) || !grant.atoms.length || !grant.atoms.every(isCapabilityAtom)) return false;
  if (grant.scope === 'run') return Boolean(runId) && grant.runId === runId;
  if (grant.scope === 'project') return Boolean(projectId) && grant.projectId === projectId;
  if (grant.scope === 'chat') return !projectId && Boolean(chatId) && grant.chatId === chatId;
  return false;
}

/** Expiry of a grant created at `now` in `scope` (contract durations). */
export function grantExpiry(scope, now = Date.now()) {
  const entry = CAPABILITY_ELEVATION.grantScopes[scope];
  if (!entry) throw Object.assign(new Error(`Unknown grant scope: ${scope}`), { code: 'INVALID_GRANT_SCOPE' });
  return now + entry.durationMs;
}

// ── Effective scope ──────────────────────────────────────────────────────────

const capsOf = party => (party && typeof party === 'object' ? normalizeCapabilities(party.capabilities) : null);

/**
 * @param {Object} input
 * @param {{agentId:string, capabilities:Object|null}} input.member  the Agent's own settings (ceiling)
 * @param {{agentId:string, capabilities:Object|null}|null} [input.parent]  parent scope (members only)
 * @param {Object} [input.base]   explicit base when a caller narrowed further (defaults to member ∩ parent)
 * @param {Array}  [input.grants] ledger records (any agent / context; filtered here)
 * @param {{runId?:string, projectId?:string|null, chatId?:string|null}} [input.context]
 * @param {number} [input.now]
 * @returns {{capabilities:Object|null, base:Object|null, ceiling:Object|null, grantIds:string[]}}
 */
export function effectiveScope({ member, parent = null, base, grants = [], context = {}, now = Date.now() } = {}) {
  const ceiling = capsOf(member);
  if (!ceiling) return { capabilities: null, base: null, ceiling: null, grantIds: [] };
  const baseCaps = base !== undefined && base !== null
    ? normalizeCapabilities(base)
    : parent ? intersectCapabilities(ceiling, capsOf(parent)) : ceiling;
  const active = (Array.isArray(grants) ? grants : []).filter(g => grantIsActive(g, { ...context, agentId: member.agentId }, now));
  const added = [], grantIds = [];
  for (const g of active) {
    // Beyond-parent grants only ever fill the gap below the member's own
    // ceiling; enable-own grants are the user's explicit widening of it.
    const atoms = g.kind === 'enable-own' ? g.atoms : parent ? g.atoms.filter(atom => hasAtom(ceiling, atom)) : [];
    const fresh = atoms.filter(atom => !hasAtom(baseCaps, atom));
    if (fresh.length) { added.push(...fresh); grantIds.push(g.id); }
  }
  return {
    capabilities: added.length ? unionCapabilities(baseCaps, capabilitiesFromAtoms(added)) : baseCaps,
    base: baseCaps, ceiling, grantIds: [...new Set(grantIds)],
  };
}

// ── Requirement of one call ─────────────────────────────────────────────────

/** Atoms that can matter for this tool: every boolean, plus the list atom its id names. */
export function candidateAtoms(toolId) {
  const atoms = [...BOOLEAN_KEYS];
  if (typeof toolId === 'string' && toolId.startsWith('mcp:')) {
    const parsed = parseMcpToolId(toolId);
    if (parsed) atoms.push(`mcpServers:${parsed.server}`);
  } else if (typeof toolId === 'string' && toolId.startsWith('skill:') && toolId.length > 6) {
    atoms.push(`skills:${toolId.slice(6)}`);
  }
  return atoms.filter(isCapabilityAtom);
}

/**
 * Smallest set of atoms that, added to `effective`, allows the call.
 * Ties prefer atoms inside the ceiling (a beyond-parent request over an
 * enable-own one), then canonical order. null: no combination allows it.
 */
export function missingAtoms({ toolId, args, tool, effective, ceiling }) {
  const candidates = sortAtoms(candidateAtoms(toolId).filter(atom => !hasAtom(effective, atom)));
  const object = tool && typeof tool === 'object' && tool.id === toolId ? tool : undefined;
  for (let size = 1; size <= candidates.length; size++) {
    const found = [];
    const pick = (start, chosen) => {
      if (chosen.length === size) {
        const widened = unionCapabilities(effective, capabilitiesFromAtoms(chosen));
        if (toolCapabilityAllowed(toolId, widened, args, object)) found.push([...chosen]);
        return;
      }
      for (let i = start; i < candidates.length; i++) pick(i + 1, [...chosen, candidates[i]]);
    };
    pick(0, []);
    if (found.length) return found.find(set => set.every(atom => hasAtom(ceiling, atom))) || found[0];
  }
  return null;
}

// ── Decision ─────────────────────────────────────────────────────────────────

/**
 * @param {Object} input
 * @param {string} input.toolId
 * @param {Object} [input.args]   undefined for a visibility check
 * @param {Object} [input.tool]   tool object; its `capability` declaration wins over the id tables
 * @param {{agentId:string, capabilities:Object|null, scope?:'global'|'project', globalCapabilities?:Object}} input.member
 * @param {{agentId:string, capabilities:Object|null}|null} [input.parent]
 * @param {Object} [input.base]
 * @param {Array}  [input.grants]
 * @param {{surface?:boolean, runId?:string, projectId?:string|null, chatId?:string|null, allowedToolIds?:string[]|null}} [input.context]
 * @param {number} [input.now]
 */
export function decideCapability({ toolId, args, tool, member, parent = null, base, grants = [], context = {}, now = Date.now() } = {}) {
  const scope = effectiveScope({ member, parent, base, grants, context, now });
  const result = (decision, extra = {}) => Object.freeze({
    decision, missing: [], effective: scope.capabilities, base: scope.base, ceiling: scope.ceiling,
    grantIds: decision === 'allowed' ? scope.grantIds : [], ...extra,
  });
  if (Array.isArray(context.allowedToolIds) && !context.allowedToolIds.includes(toolId)) return result('deny-ceiling', { reason: 'whitelist' });
  if (!scope.ceiling) return result('allowed', { reason: 'legacy' });
  const object = tool && typeof tool === 'object' && tool.id === toolId ? tool : undefined;
  if (toolCapabilityAllowed(toolId, scope.capabilities, args, object)) {
    return result('allowed', { reason: toolCapabilityAllowed(toolId, scope.base, args, object) ? 'base' : 'grant' });
  }
  const missing = missingAtoms({ toolId, args, tool: object, effective: scope.capabilities, ceiling: scope.ceiling });
  if (!missing) return result('deny-ceiling', { reason: 'unclassified' });
  const outsideCeiling = missing.filter(atom => !hasAtom(scope.ceiling, atom));
  let wouldPrompt;
  if (outsideCeiling.length) wouldPrompt = 'enable-own';
  else if (parent) wouldPrompt = 'elevate-beyond-parent';
  else return result('deny-ceiling', { reason: 'narrowed', missing });
  if (context.surface !== true) return result('deny-no-surface', { reason: 'no-surface', wouldPrompt, missing });
  if (wouldPrompt === 'elevate-beyond-parent') {
    return result(wouldPrompt, { missing, options: [...CAPABILITY_ELEVATION.options[wouldPrompt]], projectOptionScope: context.projectId ? 'project' : 'chat' });
  }
  // "一直开启" writes the settings scope this chat runs under. A project
  // override is intersected with the global settings, so it cannot enable on
  // its own what the global settings lack.
  const global = normalizeCapabilities(member.globalCapabilities);
  const alwaysUnavailable = member.scope === 'project' && outsideCeiling.some(atom => !hasAtom(global, atom));
  const options = CAPABILITY_ELEVATION.options[wouldPrompt].filter(option => option !== 'always' || !alwaysUnavailable);
  return result(wouldPrompt, { missing, options, ...(alwaysUnavailable ? { alwaysUnavailable: true } : {}) });
}

export const isPromptDecision = decision => PROMPT_DECISIONS.has(decision);

/**
 * Capabilities whose tools an Agent may *see*: what it has, plus what it could
 * ask for. Only with an interactive surface: its own ceiling (beyond-parent)
 * and the contract's just-in-time booleans (enable-own). MCP servers, skills
 * and connectors outside the ceiling stay hidden.
 */
export function requestableCapabilities({ capabilities, ceiling = null, surface = false } = {}) {
  const c = normalizeCapabilities(capabilities);
  if (!c || surface !== true) return c;
  return unionCapabilities(c, ceiling, capabilitiesFromAtoms(CAPABILITY_ELEVATION.jitVisible));
}

// ── Texts ────────────────────────────────────────────────────────────────────

const TEXTS = CAPABILITY_ELEVATION.texts;
export function capabilityPromptText({ decision, agent, parent, atoms }) {
  const capability = atomsLabel(atoms);
  return decision === 'elevate-beyond-parent'
    ? fillTemplate(TEXTS.beyondParentPrompt, { agent, parent: parent || '', capability })
    : fillTemplate(TEXTS.enableOwnPrompt, { agent, capability });
}
export function capabilityOptionLabel(decision, option, projectOptionScope = 'project') {
  const labels = TEXTS.optionLabels[decision] || {};
  return labels[option === 'project' ? projectOptionScope : option] || option;
}
export const elevationText = (key, values = {}) => fillTemplate(TEXTS[key] ?? key, values);
