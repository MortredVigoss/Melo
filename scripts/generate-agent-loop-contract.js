// Embeds shared/protocol/agent-loop.json (without its fixtures) into
// ios/Melo/AgentLoopContract.swift, the same way generate-sync-contract.js
// embeds the sync schema. The desktop reads the JSON directly
// (src/runtime/agentLoopContract.js); the iPhone app has no access to the
// repository at run time, so it carries this generated copy. `--check` fails
// when the Swift copy is stale.
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SWIFT_PATH = 'ios/Melo/AgentLoopContract.swift';
export const JS_PATH = 'shared/agent/loopContract.js';
const BEGIN = '// BEGIN GENERATED AGENT LOOP CONTRACT';
const END = '// END GENERATED AGENT LOOP CONTRACT';

export async function generateAgentLoopContract({ check = false, root = process.cwd() } = {}) {
  const contract = JSON.parse(await readFile(resolve(root, 'shared/protocol/agent-loop.json'), 'utf8'));
  const { fixtures, ...embedded } = contract;
  const json = JSON.stringify(embedded);
  if (json.includes('"###')) throw new Error('agent-loop.json must not contain the Swift raw-string delimiter "###');
  const path = resolve(root, SWIFT_PATH);
  const current = await readFile(path, 'utf8');
  if (!current.includes(BEGIN) || !current.includes(END)) throw new Error(`${SWIFT_PATH} lacks the generated-section markers`);
  const prefix = current.slice(0, current.indexOf(BEGIN));
  const suffix = current.slice(current.indexOf(END) + END.length);
  const next = `${prefix}${BEGIN}\n// Source: shared/protocol/agent-loop.json (fixtures omitted); run npm run generate:agent-loop-contract.\nenum AgentLoopContractSource {\n    static let json = ###"${json}"###\n}\n${END}${suffix}`;
  if (check) {
    if (current !== next) throw new Error(`${SWIFT_PATH} is stale; run npm run generate:agent-loop-contract`);
  } else if (current !== next) await writeFile(path, next);
  const portable = `// Generated from shared/protocol/agent-loop.json; do not edit.\nfunction deepFreeze(value) {\n  if (value && typeof value === 'object' && !Object.isFrozen(value)) {\n    Object.freeze(value);\n    for (const item of Object.values(value)) deepFreeze(item);\n  }\n  return value;\n}\nexport const AGENT_LOOP_CONTRACT = deepFreeze(${json});\nexport function fillTemplate(template, values = {}) {\n  return String(template).replace(/\\{([A-Za-z]+)\\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));\n}\n` + "/** RegExp from a contract `{ source, flags }` entry; `extraFlags` (e.g. 'g') are appended. */\nexport function contractRegExp(entry, extraFlags = '') {\n  const flags = [...new Set(`${entry.flags || ''}${extraFlags}`)].join('');\n  return new RegExp(entry.source, flags);\n}\n";
  const portablePath = resolve(root, JS_PATH);
  if (check) {
    if (await readFile(portablePath, 'utf8') !== portable) throw new Error(`${JS_PATH} is stale; run npm run generate:agent-loop-contract`);
  } else await writeFile(portablePath, portable);
  const kotlinPath = resolve(root, 'android/app/src/main/java/com/melo/android/core/AgentLoopDefaults.kt');
  const constants = { maxIterations: contract.loop.maxIterations, minIterations: contract.loop.minIterations, maxRounds: contract.guardLimits.maxRounds,
    deadlineMs: contract.budget.deadlineMs, deepDeadlineMs: contract.loop.deepTask.deadlineMs };
  const kotlin = '// Generated from shared/protocol/agent-loop.json; do not edit.\npackage com.melo.android.core\n\nobject AgentLoopDefaults {\n' +
    Object.entries(constants).map(([key, value]) => `    const val ${key}: Int = ${value}`).join('\n') + '\n}\n';
  if (check) {
    if (await readFile(kotlinPath, 'utf8') !== kotlin) throw new Error('Android AgentLoopDefaults is stale; run npm run generate:agent-loop-contract');
  } else { await mkdir(dirname(kotlinPath), { recursive: true }); await writeFile(kotlinPath, kotlin); }
  return { bytes: json.length };
}

export async function swiftCopyAvailable(root = process.cwd()) {
  try { await access(resolve(root, SWIFT_PATH)); return true; } catch { return false; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateAgentLoopContract({ check: process.argv.includes('--check') });
  console.log(`agent-loop contract: ${result.bytes} bytes embedded in ${SWIFT_PATH}`);
}
