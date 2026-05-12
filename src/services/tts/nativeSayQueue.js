/**
 * src/services/tts/nativeSayQueue.js
 *
 * Sequential queue for /usr/bin/say invocations (Bug 1 fix 2026-05-12).
 *
 * Background
 * ----------
 * The old streaming TTS code for macOS engine fired one POST
 * /api/tts/native per detected sentence break.  /api/tts/native kills
 * the previous `say` process before spawning the new one — so
 * per-sentence streaming had every sentence cut short by the next one,
 * users only heard the LAST sentence (or a fragment of each before
 * preemption).  See `desktop-ui/app.js:_streamTtsPushChunk` macOS
 * branch.
 *
 * This module mirrors the pattern already used by `_ttsQueue` (server.js
 * lines 2196+) for synthesized-buffer playback: push items in order,
 * spawn one at a time, await `exit`, then start the next.  Spawned proc
 * is held in `state.current` so `clear()` can kill it mid-utterance for
 * preemption (Stop button, new chat send, etc).
 *
 * Design constraints:
 *   • Pure state-machine — `spawn` is injected so unit tests can mock it.
 *   • Stateful but encapsulated — single mutable `state` object, no module-
 *     level globals.  The server.js call site holds the singleton.
 *   • Session counter bumped on `clear()` so any queue items that were
 *     pushed before the clear get filtered out when their turn comes.
 *
 * Test seam: the returned object exposes `_state` (read-only by convention)
 * for assertions in tests.  Production callers should only use `add` /
 * `clear` / `currentItem`.
 */

/**
 * @typedef {Object} NativeSayQueue
 * @property {(args: string[]) => void} add
 *     Push a `say` invocation to the tail of the queue.  Kicks the
 *     drain loop if not already running.
 * @property {() => void} clear
 *     Bump session (marks already-queued items stale) + drop pending +
 *     kill the currently-playing say process.  After this, the next
 *     `add` starts fresh.
 * @property {() => { args: string[], sessionId: number } | null} currentItem
 *     Inspect what's playing right now (or null if idle).
 *     Used by stop/health endpoints that want to log "what got killed".
 * @property {object} _state
 *     @internal — test-only access to internal state.
 */

/**
 * @param {{ spawn: (cmd: string, args: string[], opts?: object) => ChildProcess,
 *          stderr?: (line: string) => void }} deps
 * @returns {NativeSayQueue}
 */
export function createNativeSayQueue({ spawn, stderr = () => {} }) {
  const state = {
    /** @type {{ args: string[], sessionId: number }[]} */
    queue: [],
    /** true while the drain loop is iterating */
    running: false,
    /** monotonic counter — bumped on clear() to mark queued items stale */
    session: 0,
    /** the say process currently being awaited, or null if idle */
    current: null,
    /** what's playing right now (args+sessionId), or null if idle */
    currentItem: null,
  };

  async function drain() {
    if (state.running) return;
    state.running = true;
    try {
      while (state.queue.length > 0) {
        const item = state.queue.shift();
        if (item.sessionId !== state.session) continue; // stale — clear() happened
        state.currentItem = item;
        try {
          await new Promise(resolve => {
            const proc = spawn('/usr/bin/say', item.args, { detached: false });
            state.current = proc;
            proc.on('exit', () => {
              if (state.current === proc) state.current = null;
              resolve();
            });
            proc.on('error', () => {
              if (state.current === proc) state.current = null;
              resolve();
            });
          });
          state.currentItem = null;
        } catch (e) {
          stderr(`[tts/native-queue] play error: ${e?.message || e}`);
        }
        // After kill (clear), the proc's exit fires which resolves our
        // promise above.  If session was bumped while we were playing,
        // bail out — every remaining item is stale, the next iter would
        // skip them anyway but breaking is cheaper.
        if (item.sessionId !== state.session) break;
      }
    } finally {
      state.running = false;
      // Wake-up tail: callers may have add()'d items WHILE we were
      // awaiting our final `exit` (especially after clear() pre-empted
      // mid-utterance — the add() saw `running=true` and just enqueued,
      // trusting drain to come around again).  Now we've exited the
      // loop and set running=false, so any such pending items would be
      // stuck forever unless we restart drain ourselves.  This recursion
      // is safe — re-entering drain sees `running=false` (just set) and
      // starts a fresh pass.  Doing nothing here was the root of the
      // "fresh items added right after clear() never play" bug.
      if (state.queue.length > 0) drain();
    }
  }

  return {
    add(args) {
      state.queue.push({ args, sessionId: state.session });
      // Kick the drain loop.  Don't await — the caller is the HTTP
      // handler and returns 200 immediately; playback is async.
      drain();
    },
    clear() {
      state.session += 1;
      state.queue.length = 0;
      state.currentItem = null;
      if (state.current) {
        try { state.current.kill(); } catch {}
        state.current = null;
      }
    },
    currentItem() {
      return state.currentItem;
    },
    _state: state, // test-only
  };
}
