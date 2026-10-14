import { buildTaskAcceptance } from './taskAcceptance.js';
// Task state follows a real chat turn. A model reply is evidence for review,
// never proof that the user's acceptance criteria have been met.
export function beginTaskRun(state, context) {
  const task = state.tasks?.find(t => t.execution?.requestId === context.requestId && t.execution.chatId === context.chatId);
  if (!task) return;
  if (task.execution.status !== 'prepared') throw new Error('此任务已有执行记录，请先检查结果再重试。');
  Object.assign(task.execution, { status: 'running', runId: context.runId, startedAt: context.startedAt });
  task.status = 'running';
    task.syncRevision = (task.syncRevision || 1) + 1;
  task.updatedAt = context.startedAt;
  task.lastRunAt = context.startedAt;
  task.runCount = (task.runCount || 0) + 1;
}
export function finishTaskRun(state, context, { message, error, cancelled = false } = {}) {
  const task = state.tasks?.find(t => t.execution?.runId === context.runId && t.execution.status === 'running');
  if (!task) return;
  task.execution.pendingApprovals = {};
  task.acceptance = buildTaskAcceptance(message);
  const failed = !!error || !!message?.metadata?.executionError || task.acceptance.failures.length > 0;
  const status = cancelled ? 'cancelled' : failed ? 'failed' : 'review';
  const note = message?.content || error?.message || '执行中断，请检查记录后继续。';
  Object.assign(task.execution, { status, finishedAt: new Date().toISOString(), assistantMessageId: message?.id || null, note });
  task.status = status === 'review' ? 'review' : 'blocked';
  task.latestNote = note;
    task.syncRevision = (task.syncRevision || 1) + 1;
  task.updatedAt = task.execution.finishedAt;
  task.runHistory = [...(task.runHistory || []), { ...task.execution, usage:task.acceptance.team?.usage || task.acceptance.usage }].slice(-20);
}
export function recoverTaskRuns(state) {
  for (const task of state.tasks || []) {
    if (task.status !== 'running') continue;
    if (task.execution?.runId) {
      finishTaskRun(state, { runId: task.execution.runId }, { error: new Error('Melo 重启导致执行中断。请检查已有修改，再继续修复；不会自动重复操作。') });
    } else {
      task.status = 'blocked';
      task.syncRevision = (task.syncRevision || 1) + 1;
      task.updatedAt = new Date().toISOString();
      task.latestNote = '上次执行未留下完整记录。请检查已有结果后重试。';
    }
  }
  for (const run of state.chatRuns || []) {
    if (run.status === 'running') Object.assign(run, { status: 'interrupted', finishedAt: new Date().toISOString(), errorCode: 'SERVER_RESTARTED' });
  }
}
