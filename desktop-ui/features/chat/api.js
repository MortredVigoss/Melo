// Chat requests (architecture plan P2c, 2026-10-19): the SSE client for
// /api/chat/send/stream (parseEventStreamBlock, streamApi: `done` resolves,
// `error` / a missing `done` reject with chatStreamError, `aborted` rejects
// with an AbortError). Moved out of desktop-ui/app.js byte-for-byte.
import { chatStreamError } from '../../turnPresentation.js';

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
      'content-type': 'application/json',
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
