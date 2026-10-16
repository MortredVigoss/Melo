import { agentInstructionFields, composeAgentInstructions } from '../src/domain/agent/agentDocument.js';

const FIELDS = ['instructions', 'identity', 'soul', 'systemPrompt'];
const text = value => typeof value === 'string' ? value : '';
export function decodeV1Persona(value = {}) {
  const parts = Object.fromEntries(FIELDS.map(key => [key, text(value[key])]));
  return [parts.identity, parts.soul, parts.systemPrompt].some(value => value.trim())
    ? composeAgentInstructions({rolePrompt:parts.instructions,identity:parts.identity,soulMd:parts.soul,systemPrompt:parts.systemPrompt})
    : parts.instructions;
}

// The existing wire record is the transport mapping, never another writable
// persona. Reuse it only when decoding proves it describes the current document.
export function encodeV1Persona(instructions, previous = null) {
  const document = text(instructions);
  const valid = fields => FIELDS.every(key => typeof fields[key] === 'string' && fields[key].length <= 50000)
    && decodeV1Persona(fields) === document;
  if (previous) {
    const fields = Object.fromEntries(FIELDS.map(key => [key, text(previous[key])]));
    if (valid(fields)) return fields;
  }
  const single = {instructions:document, identity:'', soul:'', systemPrompt:''};
  if (valid(single)) return single;
  const sections = agentInstructionFields(document);
  const fields = {instructions:sections.rolePrompt,identity:sections.identity,soul:sections.soulMd,systemPrompt:sections.systemPrompt};
  return valid(fields) ? fields : null;
}
