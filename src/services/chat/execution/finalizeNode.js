import { completionSummary } from '../../../../shared/agent/completion.js';
import { runtimeMessage } from '../../../../shared/agent/runtimeMessages.js';
// Chat execution graph — `finalize` node (architecture B2, 2026-10-20).
// Mechanical move out of chatExecutionRunner.js: the body below is the
// original node body, unchanged except for one indentation level. The
// runner-scoped bindings it closed over arrive through the turn object and
// are destructured under their original names; none is reassigned inside the
// node (checked by scope analysis before the move), so this is equivalent to
// the closure it replaces.
import { summarizePricedUsage } from '../../../runtime/usage.js';
import { GRAPH_END } from '../../../agentGraph.js';
import { normalizeAssistantReplyForConversation } from '../../../domain/message/messageBlocks.js';
import { extractVizSpec } from '../../viz/vizSpec.js';
import { extractCitations } from '../../viz/citation.js';
import { intentRequiresVerification } from '../../../retrieval/intentRouter.js';
import { parseUncertaintyMarker, verifyUncertainClaim, applyVerificationToReply } from '../../../retrieval/selfVerification.js';

// ── finalize ───────────────────────────────────────────────────────────
// Combines the old parse-uncertainty / verify-uncertain-claim /
// normalize-reply nodes.
//
// Verification sees fresh tool evidence and stays enabled for all channels.
export function createFinalizeNode(turn) {
  const { background, config, createReply, env, isRemoteChannel, latestUserMessage, modelOverrides, modelResponses, signal, sseEmitter } = turn;
  return async function finalize(graphState) {
    sseEmitter?.('execution_event', { kind: 'pipeline', id: 'reply:format', name: '整理回答与引用', status: 'running', output: '处理返回文字、引用与消息格式' });
    const channelKind = isRemoteChannel ? 'remote' : 'desktop';
    const parsed = parseUncertaintyMarker(graphState.reply);
    const shouldVerify =
      !graphState.skipVerification && parsed.hasMarker &&
      intentRequiresVerification(graphState.classification || graphState.intent);

    if (env.MELO_VERIFY_DEBUG === '1') {
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
        toolEvidence: graphState.toolEvidence || [],
        config: { ...config, apiKey: modelOverrides.apiKey, baseUrl: modelOverrides.baseUrl },
        model:
          modelOverrides.verifier ||
          modelOverrides.model ||
          graphState.activeAgentProfile.model ||
          config.model,
        signal,
        _createReply: createReply,
      });

      if (env.MELO_VERIFY_DEBUG === '1') {
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
    //     forces extractVizSpec to strip-only mode. New requests also
    //     use strip-only mode while Demon authoring is retired.
    const preNormalizeText = finalReplyText || graphState.reply || '';
    const vizExtraction = extractVizSpec(preNormalizeText, { enabled: false, isRemoteChannel });

    // Source-citation extraction:
    //   - Runs on the text AFTER legacy viz trailer
    //     removal so a viz block can't accidentally be parsed as cite.
    //   - On remote channels, every `<cite>` tag is collapsed to its
    //     inner quote text — TG/DC has no side drawer to open.
    //   - On desktop, the tags are kept (re-emitted in canonical form)
    //     so the frontend can render inline pills.
    const citationExtraction = extractCitations(
      vizExtraction.text,
      { isRemoteChannel },
    );
    const textForNormalization = citationExtraction.text;

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
            runtimeMessage('empty', config.replyLanguage),
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
    // Retain the verified source form without changing existing channel renderers.
    if (textForNormalization.trim() !== normalizedReply.content) {
      normalizedReply.canonicalReply = textForNormalization.trim();
    }

    // G-1d slice 2: forward accumulated tool metadata (set by the
    // tool-loop node above) onto the normalized reply.  sendChatMessage
    // does the conditional spread onto the persisted assistantMessage —
    // empty / absent arrays produce no `toolResults` key on the message.
    normalizedReply.completion = graphState.completionForReply?.(preNormalizeText);
    if (normalizedReply.completion?.outcome) normalizedReply.completion.summary = completionSummary(normalizedReply.completion, latestUserMessage, config.replyLanguage);
    normalizedReply.memoryUsage = graphState.memoryUsage || [];
    if (graphState.team) normalizedReply.team = graphState.team;
    if (Array.isArray(graphState.toolResults) && graphState.toolResults.length > 0) {
      normalizedReply.toolResults = graphState.toolResults;
    }
    if (graphState.toolChain) normalizedReply.toolChain = graphState.toolChain;
    // Budget diagnostics (audit L4): the background pre-compaction follows
    // the history window this turn actually had, not the nominal one.
    if (graphState.promptDiagnostics) normalizedReply.promptDiagnostics = graphState.promptDiagnostics;
    if (signal?.aborted) throw signal.reason || new Error('Request aborted');
    if (modelResponses.length) {
      normalizedReply.modelResponses = modelResponses;
      normalizedReply.usage = summarizePricedUsage(modelResponses, config.modelPricing);
    }
    sseEmitter?.('execution_event', { kind: 'pipeline', id: 'reply:format', status: 'completed', output: '回答格式与引用整理完成' });
    sseEmitter?.('reply_text', { text: normalizedReply.content, final: true });

    return {
      normalizedReply,
      verificationRecord,
      next: GRAPH_END,
    };
  };
}
