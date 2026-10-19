// Embeds shared/protocol/agent-loop.json (without its fixtures) into
// ios/Melo/AgentLoopContract.swift, the same way generate-sync-contract.js
// embeds the sync schema. The desktop reads the JSON directly
// (src/runtime/agentLoopContract.js); the iPhone app has no access to the
// repository at run time, so it carries this generated copy. `--check` fails
// when the Swift copy is stale.
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SWIFT_PATH = 'ios/Melo/AgentLoopContract.swift';
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
  return { bytes: json.length };
}

export async function swiftCopyAvailable(root = process.cwd()) {
  try { await access(resolve(root, SWIFT_PATH)); return true; } catch { return false; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateAgentLoopContract({ check: process.argv.includes('--check') });
  console.log(`agent-loop contract: ${result.bytes} bytes embedded in ${SWIFT_PATH}`);
}
