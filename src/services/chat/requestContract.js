import {validateTeamPlan} from '../../agents/team.js';
import { validateImageTask } from '../../images/imageSettings.js';
import { createHash } from 'node:crypto';

export function requestError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

// Keep existing fields and response payloads compatible; reject malformed
// shapes before enqueuing work, opening SSE or committing a user message.
export function validateChatRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw requestError('INVALID_REQUEST', 'A chat request object is required.');
  }
  if (typeof input.chatId !== 'string' || !input.chatId.trim() || input.chatId.length > 256) {
    throw requestError('INVALID_CHAT_ID', 'chatId is required.');
  }
  if (input.content != null && typeof input.content !== 'string') {
    throw requestError('INVALID_CONTENT', 'content must be a string.');
  }
  for (const key of ['attachments', 'extractedMedia']) {
    if (input[key] != null && (!Array.isArray(input[key]) || input[key].some(item => !item || typeof item !== 'object' || Array.isArray(item)))) {
      throw requestError('INVALID_ATTACHMENTS', `${key} must be an array of objects.`);
    }
  }
  if (input.requestId != null && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestId))) {
    throw requestError('INVALID_REQUEST_ID', 'requestId must contain 1–128 letters, numbers, dots, colons, underscores or hyphens.');
  }
  if (!input.content?.trim() && !input.attachments?.length) throw requestError('EMPTY_MESSAGE', 'Message cannot be empty.');
  if (input.imageTask != null) { try { validateImageTask(input.imageTask); } catch(error) { throw requestError('INVALID_IMAGE_TASK',error.message); } }
  if(input.teamPlan!=null) {try {validateTeamPlan(input.teamPlan);}catch(error){throw requestError('INVALID_TEAM_PLAN',error.message);}}
  // Live voice call turn (2026-11-16): adds the spoken-answer instruction to this turn only.
  if (input.voiceTurn != null && typeof input.voiceTurn !== 'boolean') throw requestError('INVALID_VOICE_TURN', 'voiceTurn must be a boolean.');
  return input;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function chatRequestFingerprint(input) {
  return createHash('sha256').update(JSON.stringify(stable({
    chatId: input.chatId, content: input.content || '', mode: input.mode || '',
    attachments: input.attachments || [], extractedMedia: input.extractedMedia || [],
    agentId: input.agentId || null, background: Boolean(input.background),
    channelContext: input.channelContext || null, providerProfile: input.providerProfile || 'default',
    demonMode: Boolean(input.demonMode),
    ...(input.teamPlan ? {teamPlan:validateTeamPlan(input.teamPlan)} : {}),
    ...(input.imageTask ? { imageTask: validateImageTask(input.imageTask) } : {}),
    // Only a voice turn adds the key, so every earlier request keeps its fingerprint.
    ...(input.voiceTurn === true ? { voiceTurn: true } : {}),
  }))).digest('hex');
}

export function errorPayload(error, context) {
  return {
    error: error?.message || 'Request failed.',
    code: error?.code || (error?.name === 'AbortError' ? 'ABORTED' : 'INTERNAL_ERROR'),
    ...(context ? { requestId: context.requestId, runId: context.runId, chatId: context.chatId } : {}),
  };
}
