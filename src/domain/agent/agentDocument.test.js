import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAgentInstructions, agentInstructionFields, mergeAgentInstructions } from './agentDocument.js';
import { normalizeAgentProfile, effectiveAgentProfile } from '../../state/agentProfiles.js';
import { summarizeAgentPrompt } from '../../services/chat/systemPrompt.js';

test('legacy persona sections migrate without dropping any content or repeating the prompt', () => {
  const legacy = { rolePrompt:'work exactly', identity:'identity exactly', soulMd:'style exactly', systemPrompt:'extra exactly' };
  const instructions = composeAgentInstructions(legacy);
  assert.deepEqual(agentInstructionFields(instructions), legacy);
  const agent = normalizeAgentProfile('main', {...legacy, instructions});
  const prompt = summarizeAgentPrompt(agent);
  for (const text of Object.values(legacy)) assert.equal(prompt.split(text).length - 1, 1);
});
test('canonical empty instructions stay empty and built-in Agent edits survive normalization', () => {
  const profile = normalizeAgentProfile('research', {name:'My researcher',description:'My purpose',instructions:''});
  assert.equal(profile.name,'My researcher');
  assert.equal(profile.description,'My purpose');
  assert.equal(profile.instructions,'');
  assert.equal(profile.rolePrompt,'');
  assert.equal(profile.identity,'');
  assert.equal(profile.soulMd,'');
});
test('legacy partial persona patches preserve other sections; unrelated patches preserve the exact document', () => {
  const profile = {instructions:'## 身份\nKeep identity\n\n## 风格\nKeep style'};
  assert.equal(mergeAgentInstructions(profile,{model:'next'}),profile.instructions);
  const edited=agentInstructionFields(mergeAgentInstructions(profile,{'soul.md':'New style'}));
  assert.equal(edited.identity,'Keep identity'); assert.equal(edited.soulMd,'New style');
  assert.equal(mergeAgentInstructions(profile,{instructions:''}),'');
});
test('project persona override is composed with the canonical global persona', () => {
  const agent=effectiveAgentProfile({agentProfiles:{main:{instructions:'## 身份\nKeep me\n\n## 风格\nOld style'}},projectAgentOverrides:{p:{main:{soulMd:'Project style'}}}},'main','p');
  assert.match(agent.instructions,/Keep me/); assert.match(agent.instructions,/Project style/); assert.doesNotMatch(agent.instructions,/Old style/);
});
