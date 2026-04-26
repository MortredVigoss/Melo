// Dynamic-context block assembly — sub-phase 7d-5β commit 3 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Composes the per-turn dynamic system-prompt section: structured thread
// context (continuity / memory snapshot), workspace file selection +
// snapshot, recent local-command output, and recent artifacts. All three
// upstream dependencies (ensureChatThreadContext, renderThreadContext,
// truncateText) live in dedicated leaf modules already.

import { ensureChatThreadContext } from '../../state/chatThreadContext.js';
import { renderThreadContext as renderStructuredThreadContext } from '../../memory/threadContext.js';
import { truncateText } from '../../shared/helpers.js';

export async function buildDynamicContext(state, chat, workspace, connectors, latestUserMessage = '') {
  const blocks = [];
  const threadContext = ensureChatThreadContext(chat, latestUserMessage);
  const renderedThreadContext = renderStructuredThreadContext(threadContext);

  if (renderedThreadContext) {
    blocks.push(renderedThreadContext);
  }

  if (connectors.some(connector => connector.id === 'local-files' && connector.enabled)) {
    if (workspace.selectedFile) {
      blocks.push(
        [
          `Selected workspace file: ${workspace.selectedFile.path}`,
          `\`\`\`${workspace.selectedFile.language}`,
          workspace.selectedFile.content,
          '```',
        ].join('\n'),
      );
    }

    if (workspace.entries.length) {
      blocks.push(
        `Workspace snapshot:\n${workspace.entries
          .slice(0, 28)
          .map(entry => `${entry.type === 'directory' ? 'dir' : 'file'}  ${entry.path}`)
          .join('\n')}`,
      );
    }
  }

  if (connectors.some(connector => connector.id === 'local-command' && connector.enabled)) {
    const projectRuns = state.commandRuns
      .filter(run => run.projectId === chat.projectId)
      .slice(0, 3);

    if (projectRuns.length) {
      blocks.push(
        `Recent local command output:\n${projectRuns
          .map(run => `- ${run.label}: ${truncateText(run.output || '(no output)', 320)}`)
          .join('\n')}`,
      );
    }
  }

  if (connectors.some(connector => connector.id === 'artifacts' && connector.enabled)) {
    const relatedArtifacts = state.artifacts
      .filter(artifact => artifact.chatId === chat.id || artifact.projectId === chat.projectId)
      .slice(0, 4);

    if (relatedArtifacts.length) {
      blocks.push(
        `Recent artifacts:\n${relatedArtifacts
          .map(artifact => `- ${artifact.title}: ${truncateText(artifact.summary, 180)}`)
          .join('\n')}`,
      );
    }
  }

  return blocks.filter(Boolean).join('\n\n');
}
