// Commit receipts (architecture plan P1, 2026-10-19). A business mutation
// reports what its transaction actually committed instead of assembling the
// whole desktop bootstrap. Every field comes from the state object that
// updateStateAtomically returned after the manifest commit; nothing here
// invents data:
//   • revision   — the persisted manifest `_revision` (state.json format ≥ 2).
//                  persistStateAtomically increments it once per real commit;
//                  a no-op transaction keeps the previous committed value.
//   • changedIds — keys whose record differs from the record the mutator
//                  started from (added records count as changed).
//   • removedIds — keys present before the mutator ran and absent afterwards.
// Records are compared as canonical JSON (sorted keys), i.e. by the value
// that reaches disk, so key order alone never reports a change.

function canonicalJson(value) {
  return JSON.stringify(value, (key, field) => field && typeof field === 'object' && !Array.isArray(field)
    ? Object.fromEntries(Object.keys(field).sort().map(name => [name, field[name]]))
    : field);
}

function recordEntries(records) {
  if (Array.isArray(records)) return records.filter(record => record && record.id != null).map(record => [String(record.id), record]);
  if (records && typeof records === 'object') return Object.entries(records);
  return [];
}

/** Capture a keyed collection (array of `{id}` rows or an id → record map) before the mutator edits it. */
export function recordSnapshot(records) {
  return new Map(recordEntries(records).map(([id, record]) => [id, canonicalJson(record)]));
}

/** Compare a snapshot from `recordSnapshot` with the committed collection. */
export function diffRecords(before, records) {
  const after = recordSnapshot(records);
  const changedIds = [...after].filter(([id, json]) => before.get(id) !== json).map(([id]) => id);
  const removedIds = [...before.keys()].filter(id => !after.has(id));
  return { changedIds, removedIds };
}

/** The manifest revision carried by a committed state object. */
export function committedRevision(state) {
  return Number(state?._revision) || 0;
}
