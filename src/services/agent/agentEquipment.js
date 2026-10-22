// What this install already has switched on — skills, MCP servers and
// external connectors. Agents start with all of it (user decision 2026-10-22:
// "之前配备好的都给她默认就用上"); each Agent's whitelists in the editor stay
// the way to add or remove items later.
import { buildSkills } from '../../domain/skill/skillService.js';
import { usableMcpServerIds } from '../../mcp/presets.js';

/**
 * @param {object} state   desktop state (settings + externalConnectors)
 * @param {object} config  loaded config (MCP preset flags + mcpServers)
 * @returns {{skills: string[], mcpServers: string[], connectors: string[]}}
 */
export function installedEquipment(state, config) {
  const enabledSkillIds = state?.settings?.enabledSkillIds || [];
  const enabledConnectorIds = state?.settings?.enabledConnectorIds || [];
  return {
    skills: buildSkills(enabledSkillIds, state?.settings?.customSkills).filter(skill => skill.enabled).map(skill => skill.id),
    mcpServers: usableMcpServerIds(config),
    connectors: (state?.externalConnectors || []).filter(connector => enabledConnectorIds.includes(connector.id)).map(connector => connector.id),
  };
}
