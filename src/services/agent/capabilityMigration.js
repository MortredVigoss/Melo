import {buildSkills} from '../../domain/skill/skillService.js';
import {getAllTools} from '../../tools/registryCore.js';
import {createHash} from 'node:crypto';
import {migrateLegacyCapabilities,toolCapabilityAllowed} from '../../domain/agent/capabilities.js';
export function capabilityMigrationPreview(profile,options={}) {
  const proposed=migrateLegacyCapabilities(profile,options);
  const input={id:profile.id,tools:profile.tools,enabledSkillIds:profile.enabledSkillIds,enabledConnectorIds:profile.enabledConnectorIds,enabledMcpServerIds:profile.enabledMcpServerIds,proposed};
  return {fingerprint:createHash('sha256').update(JSON.stringify(input)).digest('hex'),proposed,
    lostTools:(options.tools||[]).filter(t=>!t.id.startsWith('mcp:')&&!toolCapabilityAllowed(t.id,proposed)).map(t=>t.id),
    lostActions:['image.generate','pdf.write','clipboard.write','knowledge.index'].filter(action=>{const [id,name]=action.split('.');return !toolCapabilityAllowed(id,proposed,{action:name});}),
    note:'旧开关此前仅影响上下文。确认后能力在执行时生效；生成媒体和委派需要单独开启。MCP 与技能仅允许所列对象。'};
}

export function migrationOptions(state) { return {skills:buildSkills(state.settings?.enabledSkillIds,state.settings?.customSkills),connectors:state.externalConnectors || [],tools:getAllTools()}; }

// Explicitly invoked by the user-approved migration command; never during hydration.
export function migrateAllCapabilities(state) {
  const report=[];
  const options=migrationOptions(state);
  const globals=state.agentProfiles || {};
  for (const [id,profile] of Object.entries(globals)) {
    if (profile.capabilities) continue;
    const preview=capabilityMigrationPreview({...profile,id},options);
    report.push({scope:'global',id,...preview});
    profile.capabilities=preview.proposed;
  }
  for (const [projectId,overrides] of Object.entries(state.projectAgentOverrides || {})) {
    for (const [id,profile] of Object.entries(overrides)) {
      if (profile.capabilities) continue;
      // A sparse override inherits the global legacy selection before conversion.
      const preview=capabilityMigrationPreview({...globals[id],...profile,id},options);
      report.push({scope:'project',projectId,id,...preview});profile.capabilities=preview.proposed;
    }
  }
  return report;
}
