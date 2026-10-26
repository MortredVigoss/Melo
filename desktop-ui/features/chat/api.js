import { currentLanguage } from '../../i18n.js';
// Chat requests (architecture plan P2c, 2026-10-19): the only requests the
// chat feature makes. createChatApi(api) wraps app.js's shared api() (same
// URLs and bodies as before the move); the reply stream and the supplement
// go straight to fetch, as they always did: streamApi is the SSE client for
// /api/chat/send/stream (`done` resolves; `error` or a missing `done` reject
// with chatStreamError; `aborted` rejects with an AbortError), moved out of
// desktop-ui/app.js byte-for-byte.
import { chatStreamError } from './turnPresentation.js';

export function createChatApi(api) {
  return {
    // New chat with the composer's new-chat selection.
    createChat: body => api('/api/chats', { method: 'POST', body }),
    // The chat-side Agent picker (and other per-chat patches).
    updateChat: (chatId, patch) => api('/api/chats/update', { method: 'POST', body: { chatId, patch } }),
    // A video's study notes saved as a knowledge artifact.
    saveArtifact: body => api('/api/artifacts', { method: 'POST', body }),
    // A stopped or failed reply silences the TTS it started.
    clearSpeechQueue: () => api('/api/tts/queue-clear', { method: 'POST', body: {} }),
    stopSpeech: () => api('/api/tts/speak-stop', { method: 'POST', body: {} }),
    // A supplement for the running reply; the caller reads response.ok.
    postSupplement: (chatId, content) => fetch('/api/chat/supplement', { method: 'POST', headers: { 'content-type': 'application/json', 'x-melo-interface-language': currentLanguage() }, body: JSON.stringify({ chatId, content }) }),
  };
}

function parseEventStreamBlock(block) {
  const lines = block
    .split(/\r?\n/)
    .map(line => line.trimEnd());
  let event = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart() || event;
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const raw = dataLines.join('\n').trim();
  if (!raw) {
    return null;
  }

  try {
    return {
      event,
      payload: JSON.parse(raw),
    };
  } catch {
    return {
      event,
      payload: { value: raw },
    };
  }
}

async function streamApi(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json', 'x-melo-interface-language': currentLanguage(),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw chatStreamError(payload);
  }

  if (!response.body) {
    throw new Error('Streaming request returned no response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const separatorIndex = buffer.search(/\r?\n\r?\n/);
        if (separatorIndex === -1) {
          break;
        }

        const block = buffer.slice(0, separatorIndex);
        const separatorLength = buffer.startsWith('\r\n\r\n', separatorIndex) ? 4 : 2;
        buffer = buffer.slice(separatorIndex + separatorLength);

        const message = parseEventStreamBlock(block);
        if (!message) {
          continue;
        }

        if (typeof options.onEvent === 'function') {
          options.onEvent(message);
        }

        if (message.event === 'done') {
          donePayload = message.payload;
        } else if (message.event === 'error') {
          throw chatStreamError(message.payload);
        } else if (message.event === 'aborted') {
          throw new DOMException('The request was stopped.', 'AbortError');
        }
      }
    }

    if (!donePayload) throw chatStreamError({ code: 'STREAM_INTERRUPTED' });
    return donePayload;
  } finally {
    try {
      await reader.cancel();
    } catch {}

    try {
      reader.releaseLock();
    } catch {}
  }
}

export { parseEventStreamBlock, streamApi };
