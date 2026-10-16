import {buildProjectContextSection} from '../project/projectContext.js';
// Task execution prompt builder — sub-phase 7d-5δ commit 4 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Composes the user-facing prompt body the worker model receives when
// the task graph invokes it. Pure function: takes a task record + the
// resolved project / workspace snapshot / agent profile and returns a
// formatted string. The single dependency (`agentUsesTool`) is already
// in a leaf module.

import { agentUsesTool } from '../../domain/agent/agentTools.js';

export function taskExecutionPrompt(task, project, workspace, profile) {
  const blocks = [
    `Task title: ${task.title}`,
    task.summary ? `Task summary: ${task.summary}` : '',
    project && agentUsesTool(profile, 'projects')
      ? buildProjectContextSection(project, profile)
      : 'Project: (none)',
    workspace.selectedFile && agentUsesTool(profile, 'local-files')
      ? [
          `Selected file: ${workspace.selectedFile.path}`,
          `\`\`\`${workspace.selectedFile.language}`,
          workspace.selectedFile.content.slice(0, 4000),
          '```',
        ].join('\n')
      : '',
    workspace.entries.length && agentUsesTool(profile, 'local-files')
      ? `Workspace snapshot:\n${workspace.entries
          .slice(0, 24)
          .map(entry => `${entry.type === 'directory' ? 'dir' : 'file'}  ${entry.path}`)
          .join('\n')}`
      : '',
    task.latestNote ? `Previous note:\n${task.latestNote}` : '',
    'Respond with a concise worker update, concrete findings, and next action.',
  ].filter(Boolean);

  return blocks.join('\n\n');
}
