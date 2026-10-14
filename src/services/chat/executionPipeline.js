// Observe application boundaries, never prompts, hidden reasoning or guessed
// progress. Wrapping an existing callback must not enable extra streaming.
export function observeModelReplies(provider, emit) {
  let serial = 0;
  const publish = event => { try { emit?.('execution_event', { kind: 'pipeline', ...event }); } catch {} };
  return async options => {
    const id = `model:${++serial}`;
    const name = options.providerProfile === 'fast' ? '核验模型请求' : '模型请求';
    let receiving = false, receipt, summary = '', lastSummaryAt = 0;
    const summaryId = `${id}:summary`;
    const summarize = status => publish({ id: summaryId, module: 'compute', channel: 'reasoning-summary', name: '模型公开推理摘要', status, model: options.model, output: summary });
    publish({ id, name, status: 'running', model: options.model, input: `请求模型：${options.model || '服务默认'}`, output: '等待服务返回' });
    try {
      const reply = await provider({
        ...options,
        onReasoningDelta: async chunk => {
          if (chunk?.eventType !== 'response.reasoning_summary_text.delta') return;
          summary = String(chunk.text || summary + (chunk.delta || '')).slice(0, 12000);
          if (summary && Date.now()-lastSummaryAt >= 100) { summarize('running'); lastSummaryAt=Date.now(); }
          await options.onReasoningDelta?.(chunk);
        },
        ...(typeof options.onDelta === 'function' ? { onDelta: async chunk => {
          if (!receiving && (chunk?.delta || chunk?.text)) {
            receiving = true;
            publish({ id, status: 'running', output: '正在接收模型输出' });
          }
          return options.onDelta(chunk);
        } } : {}),
        onProviderResponse: value => { receipt = value; options.onProviderResponse?.(value); },
      });
      if (summary) summarize('completed');
      publish({ id, name: receipt?.simulated ? '模拟响应' : name, status: 'completed', returnedModel: receipt?.reportedModel || '',
        output: `${receipt?.simulated ? '模拟返回' : '模型返回完成'} · 收到 ${String(reply || '').length} 个字符${receipt?.reportedModel ? ` · 服务返回模型：${receipt.reportedModel}` : ' · 服务未报告模型标识'}` });
      return reply;
    } catch (error) {
      if (summary) summarize(options.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed');
      publish({ id, status: options.signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed', output: '未取得完整响应' });
      throw error;
    }
  };
}
