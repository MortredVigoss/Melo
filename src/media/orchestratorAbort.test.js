// Codex C-grade fix #7 (final round): the media orchestrator now uses
// `withTimeoutAndAbort` so its per-attachment budget actually CANCELS the
// underlying extraction (not just races a JS promise). This integration
// test drives a real audio attachment through `enrichMessageWithMediaContext`
// against a hanging server and asserts the connection is dropped before the
// budget upper bound — proving the orchestrator-created AbortSignal made it
// through routeExtraction → extractAudioContent → readAttachmentBuffer →
// fetch.
//
// Companion to src/media/extractors/audioExtractor.signal.test.js, which
// proves the BACKEND respects an externally-supplied signal. Together they
// lock the chain end-to-end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  _setMediaBudgetsForTests,
  enrichMessageWithMediaContext,
} from './index.js';

test('enrichMessageWithMediaContext: hanging audio download is aborted by per-attachment budget', async () => {
  // 200ms per-attachment budget so the test is fast. Production default 15s.
  _setMediaBudgetsForTests({ totalMs: 5000, perAttachmentMs: 200 });

  let downloadHit = false;
  let connectionAbortedByClient = false;
  const server = createServer((req, res) => {
    downloadHit = true;
    req.on('close', () => {
      // Node sets `aborted` true when the client (our fetch) aborts mid-flight
      // BEFORE the response ends. `complete` is true if the server sent a
      // proper response. We hung — never sent — so `aborted=true` here means
      // the client side cancelled.
      if (req.aborted || !res.writableEnded) {
        connectionAbortedByClient = true;
      }
    });
    /* never end */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const message = {
      role: 'user',
      blocks: [{ kind: 'text', text: 'check this' }],
      attachments: [{
        id: 'a1',
        kind: 'audio',
        url: `http://127.0.0.1:${port}/audio.ogg`,
        fileName: 'remote.ogg',
        mimeType: 'audio/ogg',
      }],
    };

    const start = Date.now();
    await enrichMessageWithMediaContext(message, {
      config: { authMode: 'codex', apiKey: '', baseUrl: 'https://chatgpt.com' },
    });
    const elapsed = Date.now() - start;

    // Anti-false-green: if the server wasn't hit, the test proves nothing.
    // Possible reasons: cache hit, wrong route, budget skipped extraction
    // entirely. None should happen with the setup above.
    assert.ok(downloadHit, 'fake download server must have received the request');

    // The orchestrator's 200ms budget MUST have aborted before the internal
    // 30s readAttachmentBuffer fetch timeout. Allow generous headroom for
    // socket teardown but well under any non-abort path.
    assert.ok(elapsed < 2000, `should abort well within budget, took ${elapsed}ms`);

    // Give Node a tick to surface the close event after the orchestrator returns.
    await new Promise(r => setTimeout(r, 50));
    assert.ok(connectionAbortedByClient, 'fetch must have been aborted client-side — otherwise the abort signal never reached fetch');
  } finally {
    server.close();
    _setMediaBudgetsForTests();  // restore production defaults
  }
});
