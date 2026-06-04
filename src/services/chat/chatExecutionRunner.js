// Chat agent execution graph runner — sub-phase 7d-5δ commit 7b of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Owns the chat-side variant of the agent execution graph: a three-node
// pipeline (prepare → invoke-model → finalize) that drives Melo's main
// conversational loop. Used by the desktop chat panel, sendChatMessage,
// the Telegram / Discord bridges, and the approval-execution path.
//
// All upstream dependencies live in dedicated leaf modules (every other
// 7d-5* commit was prep work for exactly this — the runner imports zero
// symbols from desktopStore.js). The lone module-private singleton
// `getSharedSkillIndex` is also co-located here: its sole caller was
// always this runner, and Node's module cache keeps the singleton stable.

import { randomUUID } from 'node:crypto';
import {
  GRAPH_END,
  createStateGraph,
  runStateGraph,
} from '../../agentGraph.js';
import { nowIso } from '../../shared/helpers.js';
import { findProjectById } from '../../state/stateLookups.js';
import { effectiveAgentProfile } from '../../state/agentProfiles.js';
import { saveState } from '../../state/stateStore.js';
import {
  filterConnectorsForAgent,
  filterSkillsForAgent,
  filterMcpToolsForAgent,
  createSharedSkillIndexFactory,
} from '../agent/agentTools.js';
import { buildAgentMemoryNodeContext } from '../agent/agentMemoryContext.js';
import { buildToolRoutingPrompt } from '../agent/toolRoutingPrompt.js';
import { buildChannelRoutePrompt } from '../remote/channelRoutePrompt.js';
import { buildMatcherContextFromChat } from './matcherContext.js';
import { buildModelMessagesFromChat } from './messageBuilder.js';
import { tryImageEditFastPath } from './imageEditFastPath.js';
import { formatModelMessageForVisionDebug } from './visionDebug.js';
import { buildDynamicContext } from './dynamicContext.js';
import {
  planChatGraphAction,
  buildApprovalResponse,
} from './chatActionPlanning.js';
import {
  buildReActSystemPrompt,
  buildLanguageConstraint,
} from './systemPrompt.js';
import { MODE_DEFS } from './modeDefs.js';
import { summarizeConnectorPrompts } from '../connector/connectorPrompts.js';
import { summarizeSkillsPrompts } from '../skill/skillPrompts.js';
import { listExecutableSkills } from '../skill/skillService.js';
import { buildProjectContextSection } from '../project/projectContext.js';
import {
  normalizeApproval,
  normalizeApprovals,
} from '../approval/approvalService.js';
import { normalizeAssistantReplyForConversation } from '../message/messageBlocks.js';
import {
  buildVizSpecInstructions,
  extractVizSpec,
} from '../viz/vizSpec.js';
import {
  buildCitationInstructions,
  extractCitations,
} from '../viz/citation.js';
import {
  buildSkillIndex,
  defaultSkillMatchCache,
  matchSkillsForMessage,
} from '../../agents/skillMatcher.js';
import { getSkillLastRunMap } from '../../agents/skillRuns.js';
import { buildSkillTool } from '../../agents/skillExecutor.js';
import { getEmbedding } from '../../memory/embeddings.js';
import {
  shouldCompact,
  compactConversation,
  formatCompactContextBlock,
} from '../../memory/contextCompact.js';
import { formatSessionMemoryBlock } from '../../memory/sessionMemory.js';
import {
  classifyIntent,
  intentRequiresVerification,
} from '../../retrieval/intentRouter.js';
import {
  parseUncertaintyMarker,
  verifyUncertainClaim,
  applyVerificationToReply,
} from '../../retrieval/selfVerification.js';
import {
  buildSearchPlan,
  buildSearchRoutingPrompt,
  filterToolsForSearchPlan,
} from '../../retrieval/searchRouter.js';
import {
  buildToolsSystemPrompt,
  shouldInjectToolsPrompt,
} from '../../tools/systemPrompt.js';
import { parseModelResponse, formatToolResultsMessage } from '../../tools/parser.js';
import { projectToolResultForPersist, deriveUnifiedErrorCode } from './toolResultProjection.js';
import { getTool, getAllTools } from '../../tools/registry.js';
import { executeToolCalls } from '../../tools/executor.js';
import { createOpenAICompatibleReply } from '../../openai.js';

