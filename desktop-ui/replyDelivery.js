// Display may show drafts; speech defaults to the committed, verified reply.
export function createReplyDelivery() {
  return { allowLiveSpeech: false, streamed: false, finalReceived: false };
}

export function receiveReplyDelivery(state, event, payload = {}) {
  if (event === 'speech_policy') state.allowLiveSpeech = payload.allowLiveSpeech === true;
  if (event === 'tool_calls_start') state.allowLiveSpeech = false;
  if (event === 'delta' && state.allowLiveSpeech && !state.finalReceived) {
    const speechDelta = String(payload.delta || '');
    if (speechDelta) state.streamed = true;
    return { speechDelta };
  }
  if (event === 'reply_text' && payload.final === true && !state.finalReceived) {
    state.finalReceived = true;
    if (state.allowLiveSpeech && state.streamed) return {};
    return { finalSpeechText: String(payload.text || '') };
  }
  return {};
}
