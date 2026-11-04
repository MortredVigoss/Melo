const MAX_TEXT = 32000;
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;
const IMAGE = /^image\/(?:png|jpeg|webp|gif)$/i;
const safeWebUrl = uri => { try { const u = new URL(uri); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };

// Content is untrusted. Links without bodies are candidates, never read evidence.
// Binary attachments stay out of the text result, tool history, and receipts.
export function mcpResultToToolResult(result) {
  const chunks = [], images = [], sources = []; let bytes = 0, truncated = false;
  function add(text) { if (typeof text !== 'string' || !text) return; const room = Math.max(0, MAX_TEXT - bytes); if (text.length > room) truncated = true; if (room) { chunks.push(text.slice(0, room)); bytes += chunks.at(-1).length + 1; } }
  function attach(mime, data) {
    if (IMAGE.test(mime) && typeof data === 'string' && data.length && images.length < MAX_IMAGES && images.reduce((n,s)=>n+s.length,0)+data.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      images.push(`data:${mime};base64,${data}`); add(`[image ${images.length}: ${mime}]`);
    } else { add('[Binary attachment omitted: unsupported type or size.]'); }
  }
  function resource(uri,text) {
    const url = safeWebUrl(uri);
    if (url && sources.length < 16) sources.push({ url, text: String(text || '').slice(0,16000), reading: !text ? 'snippet' : text.length > 16000 ? 'partial' : 'extracted' });
  }
  for (const block of result?.content || []) {
    if (block.type === 'text') add(block.text);
    else if (block.type === 'image') attach(block.mimeType, block.data);
    else if (block.type === 'resource') {
      const r = block.resource || {}; let text = r.text;
      if (!text && r.blob && (r.mimeType?.startsWith('text/') || r.mimeType === 'application/json')) {
        text = Buffer.from(r.blob.slice(0, MAX_TEXT*4), 'base64').toString('utf8');
        if (r.blob.length > MAX_TEXT*4) truncated = true;
      }
      add(r.uri); if (text) add(text); else if (r.blob) attach(r.mimeType, r.blob);
      resource(r.uri,text);
    } else if (block.type === 'resource_link') { add(block.uri); resource(block.uri); }
    else add(`[${block.type || 'unknown'} attachment omitted]`);
  }
  if (result?.structuredContent !== undefined) {
    const json = JSON.stringify(result.structuredContent);
    if (!chunks.includes(json)) add(json);
  }
  const body = chunks.join('\n');
  const ok = !!result && !result.isError && !!(body || images.length);
  return { ok, output: body + (truncated ? '\n[Partial result: content limit reached.]' : '') || '(no output)',
    ...(!ok ? {error:'MCP_TOOL_FAILED'} : {}), completionSources: ok ? sources : [],
    meta: { ...(images.length ? {modelImage:images[0],modelImages:images} : {}), truncated } };
}
