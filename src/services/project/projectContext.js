// Project context block for the system prompt — sub-phase 7d-5β of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5). Single
// dependency on `agentUsesTool` is satisfied via the agentTools service
// (already a leaf in src/services/agent/).

import {projectText} from '../../domain/project/projectService.js';
export function buildProjectContextSection(project,activeAgentProfile) {
  if (!project || activeAgentProfile?.contextSources?.projects===false) return '';
  const summary=projectText(project.summary),instructions=projectText(project.instructions);
  return [`Active project: ${project.name}`,summary?`Summary: ${summary}`:'',project.workspacePath?`Workspace: ${project.workspacePath}`:'',instructions?`Instructions: ${instructions}`:''].filter(Boolean).join('\n');
}
