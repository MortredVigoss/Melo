export function createTurnPresentation(requestId) {
  return { requestId, runId: '', phase: 'submitting' };
}

export function receiveTurnPresentation(turn, event, payload = {}) {
  if (!turn) return;
  // Approval requestId belongs to the approval, not the chat submission.
  const approval = ['tool_permission', 'capability_request', 'tool_permission_closed', 'capability_request_closed'].includes(event);
  const identity = approval ? payload.turnRequestId : payload.turnRequestId || payload.requestId;
  if (identity && identity !== turn.requestId) return;
  if (payload.runId) turn.runId = payload.runId;
  if (event === 'started') turn.phase = 'waiting';
  else if (event === 'delta') turn.phase = 'replying';
  else if (event === 'reasoning' || event === 'speech_policy') turn.phase = 'thinking';
  else if (event === 'tool_calls_start') turn.phase = 'tools';
  else if (event === 'tool_calls_done') turn.phase = 'thinking';
  else if (event === 'tool_permission' || event === 'capability_request') turn.phase = 'permission';
  // The server stopped waiting for a prompt (timeout, cancel): the turn goes on. Left in
  // 'permission', the banner kept saying "等待你的确认" with no prompt on screen (2026-11-10).
  else if (event === 'tool_permission_closed' || event === 'capability_request_closed') { if (turn.phase === 'permission') turn.phase = 'thinking'; }
  // The delivery check: a running `goal-check` stage until its verdict (2026-11-10).
  else if (event === 'execution_event' && payload.kind === 'pipeline' && /^goal-check:/.test(String(payload.id || ''))) {
    if (payload.status === 'running') turn.phase = 'checking';
    else if (turn.phase === 'checking') turn.phase = 'thinking';
  }
  else if (event === 'reply_text' && payload.final) turn.phase = 'finishing';
  else if (event === 'done') turn.phase = 'complete';
  else if (event === 'error') turn.phase = 'error';
  else if (event === 'aborted') turn.phase = 'stopped';
}

// The banner's labels and the stream errors are catalog keys (Chinese source).
// The callers translate them: the banner through `t(turnLabel(…))`, the errors
// through the `translate` argument. Returned as written, every other interface
// language showed these in Chinese (agent audit 2026-11-10);
// turnPresentation.test.js keeps each of them in the catalog.
export const TURN_LABELS = Object.freeze({ submitting: '正在提交', waiting: '已提交 · 等待响应', thinking: '正在思考', replying: '正在回复', tools: '正在执行工具', permission: '等待你的确认', checking: '正在核对回答', finishing: '正在整理回复', complete: '回复已完成', error: '本次回复未完成', stopped: '已停止' });
export const TURN_LABEL_FALLBACK = '正在处理';
export function turnLabel(turn, { permission = false, tools = false } = {}) {
  if (permission) return TURN_LABELS.permission;
  if (tools) return TURN_LABELS.tools;
  return TURN_LABELS[turn?.phase] || TURN_LABEL_FALLBACK;
}

export const STREAM_ERRORS = Object.freeze({
  REQUEST_IN_PROGRESS: '同一请求仍在执行，请稍后查看结果；不会重复执行工具。',
  REQUEST_ID_CONFLICT: '这次提交与已有请求冲突，请先检查对话记录。',
  REQUEST_INTERRUPTED: '上次执行已中断。请先检查已完成的操作，再明确发起新请求。',
  REPLY_UNAVAILABLE: '这次请求已完成，但对应回复已被删除。',
  STREAM_INTERRUPTED: '连接中断，尚未收到完成确认。请先检查对话记录，避免重复执行操作。',
});
export const STREAM_ERROR_FALLBACK = '请求未完成，请稍后重试。';
export function chatStreamError(payload = {}, translate = text => text) {
  const messages = STREAM_ERRORS;
  const error = new Error(messages[payload.code] ? translate(messages[payload.code]) : payload.error || translate(STREAM_ERROR_FALLBACK));
  error.code = payload.code || '';
  error.requestId = payload.turnRequestId || payload.requestId || '';
  error.runId = payload.runId || '';
  return error;
}
