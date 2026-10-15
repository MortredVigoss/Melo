import {capabilityScopeFromState} from '../agent/capabilityContext.js';
import { findArchivedRun } from '../../persistence/turnArchive.js';
import { beginTaskRun, finishTaskRun } from '../task/taskRunLifecycle.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { chatRequestFingerprint, requestError } from './requestContract.js';

export async function beginChatRun(input, context) {
  const fingerprint = chatRequestFingerprint(input);
  let record;
  let replay = null;
  let fresh = false;
  let turnBinding;
  await updateStateAtomically(state => {
    const chat = state.chats.find(chat => chat.id === input.chatId);
    if (!chat) throw requestError('CHAT_NOT_FOUND', 'Chat not found.', 404);
    state.chatRuns ||= [];
    record = state.chatRuns.find(run => run.chatId === input.chatId && run.requestId === context.requestId) || findArchivedRun(context.home, input.chatId, { requestId: context.requestId });
    if (record) {
      if (record.fingerprint !== fingerprint) throw requestError('REQUEST_ID_CONFLICT', 'This requestId belongs to different content.', 409);
      if (record.status === 'running') throw requestError('REQUEST_IN_PROGRESS', 'This request is still running. Wait for its result; do not start it again.', 409);
      if (record.status !== 'completed') throw requestError('REQUEST_INTERRUPTED', 'This request was cancelled or interrupted. Check its effects before starting a new request.', 409);
      replay = chat.messages.find(message => message.id === record.assistantMessageId);
      if (!replay) throw requestError('REPLY_UNAVAILABLE', 'The recorded reply is no longer available.', 410);
      return;
    }
    record = { requestId: context.requestId, runId: context.runId, chatId: input.chatId,
      fingerprint, status: 'running', createdAt: context.startedAt };
    beginTaskRun(state, context);
    const binding = { role: input.agentId || chat.agentId || 'main', project: chat.projectId || null,
      taskId: state.tasks?.find(t => t.execution?.runId === context.runId && t.execution.status === 'running')?.id || null };
    const capabilityScope=capabilityScopeFromState(state,binding);
    if (!capabilityScope) throw requestError('CAPABILITY_SCOPE_MISSING','Cannot determine the executing Agent.',400);
    turnBinding=Object.freeze({...binding,capabilityScope});
    state.chatRuns.push(record);
    fresh = true;
  }, { home: context.home });
  return { record, replay, fresh, turnBinding };
}

// Called in the SAME transaction as the assistant append, so retries can
// never run tools again merely because the reply's HTTP delivery failed.
export function completeChatRun(state, context, message) {
  finishTaskRun(state, context, { message });
  const record = state.chatRuns?.find(run => run.runId === context.runId);
  if (record) Object.assign(record, { status: 'completed', assistantMessageId: message.id, finishedAt: new Date().toISOString() });
}

export async function interruptChatRun(context, error) {
  await updateStateAtomically(state => {
    finishTaskRun(state, context, { error, cancelled: context.signal?.aborted });
    const record = state.chatRuns?.find(run => run.runId === context.runId);
    if (record && record.status === 'running') {
      record.status = context.signal?.aborted ? 'cancelled' : 'failed';
      record.errorCode = error?.code || error?.name || 'ERROR';
      record.finishedAt = new Date().toISOString();
    }
  }, { home: context.home });
}
