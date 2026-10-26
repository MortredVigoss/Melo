import { modelReplyText } from '../../tools/functionCalling.js';
import { executionMetadata, publicSummaryText } from '../../shared/executionMetadata.js';

// Observe application boundaries, never prompts, hidden reasoning or guessed
// progress. Wrapping an existing callback must not enable extra streaming.
// Pending tool requests in a provider reply, for any tool protocol (E1):
// Responses function_call items, chat-completions tool_calls, Anthropic tool_use.
function pendingToolCalls(reply) {
  if (!reply || typeof reply !== 'object') return 0;
  if (Array.isArray(reply.responseItems)) return reply.responseItems.filter(item => item?.type === 'function_call').length;
  if (Array.isArray(reply.message?.tool_calls)) return reply.message.tool_calls.length;
  if (Array.isArray(reply.content)) return reply.content.filter(block => block?.type === 'tool_use').length;
  return 0;
}

export function observeModelReplies(provider, emit) {
  let serial = 0;
  const publish = event => { try { emit?.('execution_event', { kind: 'pipeline', ...event }); } catch {} };
  return async options => {
    const round = ++serial;
    const id = `model:${round}`;
    const messageId = options.providerProfile === 'fast' ? 'stage.verifyModel' : 'stage.model';
    const started = Date.now();
    let receiving = false, receipt, summary = '', lastSummaryAt = 0, lastMetadataAt = 0, closed = false;
    let api = {};
    const elapsed = () => Math.max(0, Date.now() - started);
    const firstEvent = () => { api.firstEventMs ??= elapsed(); };
    const mergeMetadata = value => {
      const next = executionMetadata(value);
      api = { ...api, ...next, ...((api.usage || next.usage) ? { usage: { ...api.usage, ...next.usage } } : {}) };
    };
    const summaryId = `${id}:summary`;
    const summarize = status => publish({ id: summaryId, module: 'compute', channel: 'reasoning-summary', messageId: 'stage.summary', messageParams: {round}, status, model: options.model, output: summary, api });
    publish({ id, messageId, status: 'running', model: options.model, input: options.model || '', outputMessageId: 'output.waiting' });
    try {
      const reply = await provider({
        ...options,
        onReasoningDelta: async chunk => {
          if (closed || chunk?.eventType !== 'response.reasoning_summary_text.delta') return;
          firstEvent();
          const text = String(chunk.text ?? summary + (chunk.delta || ''));
          summary = publicSummaryText(text);
          api.summaryCharacters = summary.length;
          api.summaryParts = Number.isSafeInteger(chunk.parts) ? chunk.parts : 1;
          api.summaryTruncated = Boolean(chunk.truncated || text.length > 24000);
          if (summary && Date.now()-lastSummaryAt >= 100) { summarize('running'); lastSummaryAt=Date.now(); }
          await options.onReasoningDelta?.(chunk);
        },
        ...(typeof options.onDelta === 'function' ? { onDelta: async chunk => {
          if (closed) return;
          if (chunk?.delta || chunk?.text) { firstEvent(); api.firstTextMs ??= elapsed(); }
          if (!receiving && (chunk?.delta || chunk?.text)) {
            receiving = true;
            publish({ id, status: 'running', outputMessageId: 'output.receiving', api });
          }
          return options.onDelta(chunk);
        } } : {}),
        onModelMetadata: value => {
          if (closed) return;
          firstEvent(); mergeMetadata(value);
          if (Date.now() - lastMetadataAt >= 250) {
            publish({ id, status: 'running', returnedModel: api.reportedModel, api });
            lastMetadataAt = Date.now();
          }
          options.onModelMetadata?.(value);
        },
        onProviderResponse: value => {
          if (closed) return;
          receipt = value;
          // The legacy cost receipt defaults absent cache counters to zero.
          // Use the raw API usage above so missing telemetry stays unknown.
          const { usage, ...metadata } = value || {};
          mergeMetadata(metadata);
          options.onProviderResponse?.(value);
        },
      });
      closed = true;
      api.durationMs = elapsed(); api.outputCharacters = modelReplyText(reply).length;
      const status = options.signal?.aborted ? 'cancelled' : ['incomplete', 'interrupted'].includes(api.responseStatus) ? 'interrupted' : api.responseStatus === 'failed' ? 'failed' : 'completed';
      if (summary) summarize(status);
      publish({ id, messageId: receipt?.simulated ? 'stage.simulated' : messageId, status, api, returnedModel: receipt?.reportedModel || api.reportedModel || '',
        outputMessageId: receipt?.simulated ? 'output.modelSimulated' : status === 'completed' ? 'output.modelCompleted' : 'output.modelInterrupted',
        outputMessageParams: {characters: modelReplyText(reply).length, tools: pendingToolCalls(reply), model: api.reportedModel || {messageId:'value.unreported'}} });
      return reply;
    } catch (error) {
      closed = true; api.durationMs = elapsed();
      if (summary) summarize(options.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed');
      publish({ id, status: options.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed', api, outputMessageId: 'output.incomplete' });
      throw error;
    }
  };
}
