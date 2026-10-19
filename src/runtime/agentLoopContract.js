// Shared agent-loop contract (2026-10-19 手机 agent loop 对齐桌面).
//
// shared/protocol/agent-loop.json is the single source of the limits, texts
// and patterns both runtimes must agree on: tool-loop limits, run budget
// defaults and replies, repeat guard, tool-result envelope codes and hints,
// supplement wrapper, tool-trace format, uncertainty/verification prompts,
// intent rules, secret redaction and read_history limits. The desktop reads it
// here at module load; ios/Melo/AgentLoopContract.swift embeds the same JSON
// (scripts/generate-agent-loop-contract.js). Fixtures in the same file run on
// both sides (src/runtime/agentLoopContract.test.js, SharedContractTests.swift).
//
// Pure module: only node:fs.

import { readFileSync } from 'node:fs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export const AGENT_LOOP_CONTRACT_URL = new URL('../../shared/protocol/agent-loop.json', import.meta.url);
export const AGENT_LOOP_CONTRACT = deepFreeze(JSON.parse(readFileSync(AGENT_LOOP_CONTRACT_URL, 'utf8')));

/** Replace `{name}` placeholders in one pass; unknown names stay verbatim. */
export function fillTemplate(template, values = {}) {
  return String(template).replace(/\{([A-Za-z]+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}

/** RegExp from a contract `{ source, flags }` entry; `extraFlags` (e.g. 'g') are appended. */
export function contractRegExp(entry, extraFlags = '') {
  const flags = [...new Set(`${entry.flags || ''}${extraFlags}`)].join('');
  return new RegExp(entry.source, flags);
}
