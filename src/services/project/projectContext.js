// Project context block for the system prompt — sub-phase 7d-5β of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5). Single
// dependency on `agentUsesTool` is satisfied via the agentTools service
// (already a leaf in src/services/agent/).

import { agentUsesTool } from '../../domain/agent/agentTools.js';

export function buildProjectContextSection(project, activeAgentProfile) {
  return project && activeAgentProfile?.contextSources?.projects !== false
    ? `Active project: ${project.name}\nSummary: ${project.summary}\nWorkspace: ${project.workspacePath}\nInstructions: ${project.instructions}`
    : '';
}
