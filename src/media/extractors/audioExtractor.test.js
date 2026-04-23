import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAudioContent } from './audioExtractor.js';

test('extractAudioContent uses env-backed transcription credentials when config has no apiKey', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    MELO_API_KEY: process.env.MELO_API_KEY,
    MELO_BASE_URL: process.env.MELO_BASE_URL,
  };

  const requests = [];
  process.env.MELO_API_KEY = 'env-test-key';
  process.env.MELO_BASE_URL = 'https://api.openai.com/v1';

  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).startsWith('data:audio/')) {
      throw new Error('unexpected data url fetch');
    }
    if (String(url).endsWith('/audio/transcriptions')) {
      return {
        ok: true,
        json: async () => ({ text: '这是转写结果' }),
      };
    }
    return {
      ok: true,
      arrayBuffer: async () => Uint8Array.from([0x41, 0x42, 0x43]).buffer,
    };
  };

  try {
    const result = await extractAudioContent(
      {
        url: 'https://example.com/clip.mp3',
        mimeType: 'audio/mpeg',
        fileName: 'clip.mp3',
      },
      {
        config: {
          authMode: 'codex',
          apiKey: '',
          baseUrl: 'https://chatgpt.com/backend-api',
        },
      },
    );

    assert.equal(result?.kind, 'transcript');
    assert.equal(result?.text, '这是转写结果');
    assert.equal(
      requests.some(entry => entry.url === 'https://api.openai.com/v1/audio/transcriptions'),
      true,
    );
    assert.equal(
      requests.find(entry => entry.url === 'https://api.openai.com/v1/audio/transcriptions')?.options?.headers?.authorization,
      'Bearer env-test-key',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv.MELO_API_KEY == null) {
      delete process.env.MELO_API_KEY;
    } else {
      process.env.MELO_API_KEY = originalEnv.MELO_API_KEY;
    }
    if (originalEnv.MELO_BASE_URL == null) {
      delete process.env.MELO_BASE_URL;
    } else {
      process.env.MELO_BASE_URL = originalEnv.MELO_BASE_URL;
    }
  }
});
