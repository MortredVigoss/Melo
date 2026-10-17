import { modelReplyText } from '../../tools/functionCalling.js';
import { executionMetadata, publicSummaryText } from '../../shared/executionMetadata.js';

// Observe application boundaries, never prompts, hidden reasoning or guessed
// progress. Wrapping an existing callback must not enable extra streaming.
export function observeModelReplies(provider, emit) {
  let serial = 0;
  const publish = event => { try { emit?.('execution_event', { kind: 'pipeline', ...event }); } catch {} };
  return async options => {
    const round = ++serial;
    const id = `model:${round}`;
    const name = options.providerProfile === 'fast' ? '核验模型请求' : '模型请求';
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
    const summarize = status => publish({ id: summaryId, module: 'compute', channel: 'reasoning-summary', name: `第 ${round} 轮 · 公开推理摘要`, status, model: options.model, output: summary, api });
    publish({ id, name, status: 'running', model: options.model, input: `请求模型：${options.model || '服务默认'}`, output: '等待服务返回' });
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
            publish({ id, status: 'running', output: '正在接收模型输出', api });
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
      publish({ id, name: receipt?.simulated ? '模拟响应' : name, status, api, returnedModel: receipt?.reportedModel || api.reportedModel || '',
        output: `${receipt?.simulated ? '模拟返回' : status === 'completed' ? '模型返回完成' : '响应未完整结束'} · 收到 ${modelReplyText(reply).length} 个字符${reply?.responseItems?.some(item => item.type === 'function_call') ? ` · ${reply.responseItems.filter(item => item.type === 'function_call').length} 个工具请求待执行` : ''}${api.reportedModel ? ` · 服务返回模型：${api.reportedModel}` : ' · 服务未报告模型标识'}` });
      return reply;
    } catch (error) {
      closed = true; api.durationMs = elapsed();
      if (summary) summarize(options.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed');
      publish({ id, status: options.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed', api, output: '未取得完整响应' });
      throw error;
    }
  };
}
