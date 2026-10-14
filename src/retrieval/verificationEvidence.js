// Ephemeral evidence only: never writes fetched bodies or credentials to state.
export function collectVerificationEvidence(pairs = [], { query = '', maxItems = 8 } = {}) {
  const terms = String(query).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  return pairs.slice(-maxItems).reverse().map(({ call, result, receivedAt }) => {
    const raw = typeof result?.output === 'string' ? result.output : JSON.stringify(result?.output ?? '');
    const lower = raw.toLowerCase();
    const match = terms.map(term => lower.indexOf(term)).find(index => index >= 0) ?? 0;
    const start = Math.max(0, match - 300);
    const text = raw.slice(start, start + 2400);
    const meta = result?.metadata || result?.meta || {};
    return {
      id: `tool:${call.id}`,
      tool: call.name,
      ok: result?.ok === true,
      source: String(meta.canonicalUrl || meta.url || call.arguments?.url || call.arguments?.filePath || call.arguments?.path || '').slice(0, 500),
      fetchedAt: receivedAt || '',
      coverage: String(meta.evidenceLevel || meta.coverage || meta.via || meta.method || meta.source || 'unknown').slice(0, 100),
      truncated: start > 0 || text.length < raw.length || (Number(meta.length) > raw.length),
      text,
    };
  });
}

export function buildVerificationEvidence(contextBlocks = [], toolEvidence = []) {
  const evidence = toolEvidence.slice(0, 8).map(entry => ({ ...entry, text: String(entry.text || '').slice(0, 2400) }));
  for (const [index, block] of contextBlocks.entries()) {
    if (typeof block !== 'string' || !block.trim()) continue;
    evidence.push({ id: `context:${index}`, ok: true, coverage: 'background-context', text: block.trim().slice(0, 1800) });
  }
  return evidence;
}

export function isSupportedVerification(payload, evidence) {
  const source = evidence.find(entry => entry.id === payload.evidenceId && entry.ok === true);
  const quote = typeof payload.evidenceQuote === 'string' ? payload.evidenceQuote.trim() : '';
  return Boolean(source && quote.length >= 3 && source.text.includes(quote));
}
