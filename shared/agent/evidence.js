// A delivery must retain the whole observation ledger, not only the last page.
// Allocate body text fairly; IDs, provenance and read state never disappear
// because an earlier page was large. Bodies remain untrusted evidence.
export function deliveryEvidence(observations = [], chars = 24000) {
  const rows = Array.isArray(observations) ? observations : [];
  const allowance = Math.max(24, Math.floor(chars / Math.max(1, rows.length)));
  return rows.map(row => {
    const raw = String(row.text || row.output || '');
    return { id: row.id, name: row.name, type: row.type, effect: row.effect,
      ok: row.ok === true, executed: row.executed === true, url: row.url,
      reading: row.reading, text: raw.slice(0, Math.min(2000, allowance)),
      truncated: raw.length > Math.min(2000, allowance) };
  });
}
