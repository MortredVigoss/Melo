// Memory feature state (architecture plan P2, 2026-10-19). Owned by this
// feature: app.js neither reads nor writes it. Field names are the ones the
// moved code used on uiState, so `git log -L` / blame stay readable.
export function createMemoryState() {
  return {
    // Customize → Memory pane. Lazily populated on first open. `snapshot` is
    // the response from /api/memory/status; `wipeConfirmOpen` gates the
    // destructive wipe-embeddings dialog so a single click can't drop vectors
    // by accident. repairBusy / pauseRepair / diagnosis are added on demand.
    memoryStatus: {
      loading: false,
      loaded: false,
      snapshot: null,
      error: null,
      wipeConfirmOpen: false,
      wipeInFlight: false,
      wipeResult: null,
    },
    memoryConnection: null,
    // «记住的事实» list, search/paging and the single-row editor.
    memoryFacts: null,
    memoryFactQuery: '',
    memoryFactOffset: 0,
    memoryFactEditing: null,
    memoryFactDraft: null,
    memoryFactBusy: false,
    memoryFactFeedback: null,
    // Project page «记忆本»: cache of the open project's book, its hand-written
    // draft (keyed by project id) and the save/feedback flags.
    projectBook: null,
    projectBookDraft: null,
    projectBookBusy: false,
    projectBookFeedback: null,
    // Reply footer «本回答参考的记忆»: feedback tied to one message (cleared
    // after 8 s) and the message ids whose footer the user opened (U3).
    memoryRefFeedback: null,
    memoryRefsOpen: {},
  };
}

// Live binding: importers always see the current object.
export let memoryState = createMemoryState();

export function resetMemoryState() {
  memoryState = createMemoryState();
  return memoryState;
}
