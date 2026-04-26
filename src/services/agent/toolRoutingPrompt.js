// Tool-routing system-prompt block — sub-phase 7d-5γ commit 2 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Composes the agent-facing system-prompt section that lists available
// approval-gated tools (curated local commands + external MCP connector
// tools). Both upstream deps (`agentUsesTool` and `COMMAND_TEMPLATES`)
// already live in dedicated leaf modules — this is a true zero-LOCAL
// extraction.

import { agentUsesTool } from './agentTools.js';
import { COMMAND_TEMPLATES } from '../command/commandTemplates.js';

export function buildToolRoutingPrompt({ activeAgentProfile, agentConnectors = [] }) {
  const blocks = ['Tool routing rules:'];

  if (agentUsesTool(activeAgentProfile, 'local-command')) {
    blocks.push(
      `- Curated local commands are available but must go through approval first: ${COMMAND_TEMPLATES.map(
        entry => `${entry.label} (${entry.id})`,
      ).join(', ')}`,
    );
  }

  const externalTools = agentConnectors
    .filter(connector => connector.type === 'external-mcp' && connector.enabled)
    .flatMap(connector =>
      (connector.manifest?.tools || []).map(tool => `${connector.name} / ${tool.name}`),
    );

  if (externalTools.length) {
    blocks.push(
      `- External connector tools are available but must go through approval first: ${externalTools.join(
        ', ',
      )}`,
    );
  }

  if (blocks.length === 1) {
    return '';
  }

  blocks.push(
    '- If the user explicitly asks to run a command or connector tool, prefer creating an approval request instead of pretending it already ran.',
  );
  return blocks.join('\n');
}
