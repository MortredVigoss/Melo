import { CORE_VERSION, startTurn, advanceTurn } from './turn.js';
import { planRequest } from './search.js';
import { buildSkills } from './skill/skillService.js';

export function evaluate(input) {
  try {
    if (!input || input.version !== CORE_VERSION) throw Object.assign(new Error('Unsupported Core protocol.'), { code: 'PROTOCOL_VERSION' });
    let value;
    switch (input.op) {
      case 'hello': value = { version: CORE_VERSION, runtime: 'melo-local-core', portable: true }; break;
      case 'plan': value = planRequest(input.request); break;
      case 'skills': value = buildSkills(input.enabledIds, input.customSkills); break;
      case 'start': value = startTurn(input.turn); break;
      case 'advance': value = advanceTurn(input.state, input.event, input.now); break;
      default: throw Object.assign(new Error('Unknown Core operation.'), { code: 'UNKNOWN_OPERATION' });
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: { code: error.code || 'CORE_ERROR', message: error.message } };
  }
}

export function evaluateJSON(json) {
  if (typeof json !== 'string' || json.length > 2_000_000) return JSON.stringify({ ok: false, error: { code: 'INPUT_LIMIT', message: 'Core input exceeds its JSON budget.' } });
  try { return JSON.stringify(evaluate(JSON.parse(json))); }
  catch { return JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: 'Core input is not valid JSON.' } }); }
}
