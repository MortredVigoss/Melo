import { renderConversationContinuityContext as renderStructuredConversationContinuityContext } from '../../memory/threadContext.js';
import { ensureChatThreadContext } from '../../memory/chatThreadContext.js';

export function buildConversationContinuityContext(chat, latestUserMessage = '') {
  return renderStructuredConversationContinuityContext(
    ensureChatThreadContext(chat, latestUserMessage),
  );
}
