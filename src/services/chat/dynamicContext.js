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

const SELECTED_FILE_FULL_CONTEXT_CHARS = 3000;
const SELECTED_FILE_SNIPPET_CONTEXT_CHARS = 5200;
const SELECTED_FILE_SNIPPET_RADIUS = 10;
const SELECTED_FILE_MAX_SNIPPETS = 4;

const CONTEXT_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'file', 'review',
  'check', 'please', 'help', 'about', 'into', 'what', 'where', 'when',
  '怎么', '一下', '这个', '那个', '文件', '检查', '看看', '优化', '帮我',
]);

function tokenizeContextQuery(value = '') {
  const raw = String(value || '').toLowerCase();
  const tokens = raw.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set(tokens.filter(token => !CONTEXT_STOP_WORDS.has(token)))].slice(0, 24);
}

function scoreLineForQuery(line, tokens) {
  if (!tokens.length) return 0;
  const text = String(line || '').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    const first = text.indexOf(token);
    if (first < 0) continue;
    score += 4;
    if (/function|class|const|let|var|export|import|async|test|describe|it\(/.test(text)) {
      score += 2;
    }
    if (first < 12) score += 1;
  }
  return score;
}

function mergeLineRanges(ranges) {
  const sorted = ranges
    .filter(range => range && range.start <= range.end)
    .sort((left, right) => left.start - right.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function renderNumberedLineRange(lines, range) {
  return lines
    .slice(range.start, range.end + 1)
    .map((line, index) => `${range.start + index + 1}\t${line}`)
    .join('\n');
}

export function buildSelectedFileContextBlock(selectedFile, latestUserMessage = '') {
  if (!selectedFile) return '';
  const content = String(selectedFile.content || '');
  const path = selectedFile.path || '(unknown file)';
  const language = selectedFile.language || '';
  const header = [
    `Selected workspace file: ${path}`,
    selectedFile.truncated ? 'Note: the UI preview was already truncated before prompt assembly.' : '',
  ].filter(Boolean);

  if (!content || content.length <= SELECTED_FILE_FULL_CONTEXT_CHARS) {
    return [
      ...header,
      `\`\`\`${language}`,
      content,
      '```',
    ].join('\n');
  }

  const lines = content.split('\n');
  const tokens = tokenizeContextQuery(`${latestUserMessage}\n${path}`);
  const scored = lines
    .map((line, index) => ({ index, score: scoreLineForQuery(line, tokens) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const seedIndexes = scored.length
    ? scored.slice(0, SELECTED_FILE_MAX_SNIPPETS).map(item => item.index)
    : [0];

  const candidateRanges = seedIndexes.map(index => ({
    start: Math.max(0, index - SELECTED_FILE_SNIPPET_RADIUS),
    end: Math.min(lines.length - 1, index + SELECTED_FILE_SNIPPET_RADIUS),
  }));

  const ranges = mergeLineRanges(candidateRanges);
  const renderedRanges = [];
  let usedChars = 0;

  for (const range of ranges) {
    const rendered = renderNumberedLineRange(lines, range);
    if (renderedRanges.length && usedChars + rendered.length > SELECTED_FILE_SNIPPET_CONTEXT_CHARS) {
      break;
    }
    if (!renderedRanges.length && rendered.length > SELECTED_FILE_SNIPPET_CONTEXT_CHARS) {
      renderedRanges.push(rendered.slice(0, SELECTED_FILE_SNIPPET_CONTEXT_CHARS));
      break;
    }
    renderedRanges.push(rendered);
    usedChars += rendered.length;
  }

  return [
    ...header,
    `File context optimized for token budget: showing ${renderedRanges.length} excerpt(s) from ${lines.length} lines instead of the full ${content.length} characters.`,
    'If more context is needed, call file_read with a specific line range.',
    `\`\`\`${language}`,
    renderedRanges.join('\n\n...\n\n'),
    '```',
  ].join('\n');
}

export async function buildDynamicContext(state, chat, workspace, connectors, latestUserMessage = '') {
  const blocks = [];
  const threadContext = ensureChatThreadContext(chat, latestUserMessage);
  const renderedThreadContext = renderStructuredThreadContext(threadContext);

  if (renderedThreadContext) {
    blocks.push(renderedThreadContext);
  }

  if (connectors.some(connector => connector.id === 'local-files' && connector.enabled)) {
    if (workspace.selectedFile) {
      blocks.push(buildSelectedFileContextBlock(workspace.selectedFile, latestUserMessage));
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
