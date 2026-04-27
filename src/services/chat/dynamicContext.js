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
import { isLiveArtifact } from '../artifact/artifactService.js';

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
    // Soft-deleted artifacts must not bleed into the model's prompt
    // context.  isLiveArtifact gates that boundary; without it, an
    // artifact the user just deleted (and whose row is hidden in the
    // UI) would still show up in the next turn's "recent artifacts"
    // block — privacy regression flagged in the 2026-04-27 Codex C
    // post-push review.
    const relatedArtifacts = state.artifacts
      .filter(artifact =>
        isLiveArtifact(artifact) &&
        (artifact.chatId === chat.id || artifact.projectId === chat.projectId),
      )
      .slice(0, 4);

    if (relatedArtifacts.length) {
      // Artifact records have a `content` field but no separate `summary`
      // — earlier code read `artifact.summary` here and silently fed
      // `undefined` into the prompt. Truncate the actual content (the
      // body the user sees in the panel) to keep the prompt-context line
      // grounded in real text.
      blocks.push(
        `Recent artifacts:\n${relatedArtifacts
          .map(artifact => `- ${artifact.title}: ${truncateText(artifact.content || '', 180)}`)
          .join('\n')}`,
      );
    }
  }

  return blocks.filter(Boolean).join('\n\n');
}
