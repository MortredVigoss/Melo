import {
  detectClarificationFrame,
  extractClarificationOptions,
  isLikelyClarificationPrompt,
  normalizeComparablePhrase,
  normalizeConversationSnippet,
} from './heuristics.js';

function defaultMessageTextResolver(message) {
  return String(message?.content || '').trim();
}

export function uniqueMemoryLines(values = [], limit = 6) {
  const seen = new Set();
  const lines = [];

  for (const value of values) {
    const normalized = normalizeConversationSnippet(value, 220);
    const comparable = normalizeComparablePhrase(normalized);
    if (!normalized || !comparable || seen.has(comparable)) {
      continue;
    }

    seen.add(comparable);
    lines.push(normalized);
    if (lines.length >= limit) {
      break;
    }
  }

  return lines;
}

function summarizeRecentWindow(messages = [], messageTextResolver, limit = 6) {
  return messages
    .slice(-limit)
    .map(message => {
      const text = normalizeConversationSnippet(messageTextResolver(message), 220);
      if (!text) {
        return null;
      }

      return {
        role: message.role === 'assistant' ? 'Melo' : 'User',
        text,
      };
    })
    .filter(Boolean);
}

function findLatestOpenClarification(messages = [], messageTextResolver) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role !== 'assistant') {
      continue;
    }

    const assistantPrompt = normalizeConversationSnippet(messageTextResolver(candidate), 360);
    if (!assistantPrompt || !isLikelyClarificationPrompt(assistantPrompt)) {
      continue;
    }

    const sourceUser = [...messages.slice(0, index)]
      .reverse()
      .find(message => message.role === 'user');

    return {
      assistantPrompt,
      sourceUserTopic: normalizeConversationSnippet(messageTextResolver(sourceUser), 220),
      options: extractClarificationOptions(messageTextResolver(candidate)),
    };
  }

  return null;
}

export function buildThreadContext({
  chat,
  latestUserMessage = '',
  messageTextResolver = defaultMessageTextResolver,
  maxRecentMessages = 8,
  maxMemoryMessages = 24,
  maxMemoryItems = 6,
} = {}) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const recentMessages = messages.slice(-Math.max(maxRecentMessages, 10));
  const olderMessages = messages
    .slice(0, -4)
    .slice(-maxMemoryMessages);
  const latestUser = [...messages]
    .reverse()
    .find(message => message.role === 'user');
  const latestAssistant = [...messages]
    .reverse()
    .find(message => message.role === 'assistant');
  const pivotIndex = latestUser ? messages.lastIndexOf(latestUser) : messages.length;
  const previousAssistant = [...messages.slice(0, pivotIndex)]
    .reverse()
    .find(message => message.role === 'assistant');
  const previousUser = [...messages.slice(0, pivotIndex)]
    .reverse()
    .find(message => message.role === 'user');
  const currentUserText = normalizeConversationSnippet(
    latestUserMessage || messageTextResolver(latestUser),
    220,
  );
  const clarificationDetection = detectClarificationFrame(
    messageTextResolver(previousAssistant),
    currentUserText,
  );

  return {
    derivedFromMessageId: messages[messages.length - 1]?.id || null,
    sessionTitle: chat?.title || 'Untitled chat',
    currentTurn: {
      user: currentUserText,
      assistant: normalizeConversationSnippet(messageTextResolver(latestAssistant), 220),
    },
    earlierUserContext: uniqueMemoryLines(
      olderMessages
        .filter(message => message.role === 'user')
        .map(message => messageTextResolver(message)),
      maxMemoryItems,
    ),
    earlierAssistantContext: uniqueMemoryLines(
      olderMessages
        .filter(message => message.role === 'assistant')
        .map(message => messageTextResolver(message)),
      maxMemoryItems,
    ),
    recentWindow: summarizeRecentWindow(recentMessages, messageTextResolver, 4),
    openClarificationFrame: findLatestOpenClarification(messages, messageTextResolver),
    clarificationFrame: clarificationDetection.isFrame
      ? {
          assistantPrompt: clarificationDetection.assistantText,
          sourceUserTopic: normalizeConversationSnippet(messageTextResolver(previousUser), 220),
          options: clarificationDetection.options,
          matchedOption: clarificationDetection.matchedOption,
          latestReplyLooksContextual: clarificationDetection.latestReplyLooksContextual,
          latestReply: clarificationDetection.latestReply,
          confidence: clarificationDetection.confidence,
          signals: clarificationDetection.signals,
        }
      : null,
  };
}

export function renderThreadMemorySnapshot(context = {}) {
  if (!context || !context.derivedFromMessageId) {
    return '';
  }

  const sections = [
    'Thread memory snapshot:',
    `Session title: ${context.sessionTitle || 'Untitled chat'}`,
    context.currentTurn?.user ? `Current user request: ${context.currentTurn.user}` : '',
    context.currentTurn?.assistant ? `Latest assistant answer: ${context.currentTurn.assistant}` : '',
    Array.isArray(context.earlierUserContext) && context.earlierUserContext.length
      ? `Earlier user context:\n${context.earlierUserContext.map(turn => `- ${turn}`).join('\n')}`
      : '',
    Array.isArray(context.earlierAssistantContext) && context.earlierAssistantContext.length
      ? `Earlier Melo context:\n${context.earlierAssistantContext.map(turn => `- ${turn}`).join('\n')}`
      : '',
    Array.isArray(context.recentWindow) && context.recentWindow.length
      ? `Recent visible thread state:\n${context.recentWindow
          .map(turn => `- ${turn.role}: ${turn.text}`)
          .join('\n')}`
      : '',
    context.openClarificationFrame
      ? [
          'Open clarification frame:',
          `- Assistant asked the user to choose or disambiguate: ${context.openClarificationFrame.assistantPrompt}`,
          context.openClarificationFrame.sourceUserTopic
            ? `- That clarification belongs to this earlier user topic: ${context.openClarificationFrame.sourceUserTopic}`
            : '',
          Array.isArray(context.openClarificationFrame.options) &&
          context.openClarificationFrame.options.length
            ? `- Candidate options already mentioned: ${context.openClarificationFrame.options.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
  ].filter(Boolean);

  return sections.join('\n\n');
}

export function renderConversationContinuityContext(context = {}) {
  const frame = context?.clarificationFrame;
  if (!frame) {
    return '';
  }

  return [
    'Conversation continuity rules:',
    'Active follow-up interpretation:',
    `- The assistant\'s previous turn was a clarification/disambiguation step: ${frame.assistantPrompt}`,
    frame.sourceUserTopic
      ? `- The topic being clarified came from the earlier user request: ${frame.sourceUserTopic}`
      : '- The topic being clarified came from the immediately preceding user request.',
    frame.latestReply
      ? `- The latest user reply should be interpreted as choosing or refining that earlier topic: ${frame.latestReply}`
      : '- The latest user reply should be interpreted relative to the earlier topic.',
    Array.isArray(frame.options) && frame.options.length
      ? `- Previously surfaced options in this thread: ${frame.options.join(', ')}`
      : '',
    frame.matchedOption
      ? `- The latest reply most likely points to this earlier option. Do not answer it as a fresh standalone prompt: ${frame.matchedOption}`
      : '',
    frame.signals?.length
      ? `- Diagnostic signals: ${frame.signals.join(', ')} (confidence ${frame.confidence})`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderThreadContext(context = {}) {
  return [
    renderThreadMemorySnapshot(context),
    renderConversationContinuityContext(context),
  ]
    .filter(Boolean)
    .join('\n\n');
}
