import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';

const host = process.argv.includes('--host')
  ? process.argv[process.argv.indexOf('--host') + 1]
  : '127.0.0.1';
const port = Number(
  process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1]
    : process.env.MELO_MOCK_TELEGRAM_PORT || '43132',
);
const token = process.env.MELO_MOCK_TELEGRAM_TOKEN || 'melo-mock-telegram-token';

const state = {
  updates: [],
  sentMessages: [],
  sentActions: [],
  apiRequests: 0,
  nextUpdateId: 1,
  files: new Map(),
};
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnRk0QAAAAASUVORK5CYII=',
  'base64',
);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw new Error('body too large');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function ensureTokenMatch(pathname) {
  return (
    pathname.startsWith(`/bot${encodeURIComponent(token)}/`) ||
    pathname.startsWith(`/file/bot${encodeURIComponent(token)}/`)
  );
}

function buildTelegramMessage({
  chatId,
  text = '',
  caption = '',
  fromBot = false,
  photo = false,
}) {
  const updateId = state.nextUpdateId++;
  const message = {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: String(chatId),
      type: 'private',
    },
    from: {
      id: fromBot ? 999001 : 999002,
      is_bot: fromBot,
      first_name: fromBot ? 'Melo' : 'Test User',
      username: fromBot ? 'melo_mock_bot' : 'test_user',
    },
  };

  if (text) {
    message.text = text;
  }
  if (caption) {
    message.caption = caption;
  }
  if (photo) {
    const fileId = `photo_${updateId}`;
    const filePath = `mock-files/${fileId}.png`;
    state.files.set(fileId, {
      filePath,
      contentType: 'image/png',
      content: TRANSPARENT_PNG,
    });
    message.photo = [
      {
        file_id: fileId,
        file_unique_id: `unique_${fileId}`,
        width: 1,
        height: 1,
        file_size: TRANSPARENT_PNG.length,
      },
    ];
  }

  return {
    update_id: updateId,
    message,
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);

    if (url.pathname === '/__reset' && request.method === 'POST') {
      state.updates = [];
      state.sentMessages = [];
      state.sentActions = [];
      state.apiRequests = 0;
      state.nextUpdateId = 1;
      state.files = new Map();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === '/__seed-update' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const chatId = String(body.chatId || 'chat-1');
      const text = String(body.text || '').trim();
      const caption = String(body.caption || '').trim();
      const photo = Boolean(body.photo);
      if (!text && !caption && !photo) {
        sendJson(response, 400, { error: 'text, caption, or photo is required' });
        return;
      }

      const update = buildTelegramMessage({
        chatId,
        text,
        caption,
        photo,
        fromBot: false,
      });
      state.updates.push(update);
      sendJson(response, 200, { ok: true, update });
      return;
    }

    if (url.pathname === '/__sent' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        sentMessages: state.sentMessages,
        sentActions: state.sentActions,
        apiRequests: state.apiRequests,
      });
      return;
    }

    state.apiRequests++;
    if (!ensureTokenMatch(url.pathname)) {
      sendJson(response, 404, { ok: false, description: 'Unknown bot token.' });
      return;
    }

    if (url.pathname.endsWith('/getMe')) {
      sendJson(response, 200, {
        ok: true,
        result: {
          id: 999001,
          is_bot: true,
          first_name: 'Melo Mock',
          username: 'melo_mock_bot',
        },
      });
      return;
    }

    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') || '0') || 0;
      const updates = state.updates.filter(update => update.update_id >= offset);
      sendJson(response, 200, { ok: true, result: updates });
      return;
    }

    if (url.pathname.endsWith('/getFile')) {
      const fileId = String(url.searchParams.get('file_id') || '').trim();
      const file = state.files.get(fileId);
      if (!file) {
        sendJson(response, 404, { ok: false, description: 'Unknown file id.' });
        return;
      }

      sendJson(response, 200, {
        ok: true,
        result: {
          file_id: fileId,
          file_path: file.filePath,
        },
      });
      return;
    }

    const filePrefix = `/file/bot${encodeURIComponent(token)}/`;
    if (url.pathname.startsWith(filePrefix)) {
      const filePath = url.pathname.slice(filePrefix.length);
      const file = [...state.files.values()].find(entry => entry.filePath === filePath);
      if (!file) {
        sendJson(response, 404, { ok: false, description: 'Unknown mock file path.' });
        return;
      }

      response.writeHead(200, {
        'content-type': file.contentType,
        'content-length': String(file.content.length),
      });
      response.end(file.content);
      return;
    }

    if (url.pathname.endsWith('/sendMessage') && request.method === 'POST') {
      const body = await readJsonBody(request);
      const chatId = String(body.chat_id || '').trim();
      const text = String(body.text || '').trim();
      if (!chatId || !text) {
        sendJson(response, 400, { ok: false, description: 'chat_id and text are required' });
        return;
      }

      const sent = {
        messageId: state.sentMessages.length + 1,
        chatId,
        text,
        at: new Date().toISOString(),
      };
      state.sentMessages.push(sent);
      sendJson(response, 200, {
        ok: true,
        result: {
          message_id: sent.messageId,
          date: Math.floor(Date.now() / 1000),
          text,
          chat: {
            id: chatId,
            type: 'private',
          },
        },
      });
      return;
    }

    if (url.pathname.endsWith('/editMessageText') && request.method === 'POST') {
      const body = await readJsonBody(request);
      const chatId = String(body.chat_id || '').trim();
      const messageId = Number(body.message_id || '0');
      const text = String(body.text || '').trim();
      const sentMessage = state.sentMessages.find(
        message => message.chatId === chatId && message.messageId === messageId,
      );
      if (!chatId || !messageId || !text || !sentMessage) {
        sendJson(response, 400, { ok: false, description: 'chat_id, message_id, and text are required' });
        return;
      }

      sentMessage.text = text;
      sentMessage.editedAt = new Date().toISOString();
      sendJson(response, 200, {
        ok: true,
        result: {
          message_id: sentMessage.messageId,
          date: Math.floor(Date.now() / 1000),
          text,
          chat: {
            id: chatId,
            type: 'private',
          },
        },
      });
      return;
    }

    if (url.pathname.endsWith('/deleteMessage') && request.method === 'POST') {
      const body = await readJsonBody(request);
      const chatId = String(body.chat_id || '').trim();
      const messageId = Number(body.message_id || '0');
      const previousLength = state.sentMessages.length;
      state.sentMessages = state.sentMessages.filter(
        message => !(message.chatId === chatId && message.messageId === messageId),
      );
      if (!chatId || !messageId || state.sentMessages.length === previousLength) {
        sendJson(response, 400, { ok: false, description: 'chat_id and message_id are required' });
        return;
      }

      sendJson(response, 200, {
        ok: true,
        result: true,
      });
      return;
    }

    if (url.pathname.endsWith('/sendChatAction') && request.method === 'POST') {
      const body = await readJsonBody(request);
      const chatId = String(body.chat_id || '').trim();
      const action = String(body.action || '').trim();
      if (!chatId || !action) {
        sendJson(response, 400, { ok: false, description: 'chat_id and action are required' });
        return;
      }

      const sentAction = {
        chatId,
        action,
        at: new Date().toISOString(),
      };
      state.sentActions.push(sentAction);
      sendJson(response, 200, {
        ok: true,
        result: true,
      });
      return;
    }

    sendJson(response, 404, { ok: false, description: 'Unknown mock Telegram route.' });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      description: error?.message || 'Mock Telegram server failed.',
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Mock Telegram listening at http://${host}:${port}\n`);
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
