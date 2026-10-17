// Phase 4 — LRU cache for skill-match results.
//
// Rationale: the matcher is called at least once per user turn. Within a
// session the message text, skill list, and recency snapshot are often
// stable across retries or sub-agent hops. Memoizing on a composite key
// (message fingerprint + skills fingerprint + options) lets us skip the
// whole tokenize-and-score pass when nothing has changed.
//
// Implementation notes:
//   * Map preserves insertion order in JS. On `get` we delete and re-set
//     the entry so the most-recently-used items sit at the end. When size
//     exceeds capacity we evict the head (oldest entry).
//   * This is a small, dependency-free LRU — ~20 lines. No need for an
//     npm dep (keeping the Phase 4 package zero-native-dep per user spec).
//   * Matcher values are arrays of Skill IDs. Definitions are resolved from
//     the caller's current Registry; cached objects never cross scopes.
//
// API:
//   createSkillMatchCache({ capacity })  → { get, set, has, delete, clear, size }
//   defaultSkillMatchCache               — module-level singleton
//
// Capacity sized for one-screen sessions: 64 entries at maybe 1–2 KB each
// is under 128 KB of extra memory, comfortably below anything worth
// worrying about on Electron.

const DEFAULT_CAPACITY = 64;

export function createSkillMatchCache({ capacity = DEFAULT_CAPACITY } = {}) {
  const cap = Math.max(1, Number.isFinite(capacity) ? capacity : DEFAULT_CAPACITY);
  const store = new Map();

  function get(key) {
    if (!store.has(key)) return undefined;
    const value = store.get(key);
    // Touch: move to end.
    store.delete(key);
    store.set(key, value);
    return value;
  }

  function set(key, value) {
    if (store.has(key)) {
      store.delete(key);
    } else if (store.size >= cap) {
      // Evict oldest — Map preserves insertion order, so the first key
      // is the least recently used.
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) store.delete(oldestKey);
    }
    store.set(key, value);
  }

  function has(key) {
    return store.has(key);
  }

  function del(key) {
    return store.delete(key);
  }

  function clear() {
    store.clear();
  }

  return {
    get,
    set,
    has,
    delete: del,
    clear,
    get size() { return store.size; },
    get capacity() { return cap; },
  };
}

// Singleton shared across matcher calls within the same process. Tests
// and callers that want isolation should pass their own cache (or pass
// `cache: false` to disable memoization entirely).
export const defaultSkillMatchCache = createSkillMatchCache();
