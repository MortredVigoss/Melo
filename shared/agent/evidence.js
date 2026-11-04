// A delivery must retain the whole observation ledger, not only the last page.
// Bodies go first to verified reads (ok + executed): those carry the facts the
// answer may cite. Failed or unexecuted rows keep id, provenance and read state
// with a short body. A URL read more than once keeps its longest body once and
// metadata on the other rows, so a long early page never erases the final
// result. Bodies remain untrusted evidence. (2026-11-04: the fair split used to
// give every row chars / N, so thirty observations left each verified page
// with ~800 chars of navigation and the delivery called the facts unverified.)
const SHORT_BODY = 160;
const MAX_BODY = 4000;
export function deliveryEvidence(observations = [], chars = 24000) {
  const rows = Array.isArray(observations) ? observations : [];
  const bodies = rows.map(row => String(row.text || row.output || ''));
  const verified = rows.map(row => row.ok === true && row.executed === true);
  const longestByUrl = new Map();
  rows.forEach((row, index) => {
    if (!verified[index] || !row.url) return;
    const previous = longestByUrl.get(row.url);
    if (previous === undefined || bodies[index].length >= bodies[previous].length) longestByUrl.set(row.url, index);
  });
  const primary = rows.map((row, index) => verified[index] && (!row.url || longestByUrl.get(row.url) === index));
  const primaryCount = primary.filter(Boolean).length;
  const short = Math.max(24, Math.min(SHORT_BODY, Math.floor(chars / Math.max(1, rows.length))));
  const reserved = (rows.length - primaryCount) * short;
  const allowance = primaryCount ? Math.max(short, Math.min(MAX_BODY, Math.floor((chars - reserved) / primaryCount))) : short;
  return rows.map((row, index) => {
    const raw = bodies[index];
    const limit = primary[index] ? allowance : short;
    return { id: row.id, name: row.name, type: row.type, effect: row.effect,
      ok: row.ok === true, executed: row.executed === true, url: row.url,
      reading: row.reading, text: raw.slice(0, limit), truncated: raw.length > limit };
  });
}
