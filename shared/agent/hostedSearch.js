// Credential values never enter Core. Hosts supply opaque credential/account digests.
export function connectionIdentity(input = {}) {
  return JSON.stringify([input.authMode || '', input.protocol || '', String(input.endpoint || '').trim().replace(/\/+$/u, ''),
    String(input.model || '').trim(), input.credentialFingerprint || '', input.accountFingerprint || '']);
}

export function hostedCapability(proof, fingerprint, now) {
  const age = now - Number(proof?.checkedAt);
  return { status: proof?.version === 1 && proof.status === 'verified' && proof.fingerprint === fingerprint && Number.isFinite(age) && age >= 0 && age < 86_400_000 ? 'verified' : 'unknown' };
}

export function hostedSearchReceipt({ items = [], text = '' } = {}) {
  const completed = items.filter(item => item?.type === 'web_search_call' && item.status === 'completed');
  const messages = items.filter(item => item?.type === 'message').flatMap(item => item.content || []);
  const raw = [...completed.flatMap(item => item.action?.sources || []), ...messages.flatMap(part => (part.annotations || []).filter(annotation => annotation.type === 'url_citation'))];
  const sources = [...new Map(raw.filter(row => typeof row?.url === 'string' && /^https?:\/\/[^\s]+$/iu.test(row.url)).map(row => [row.url, { url: row.url.slice(0, 4000), title: String(row.title || row.url).slice(0, 200) }])).values()].slice(0, 16);
  const body = (text || messages.map(part => typeof part.text === 'string' ? part.text : '').join('\n')).slice(0, 100_000);
  const links = sources.filter(source => !body.includes(source.url)).map(source => `[${source.title.replace(/[\[\]\\\n\r]/gu, ' ')}](<${source.url.replace(/[<>]/gu, character => encodeURIComponent(character))}>)`);
  return { verified: completed.length > 0, sources, freshness: 'unknown',
    answer: body + (links.length ? '\n\nSources:\n' + links.join('\n') : ''),
    evidence: 'Provider-reported completed Search and source URLs only; individual pages and live business status were not independently verified.' };
}

export function hostedSearchProof({ receipt, fingerprint, now }) {
  return { version: 1, status: receipt?.verified === true ? 'verified' : 'unknown', fingerprint, checkedAt: now };
}