// `getSharedSkillIndex(skills)` — module-private factory bound to the
// `buildSkillIndex` implementation imported above. It returns a stable
// per-skill-list cache so repeated turns over the same skill set don't
// re-index every time. The factory was originally module-private to
// desktopStore; moving it here keeps the singleton scoped to its sole
// caller (this runner). Node's module cache keeps the binding stable
// across imports.
const getSharedSkillIndex = createSharedSkillIndexFactory({ buildSkillIndex });

export async function runChatAgentExecutionGraph({
  config,
  state,
  chat,
  workspace,
  connectors,
  skills,
  latestUserMessage,
  agentId,
  background = false,
  channelContext = null,
  signal,
  onDelta,
  onReasoningDelta,
  sseEmitter,
  providerProfile = 'default',
  demonMode = false,
}) {
  const isRemoteChannel = background && Boolean(channelContext?.channelId);
  // Demon viz-spec is a desktop-only feature. Telegram / Discord don't render
  // visualizations, so we drop the flag on remote channels to guarantee the
  // system prompt additions and the post-reply parse both stay off.
  const vizEnabled = Boolean(demonMode) && !isRemoteChannel;

  const graph = createStateGraph({
    start: 'prepare',
    nodes: {
      // ── prepare ────────────────────────────────────────────────────────────
      // Combines the old classify-intent / resolve-agent / resolve-channel-route
      // / recall-memory / collect-observations / plan-actions /
      // compose-system-prompt nodes into a single parallel-aware step.
      //
      // Execution order:
      //   1. Sync setup (fast, <1 ms each): resolve agent, channel, memory recall
      //   2. Promise.all: classifyIntent + buildDynamicContext run concurrently
      //      – classifyIntent may make a fast API call (rule-based first, API only
      //        for ambiguous messages)
      //      – buildDynamicContext reads workspace files / connectors
      //   3. Inline: plan-actions, optional queue-approval (early exit), then
      //      compose final system prompt
      async 'prepare'() {
        // ── 1. Sync setup ──────────────────────────────────────────────────
        const modeDef = MODE_DEFS.find(mode => mode.id === chat.mode) || MODE_DEFS[0];
        const project = findProjectById(state, chat.projectId);
        const activeAgentProfile = effectiveAgentProfile(state, agentId, project?.id || null);
        const agentConnectors = filterConnectorsForAgent(connectors, activeAgentProfile);
        const agentScopedSkills = filterSkillsForAgent(skills, activeAgentProfile);
        // Phase 3.2.2 — rule-based pre-filter. Shrinks both the system prompt
        // and the tool loop by keeping only skills whose triggers/tags/name
        // match the current user message. Skills with no metadata, built-ins,
        // and skills tagged `always-on` pass through unconditionally, so no
        // regression vs the old behavior unless a custom-skill author has
        // explicitly opted in to triggers/tags.
        // Multi-turn context — weight the newest 3 user/assistant messages
        // so intent that lived in a previous turn ("please also save to
        // word") still boosts the right skills on a short follow-up.
        const matcherContext = buildMatcherContextFromChat(chat, latestUserMessage);
        const skillIndex = getSharedSkillIndex(agentScopedSkills);
        const recencyByIdMap = getSkillLastRunMap({ windowDays: 30 });
        const enabledSkills = matchSkillsForMessage(agentScopedSkills, matcherContext, {
          skillIndex,
          cache: defaultSkillMatchCache,
          recencyByIdMap,
        });
        const channelPrompt = buildChannelRoutePrompt({ chat, channelContext, profile: activeAgentProfile });

        // Compute query embedding for semantic recall (null if no backend available).
        // Fast (~50ms ollama, <100ms OpenAI); never blocks if unavailable.
        const queryEmbedding = await getEmbedding(latestUserMessage, config).catch(() => null);

        // SQLite recall — uses KNN when embedding available, keyword scoring otherwise.
        const memoryContext = buildAgentMemoryNodeContext({
          state,
          chat,
          latestUserMessage,
          activeAgentProfile,
          project,
          queryEmbedding,
        });
        const toolRoutingPrompt = buildToolRoutingPrompt({ activeAgentProfile, agentConnectors });

        // Sync context assembly (remote channels skip project/connector detail
        // but DO get a lean skills summary — the desktop owner's skills should
        // be usable from Telegram/Discord as well).
        const projectContext = isRemoteChannel ? '' : buildProjectContextSection(project, activeAgentProfile);
        const connectorPrompts = isRemoteChannel ? '' : summarizeConnectorPrompts(agentConnectors);
        const skillsPrompts = summarizeSkillsPrompts(enabledSkills, { remote: isRemoteChannel });
        const modelMessages = buildModelMessagesFromChat(chat);
        const searchPlan = buildSearchPlan({
          latestUserMessage,
          modelMessages,
          authMode: config.authMode,
        });

        // ── 2. Async fan-out ───────────────────────────────────────────────
        // classifyIntent and buildDynamicContext are the only two operations
        // that genuinely await I/O; run them concurrently to eliminate the
        // sequential stall that previously added one full round-trip before
        // invoke-model could start.
        const [intent, dynamicContext] = await Promise.all([
          classifyIntent(latestUserMessage, { config, signal }),
          isRemoteChannel
            ? Promise.resolve('')
            : buildDynamicContext(state, chat, workspace, agentConnectors, latestUserMessage),
        ]);

        // ── 3. Plan actions (needs agentConnectors resolved above) ─────────
        const plannedAction = planChatGraphAction({
          latestUserMessage,
          activeAgentProfile,
          agentConnectors,
          chat,
        });

        if (plannedAction?.requiresApproval) {
          const approval = normalizeApproval({
            id: randomUUID(),
            kind: plannedAction.kind,
            title: plannedAction.title,
            description: plannedAction.description,
            payload: plannedAction.payload,
            projectId: chat.projectId || null,
            chatId: chat.id,
            status: 'pending',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
          state.approvals.unshift(approval);
          state.approvals = normalizeApprovals(state.approvals);
          await saveState(state);

          return {
            normalizedReply: normalizeAssistantReplyForConversation(
              buildApprovalResponse(plannedAction, approval),
              { channelKind: isRemoteChannel ? 'remote' : 'desktop' },
            ),
            next: GRAPH_END,
          };
        }

        // ── 4. Auto-compact check ─────────────────────────────────────────
        // Runs for ALL channels once history exceeds COMPACT_TRIGGER_TOKENS
        // (~80K). Previously remote/Telegram were skipped to avoid adding
        // latency; in practice that meant long-running Telegram bots lost
        // all historical context beyond the 60K sliding window. The compact
        // only fires on genuinely large histories and the MAX_COMPACT_FAILURES
        // circuit breaker still guards against a hot-loop of failed summaries.
        const allChatMessages = Array.isArray(chat.messages) ? chat.messages : [];
        const hasModelConfig = Boolean(
          config.authMode === 'codex' ||
          config.apiKey ||
          (config.authMode === 'local' && config.baseUrl),
        );

        if (hasModelConfig &&
            shouldCompact(allChatMessages, chat.compactFailures || 0)) {
          try {
            const summary = await compactConversation(allChatMessages, { config, signal });
            if (summary) {
              // Pin the compact boundary to the last message currently in history.
              const lastMsg = allChatMessages[allChatMessages.length - 1];
              chat.compactSummary = summary;
              chat.compactBoundaryMessageId = lastMsg?.id || '';
              chat.compactedMessageCount = allChatMessages.length;
              chat.compactedAt = new Date().toISOString();
              chat.compactFailures = 0;
              // Persist so the summary survives restarts.
              await saveState(state);
            } else {
              chat.compactFailures = (chat.compactFailures || 0) + 1;
            }
          } catch {
            chat.compactFailures = (chat.compactFailures || 0) + 1;
          }
        }

        // ── 5. Assemble system prompt ──────────────────────────────────────
        const compactContext = chat.compactSummary
          ? formatCompactContextBlock(chat.compactSummary, chat.compactedMessageCount || 0)
          : '';

        // Build per-request skill tools for all enabled executable skills this
        // agent has access to. They are NOT registered globally — we pass them
        // through graph state so the invoke-model loop can resolve them by
        // name alongside the registry. This keeps concurrent chats isolated
        // (each chat sees only its own agent's skills).
        const skillTools = listExecutableSkills(enabledSkills)
          .map(buildSkillTool)
          .filter(Boolean);

        // Build tools system prompt — remote channels now get all tools.
        // Stdio MCP tools (`mcp:<server>:<tool>`) are gated by the agent's
        // enabledMcpServerIds whitelist; the default is deny-all so a new
        // agent can't call any MCP without explicit opt-in.  Non-MCP tools
        // pass through filterMcpToolsForAgent untouched.
        let toolsPrompt = buildSearchRoutingPrompt(searchPlan);
        let visibleToolIds = new Set();
        if (shouldInjectToolsPrompt({ mode: chat.mode })) {
          // prepare scope owns the local `activeAgentProfile` (line 150);
          // graphState doesn't exist here (only invoke-model gets that).
          const allowedTools = filterMcpToolsForAgent(getAllTools(), activeAgentProfile);
          const routedTools = filterToolsForSearchPlan(allowedTools, searchPlan);
          const promptTools = [...routedTools, ...skillTools];
          visibleToolIds = new Set(promptTools.map(tool => tool.id).filter(Boolean));
          toolsPrompt = [
            toolsPrompt,
            buildToolsSystemPrompt(promptTools),
          ].filter(Boolean).join('\n\n');
        }

        // Session memory block — inject top extracted facts
        const sessionMemoryBlock = formatSessionMemoryBlock(chat.sessionMemory || []);

        const vizInstructions = buildVizSpecInstructions({
          enabled: vizEnabled,
          isRemoteChannel,
        });

        // Source citations (NotebookLM-style pins). Gated on the same Demon
        // toggle as viz; additionally requires the active project to have
        // at least one workspace file so the model has something real to
        // cite. `workspace` is already loaded earlier in the graph.
        const hasProjectFiles =
          !isRemoteChannel &&
          Array.isArray(workspace?.filePaths) &&
          workspace.filePaths.length > 0;
        const citationInstructions = buildCitationInstructions({
          enabled: vizEnabled,
          isRemoteChannel,
          hasProjectFiles,
        });

        const systemPrompt = buildReActSystemPrompt({
          config,
          profile: activeAgentProfile,
          modePrompt: modeDef.prompt,
          projectContext,
          channelPrompt,
          memoryContext,
          toolRoutingPrompt,
          connectorPrompts,
          skillsPrompts,
          dynamicContext,
          compactContext,
          toolsPrompt,
          sessionMemoryBlock,
          languageConstraint: buildLanguageConstraint(latestUserMessage),
          vizInstructions,
          citationInstructions,
          kind: 'chat',
          isRemoteChannel,
          intent,
        });

        return {
          intent,
          systemPrompt,
          modelMessages,
          memoryContext,
          dynamicContext,
          projectContext,
          activeAgentProfile,
          skillTools,
          searchPlan,
          visibleToolIds: [...visibleToolIds],
          next: 'invoke-model',
        };
      },

      // ── invoke-model ───────────────────────────────────────────────────────
      // Implements a ReAct tool loop:
      //   1. Call model with current messages
      //   2. Parse response for <tool_call> blocks
      //   3. If tool calls exist: execute them, append results, loop (max 10)
      //   4. If no tool calls (or max iterations reached): proceed to finalize
      async 'invoke-model'(graphState) {
        if (process.env.MELO_DEBUG_VISION === '1') {
          for (const [index, message] of graphState.modelMessages.entries()) {
            process.stdout.write(`${formatModelMessageForVisionDebug(message, index)}\n`);
          }
        }

        // ── Image-edit fast path ──────────────────────────────────────────────
        // Short-circuit the agent ReAct loop when the user has uploaded an
        // image AND clearly asked to edit it (Codex auth + workspace required).
        // The dedicated two-stage pipeline (vision analysis → image edit) runs
        // OUTSIDE the agent system prompt so the model isn't drowning in
        // memory/project/retrieval context while trying to edit an image.
        // See imageEditFastPath.js for the gating + pipeline. Failures /
        // gate misses return null; we fall through to the normal loop and
        // the agent decides what to do (apologise, re-route, etc.).
        const fastPathReply = await tryImageEditFastPath({
          config,
          messages: graphState.modelMessages,
          workspace,
          signal,
          onDelta,
          sseEmitter,
        });
        if (typeof fastPathReply === 'string' && fastPathReply.trim()) {
          return { reply: fastPathReply, next: 'finalize' };
        }

        const MAX_TOOL_ITERATIONS = 10;
        // Running message list for the tool loop — starts from the prepared window.
        let loopMessages = [...graphState.modelMessages];
        let finalReply = '';
        // G-1d slice 2 (2026-05-12): accumulate per-tool-call structured
        // metadata across loop iterations so the persisted assistant
        // message can carry the evidenceTrail history of all tools that
        // ran while producing this reply.  Without this, the trail dies
        // when activeToolCalls is filtered out 1.8s after completion
        // (G-1f window) — users翻 chat history 看不到当时哪条 tier 失败了.
        // Each entry: { toolCallId, toolName, ok, evidenceTrail? }.
        const accumulatedToolResults = [];

        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
          // On subsequent iterations, we're streaming "thinking" not the final
          // reply, so suppress onDelta to avoid emitting partial tool-loop text.
          const isFirstIteration = iteration === 0;

          const rawReply = await createOpenAICompatibleReply({
            authMode: config.authMode,
            apiKey: process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || config.apiKey,
            baseUrl: process.env.MELO_BASE_URL || process.env.OPENAI_BASE_URL || config.baseUrl,
            model: process.env.MELO_MODEL || graphState.activeAgentProfile.model || config.model,
            systemPrompt: graphState.systemPrompt,
            messages: loopMessages,
            signal,
            onDelta: isFirstIteration ? onDelta : undefined,
            onReasoningDelta: isFirstIteration ? onReasoningDelta : undefined,
            providerProfile,
            // Workspace path enables inline image generation through the
            // Codex OAuth chat stream (createCodexResponsesReply adds the
            // image_generation tool when this is truthy and writes the
            // resulting bytes into <workspace>/generated/). For non-Codex
            // providers this parameter is currently ignored.
            //
            // DESIGN INTENT (user 2026-04-29): always-on for every chat /
            // every agent profile when the workspace exists. We intentionally
            // do NOT gate this on the agent's `image` allowedTools entry —
            // Codex inline image is a free Plus-bucket server capability
            // (same model as native web_search), not a melo-owned tool.
            // Codex review of the first cut flagged this as a possible
            // privilege bypass; the override is recorded in subAgent.js's
            // matching block.
            workspacePath: workspace?.rootPath || null,
            nativeWebSearchEnabled: graphState.searchPlan?.nativeWebSearchEnabled === true,
          });

          const { thinking, toolCalls } = parseModelResponse(rawReply);

          // No tool calls → this is the final response
          if (!toolCalls.length) {
            finalReply = rawReply;
            break;
          }

          // Emit SSE event so the UI can show tool execution status
          if (typeof sseEmitter === 'function') {
            sseEmitter('tool_calls_start', {
              iteration,
              calls: toolCalls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments })),
            });
          }

          // Resolve tool objects: first check per-request skill tools built
          // in prepare (scoped to this agent), then fall back to the global
          // registry. Skill tools are prefixed `skill:` so they cannot
          // collide with regular tool ids.
          const skillToolsById = new Map(
            (graphState.skillTools || []).map(t => [t.id, t]),
          );
          const visibleToolIds = new Set(graphState.visibleToolIds || []);
          // Defence-in-depth: even though the prompt-level filter
          // already hides non-whitelisted MCP tools, a hallucinated
          // `mcp:<server>:<tool>` call must not slip through to the
          // dispatcher.  filterMcpToolsForAgent(...) returns the
          // allowed tools; we drop any tool call whose target was
          // filtered out.
          //
          // Phase 6 follow-up (2026-05-05): use `graphState.activeAgentProfile`
          // — `activeAgentProfile` was a bare reference to the variable
          // declared in the `'prepare'` node at line 150, which is a
          // separate async-method scope. Bare reference threw
          // ReferenceError "activeAgentProfile is not defined" the
          // moment the model emitted any tool call (text-only replies
          // skipped this branch and stayed silent). User-facing surface
          // was the providerErrors fallback "Melo could not complete
          // the model request right now. Details: …". Same fact also
          // accessible at lines 407 / 580 of this file via graphState.
          const allowedDispatchTools = new Set(
            filterMcpToolsForAgent(getAllTools(), graphState.activeAgentProfile).map(t => t.id),
          );
          const executableCalls = toolCalls.map(tc => {
            let tool = skillToolsById.get(tc.name) || getTool(tc.name);
            if (tool && !visibleToolIds.has(tool.id)) {
              tool = null;
            }
            if (tool && tool.id?.startsWith('mcp:') && !allowedDispatchTools.has(tool.id)) {
              tool = null;
            }
            return { id: tc.id, tool, args: tc.arguments, callRef: tc };
          });

          // Execute all calls (serial/parallel as per tool.isConcurrencySafe)
          const execResults = await executeToolCalls(
            executableCalls.filter(c => c.tool !== null),
            {
              sseEmitter,
              workspacePath: workspace?.rootPath,
              signal,
              chatId: chat.id,
              config,
              agentDepth: 0,
              onOutput: typeof sseEmitter === 'function'
                ? chunk => sseEmitter('tool_output', { chunk })
                : undefined,
            },
          );

          // Also handle unresolved tool names (not in registry)
          const allResults = toolCalls.map(tc => {
            const found = execResults.find(r => r.id === tc.id);
            if (found) return { call: tc, result: found.result };
            return {
              call: tc,
              result: {
                ok: false,
                output: `Unknown tool: "${tc.name}". Available tools: ${
                  [...visibleToolIds].filter(Boolean).join(', ') || 'none'
                }`,
                error: 'UNKNOWN_TOOL',
              },
            };
          });

          // Emit SSE with results for UI.  G-1d slice 1.5 (2026-05-11):
          // forward `evidenceTrail` to the UI so devtools / debug overlay can
          // inspect which fallback tiers a search tool walked through.  Only
          // attach when a non-empty array was produced (slice 1 invariant
          // from executor.js).  Trail items are small JSON objects — no
          // need to truncate like `output`.
          if (typeof sseEmitter === 'function') {
            sseEmitter('tool_calls_done', {
              iteration,
              results: allResults.map(({ call, result }) => {
                const item = {
                  id: call.id,
                  name: call.name,
                  ok: result.ok,
                  output: result.output?.slice(0, 500), // truncate for SSE
                };
                if (Array.isArray(result.evidenceTrail) && result.evidenceTrail.length > 0) {
                  item.evidenceTrail = result.evidenceTrail;
                }
                // 2026-05-23 架构 audit #2 闭环: forward the unified
                // errorCode (SearchTask taxonomy) on the same debug channel
                // as evidenceTrail, so the live devtools overlay sees the
                // precise failure classification. Additive; null when N/A.
                const errorCode = deriveUnifiedErrorCode(call, result);
                if (errorCode) {
                  item.errorCode = errorCode;
                }
                return item;
              }),
            });
          }

          // Append assistant turn (thinking + tool calls) and tool results
          loopMessages = [
            ...loopMessages,
            { role: 'assistant', content: rawReply },
            {
              role: 'user',
              content: formatToolResultsMessage(allResults),
            },
          ];

          // G-1d slice 2: accumulate structured tool-result metadata for
          // persistence on the eventual assistantMessage.  Projection
          // logic lives in `./toolResultProjection.js` so it has direct
          // unit-test coverage (Codex review on commit 1 flagged this as
          // a covered-by-hydration-only test gap — solved by extracting
          // the producer-side helper).
          for (const { call, result } of allResults) {
            accumulatedToolResults.push(projectToolResultForPersist(call, result));
          }

          // If the last iteration was tool calls only, the next pass will produce
          // the final prose reply. Continue loop.
        }

        // Safety: if we exhausted iterations without a final reply, use last raw output
        if (!finalReply) {
          finalReply = loopMessages[loopMessages.length - 2]?.content ?? '';
        }

        // When tool calls were used, the final reply was NOT streamed via onDelta
        // (subsequent iterations suppress streaming). Emit it now so the UI can
        // feed it to TTS and display it without waiting for finalize to complete.
        const hadToolCalls = loopMessages.length > graphState.modelMessages.length;
        if (hadToolCalls && typeof sseEmitter === 'function') {
          sseEmitter('reply_text', { text: finalReply });
        }

        // G-1d slice 2: pass accumulated tool metadata through graphState so
        // the finalize node can attach it to normalizedReply → sendChatMessage
        // attaches it to the persisted assistantMessage.  Only emit when
        // non-empty so we don't pollute pure-text replies with empty arrays.
        const out = { reply: finalReply, next: 'finalize' };
        if (accumulatedToolResults.length > 0) {
          out.toolResults = accumulatedToolResults;
        }
        return out;
      },

      // ── finalize ───────────────────────────────────────────────────────────
      // Combines the old parse-uncertainty / verify-uncertain-claim /
      // normalize-reply nodes.
      //
      // Verification fires when the model flagged uncertainty AND the intent
      // warrants it. The !background guard is intentionally removed: Telegram
      // and other remote-channel messages deserve corrections too. The only
      // channel-specific difference is that UNVERIFIED warnings are suppressed
      // on remote channels (controlled inside applyVerificationToReply).
      async 'finalize'(graphState) {
        const channelKind = isRemoteChannel ? 'remote' : 'desktop';
        const parsed = parseUncertaintyMarker(graphState.reply);
        const shouldVerify =
          parsed.hasMarker &&
          intentRequiresVerification(graphState.intent);

        if (process.env.MELO_VERIFY_DEBUG === '1') {
          process.stdout.write(
            `[verify] intent=${graphState.intent} hasMarker=${parsed.hasMarker} source=${parsed.source} background=${background}\n`,
          );
        }

        let finalReplyText = parsed.cleanReply;
        let verificationRecord = null;

        if (shouldVerify) {
          const verification = await verifyUncertainClaim({
            userMessage: latestUserMessage,
            assistantReply: parsed.cleanReply,
            uncertainClaim: parsed.uncertainClaim,
            contextBlocks: [graphState.memoryContext, graphState.dynamicContext, graphState.projectContext],
            config,
            model:
              process.env.MELO_VERIFIER_MODEL ||
              graphState.activeAgentProfile.model ||
              config.model,
            signal,
          });

          if (process.env.MELO_VERIFY_DEBUG === '1') {
            process.stdout.write(
              `[verify] verdict=${verification.verdict} reason=${verification.reason}\n`,
            );
          }

          finalReplyText = applyVerificationToReply(parsed.cleanReply, verification, { channelKind });

          // Persist CORRECTED verdicts so future turns can recall past mistakes.
          // UNVERIFIED is not stored — it carries no actionable information.
          if (verification.verdict === 'CORRECTED' && verification.correction) {
            verificationRecord = {
              verdict: verification.verdict,
              claim: parsed.uncertainClaim,
              correction: verification.correction,
            };
          }
        }

        // Demon viz-spec extraction:
        //   - Runs BEFORE normalization so the `<viz-spec>` trailer never
        //     leaks through the markdown strip passes or ends up in the
        //     message history.
        //   - Never attaches a viz on remote channels — `isRemoteChannel`
        //     forces extractVizSpec to strip-only mode.
        const preNormalizeText = finalReplyText || graphState.reply || '';
        const vizExtraction = extractVizSpec(preNormalizeText, { isRemoteChannel });

        // Source-citation extraction:
        //   - Same Demon gate as viz. Runs on the text AFTER viz trailer
        //     removal so a viz block can't accidentally be parsed as cite.
        //   - On remote channels, every `<cite>` tag is collapsed to its
        //     inner quote text — TG/DC has no side drawer to open.
        //   - On desktop, the tags are kept (re-emitted in canonical form)
        //     so the frontend can render inline pills.
        const citationExtraction = extractCitations(
          vizExtraction.text || preNormalizeText,
          { isRemoteChannel },
        );
        const textForNormalization = citationExtraction.text || preNormalizeText;

        const rawNormalized = normalizeAssistantReplyForConversation(
          textForNormalization,
          { channelKind },
        );

        // Guard: if the model returned an empty or blank response, substitute a
        // safe fallback so the user never sees a silent blank message bubble.
        const normalizedReply =
          rawNormalized.content.trim()
            ? rawNormalized
            : normalizeAssistantReplyForConversation(
                isRemoteChannel
                  ? 'Sorry, I could not generate a response. Please try again.'
                  : 'I wasn\'t able to generate a response for this message. Please try again.',
                { channelKind },
              );

        // Attach the parsed viz to the normalized reply so sendChatMessage
        // can persist it on the assistantMessage. `null` when no viz was
        // emitted or the channel blocks visualizations.
        normalizedReply.viz = vizExtraction.viz || null;

        // Same for source citations (NotebookLM pins). Remote channels never
        // get citations — they are either empty (tags collapsed to text
        // before arriving here) or dropped for safety.
        normalizedReply.citations = isRemoteChannel
          ? []
          : citationExtraction.citations || [];

        // G-1d slice 2: forward accumulated tool metadata (set by the
        // tool-loop node above) onto the normalized reply.  sendChatMessage
        // does the conditional spread onto the persisted assistantMessage —
        // empty / absent arrays produce no `toolResults` key on the message.
        if (Array.isArray(graphState.toolResults) && graphState.toolResults.length > 0) {
          normalizedReply.toolResults = graphState.toolResults;
        }

        return {
          normalizedReply,
          verificationRecord,
          next: GRAPH_END,
        };
      },
    },
  });

  return runStateGraph(graph, {
    config,
    state,
    chat,
    workspace,
    connectors,
    skills,
    latestUserMessage,
    agentId,
    channelContext,
  });
}
