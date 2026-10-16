// Canonical persona document. Legacy fields are import/export adapters only.
const SECTIONS = Object.freeze([
  ['rolePrompt', '工作要求'], ['identity', '身份'],
  ['soulMd', '风格'], ['systemPrompt', '补充要求'],
]);
export function composeAgentInstructions(profile = {}) {
  return SECTIONS.map(([key, title]) => {
    const value = profile[key] ?? (key === 'identity' ? profile.identify : key === 'soulMd' ? profile['soul.md'] ?? profile.soul : '');
    return typeof value === 'string' && value.trim() ? `## ${title}\n${value.trim()}` : '';
  }).filter(Boolean).join('\n\n');
}
export function agentInstructionFields(instructions = '') {
  const result = Object.fromEntries(SECTIONS.map(([key]) => [key, '']));
  const sections = new Map(SECTIONS.map(([key, title]) => [title, key]));
  let field = 'rolePrompt';
  let fence=null;
  for (const line of String(instructions).split('\n')) {
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(fence) {
      result[field] += `${line}\n`;
      if(marker&&marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;
      continue;
    }
    if(marker&&(marker[1][0]!=='`'||!marker[2].includes('`'))) {
      fence={char:marker[1][0],length:marker[1].length};result[field] += `${line}\n`;continue;
    }
    const heading = line.match(/^## (工作要求|身份|风格|补充要求)$/);
    if (heading) { field = sections.get(heading[1]); continue; }
    result[field] += `${line}\n`;
  }
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.trim()]));
}
export function mergeAgentInstructions(profile = {}, patch = {}) {
  if (typeof patch.instructions === 'string') return patch.instructions;
  const fields = typeof profile.instructions === 'string' ? agentInstructionFields(profile.instructions) : profile;
  const changed = SECTIONS.some(([key]) => Object.hasOwn(patch, key)) || ['identify', 'soul.md', 'soul'].some(key => Object.hasOwn(patch, key));
  if (!changed && typeof profile.instructions === 'string') return profile.instructions;
  const merged = {...fields, ...patch};
  if (typeof patch.identify === 'string' && !Object.hasOwn(patch, 'identity')) merged.identity = patch.identify;
  if (!Object.hasOwn(patch, 'soulMd')) {
    if (typeof patch['soul.md'] === 'string') merged.soulMd = patch['soul.md'];
    else if (typeof patch.soul === 'string') merged.soulMd = patch.soul;
  }
  return composeAgentInstructions(merged);
}
