// Task agent execution graph runner — sub-phase 7d-5δ commit 6 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Owns the worker-task variant of the agent execution graph: a tiny
// two-node graph (prepare-task → invoke-task-model → END) used by the
// desktop task-runner and the chat graph's "execute task" approval
// handler. The chat-side runner is bigger and lives in its own module
// (the upcoming commit 7 of this phase, runChatAgentExecutionGraph).
//
// Every upstream dependency this function touches now lives in a
// dedicated leaf module — that was the entire point of commits 1-5 of
// this phase. Nothing here imports from `src/desktopStore.js`, so the
// runner can move out without an import cycle.

import {
  GRAPH_END,
  createStateGraph,
  runStateGraph,
} from '../../agentGraph.js';
import { findProjectById } from '../../state/stateLookups.js';
import { effectiveAgentProfile } from '../../state/agentProfiles.js';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshot.js';
import { taskExecutionPrompt } from '../task/taskPrompt.js';
import { normalizeTasks } from '../../domain/task/taskService.js';
import { normalizeApprovals } from '../../domain/approval/approvalService.js';
import { normalizeConversationSnippet } from '../../memory/heuristics.js';
import { buildToolRoutingPrompt } from '../agent/toolRoutingPrompt.js';
import { buildProjectContextSection } from '../project/projectContext.js';
import { buildReActSystemPrompt } from './systemPrompt.js';
import { createOpenAICompatibleReply } from '../../openai.js';

export async function runTaskAgentExecutionGraph({
  state,
  config,
  task,
}) {
  const graph = createStateGraph({
    start: 'prepare-task',
    nodes: {
      // ── prepare-task ───────────────────────────────────────────────────────
      // Combines the old resolve-task-agent / recall-task-memory /
      // compose-task-prompt nodes. The only real async work is the workspace
      // snapshot; everything else is sync and runs immediately after.
      async 'prepare-task'() {
        const project = findProjectById(state, task.projectId);
        const workspace = await buildWorkspaceSnapshot(state, project);
        const profile = effectiveAgentProfile(state, task.owner, project?.id || null);
        const taskPrompt = taskExecutionPrompt(task, project, workspace, profile);

        const siblingTasks = normalizeTasks(state.tasks)
          .filter(
            entry =>
              entry.id !== task.id &&
              (entry.projectId === project?.id || entry.owner === task.owner),
          )
          .slice(0, 3);
        const pendingApprovals = normalizeApprovals(state.approvals)
          .filter(
            approval =>
              approval.status === 'pending' &&
              (approval.projectId === project?.id || approval.chatId === task.chatId),
          )
          .slice(0, 3);

        const memoryContext = [
          siblingTasks.length
            ? `Worker memory nodes:\n${siblingTasks
                .map(
                  entry =>
                    `- ${entry.title} [${entry.status}]${
                      entry.latestNote
                        ? ` :: ${normalizeConversationSnippet(entry.latestNote, 140)}`
                        : ''
                    }`,
                )
                .join('\n')}`
            : '',
          pendingApprovals.length
            ? `Pending approvals:\n${pendingApprovals.map(a => `- ${a.title}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        const toolRoutingPrompt = buildToolRoutingPrompt({ activeAgentProfile: profile, agentConnectors: [] });
        const systemPrompt = buildReActSystemPrompt({
          config,
          profile,
          modePrompt: 'Keep the answer structured, execution-oriented, and suitable for a desktop task lane.',
          projectContext: buildProjectContextSection(project, profile),
          memoryContext,
          toolRoutingPrompt,
          dynamicContext: '',
          kind: 'task',
          isRemoteChannel: false,
        });

        return { profile, systemPrompt, taskPrompt, next: 'invoke-task-model' };
      },

      // ── invoke-task-model ──────────────────────────────────────────────────
      async 'invoke-task-model'(graphState) {
        const reply = await createOpenAICompatibleReply({
          authMode: config.authMode,
          apiProtocol: config.apiProtocol,
          apiKey: config.activeLlmProfileId ? config.apiKey : process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || config.apiKey,
          baseUrl: config.activeLlmProfileId ? config.baseUrl : process.env.MELO_BASE_URL || process.env.OPENAI_BASE_URL || config.baseUrl,
          model: config.activeLlmProfileId ? config.model : process.env.MELO_MODEL || graphState.profile.model || config.model,
          systemPrompt: graphState.systemPrompt,
          messages: [{ role: 'user', content: graphState.taskPrompt }],
        });

        return { reply, next: GRAPH_END };
      },
    },
  });

  return runStateGraph(graph, { state, config, task });
}
