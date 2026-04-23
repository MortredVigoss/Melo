// ─── State payload recovery helpers ──────────────────────────────────────────
// Small, pure helpers for parsing Melo's persisted `state.json` blob with a
// soft-recovery fallback. These exist because Electron sometimes flushes
// state.json during a crash, leaving trailing garbage after a valid JSON
// object — `JSON.parse` rejects the whole file, but we can recover if the
// leading `{ ... }` parses cleanly.
//
// This module owns:
//   - recoverLeadingJsonObject(raw) — walk characters balancing `{`/`}`
//     outside strings, returning `source.slice(0, endOfObject+1)` once the
//     root object closes. Returns null for anything that doesn't start
//     with `{`. Handles escaped quotes inside strings.
//   - parseStatePayload(raw) — try JSON.parse(raw) first; if that throws,
//     try recoverLeadingJsonObject + JSON.parse again, and return either
//     `{ parsed, repaired: null }` on success or `{ parsed, repaired: <string> }`
//     when recovery trimmed the file. Re-throws the original parse error
//     if no prefix can be recovered.
//
// Extracted from desktopStore.js in Phase 10b refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no external deps.

export function recoverLeadingJsonObject(raw = '') {
  const source = String(raw || '');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (!started) {
      if (/\s/.test(char)) {
        continue;
      }

      if (char !== '{') {
        return null;
      }

      started = true;
      depth = 1;
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(0, index + 1);
      }
    }
  }

  return null;
}

export function parseStatePayload(raw = '') {
  try {
    return { parsed: JSON.parse(raw), repaired: null };
  } catch (error) {
    const recovered = recoverLeadingJsonObject(raw);
    if (!recovered) {
      throw error;
    }

    return { parsed: JSON.parse(recovered), repaired: recovered };
  }
}
