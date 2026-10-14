export function createTurnPresentation(requestId) {
  return { requestId, runId: '', phase: 'submitting' };
}

export function receiveTurnPresentation(turn, event, payload = {}) {
  if (!turn) return;
  // Approval requestId belongs to the approval, not the chat submission.
  const identity = event === 'tool_permission' ? payload.turnRequestId : payload.turnRequestId || payload.requestId;
  if (identity && identity !== turn.requestId) return;
  if (payload.runId) turn.runId = payload.runId;
  if (event === 'started') turn.phase = 'waiting';
  else if (event === 'delta') turn.phase = 'replying';
  else if (event === 'reasoning' || event === 'speech_policy') turn.phase = 'thinking';
  else if (event === 'tool_calls_start') turn.phase = 'tools';
  else if (event === 'tool_calls_done') turn.phase = 'thinking';
  else if (event === 'tool_permission') turn.phase = 'permission';
  else if (event === 'reply_text' && payload.final) turn.phase = 'finishing';
  else if (event === 'done') turn.phase = 'complete';
  else if (event === 'error') turn.phase = 'error';
  else if (event === 'aborted') turn.phase = 'stopped';
}

export function turnLabel(turn, { permission = false, tools = false } = {}) {
  if (permission) return '等待你的确认';
  if (tools) return '正在执行工具';
  return { submitting: '正在提交', waiting: '已提交 · 等待响应', thinking: '正在思考', replying: '正在回复', tools: '正在执行工具', permission: '等待你的确认', finishing: '正在整理回复', complete: '回复已完成', error: '本次回复未完成', stopped: '已停止' }[turn?.phase] || '正在处理';
}

export function chatStreamError(payload = {}) {
  const messages = {
    REQUEST_IN_PROGRESS: '同一请求仍在执行，请稍后查看结果；不会重复执行工具。',
    REQUEST_ID_CONFLICT: '这次提交与已有请求冲突，请先检查对话记录。',
    REQUEST_INTERRUPTED: '上次执行已中断。请先检查已完成的操作，再明确发起新请求。',
    REPLY_UNAVAILABLE: '这次请求已完成，但对应回复已被删除。',
    STREAM_INTERRUPTED: '连接中断，尚未收到完成确认。请先检查对话记录，避免重复执行操作。',
  };
  const error = new Error(messages[payload.code] || payload.error || '请求未完成，请稍后重试。');
  error.code = payload.code || '';
  error.requestId = payload.turnRequestId || payload.requestId || '';
  error.runId = payload.runId || '';
  return error;
}
