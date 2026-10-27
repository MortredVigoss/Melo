import { AGENT_LOOP_CONTRACT } from './loopContract.js';
import { sessionContext, sessionEventId } from '../../src/shared/sessionEvents.js';
// Portable observations using the existing ExecutionScene projection contract.
// Hosts supply identity/time; this module has no effects or credential access.
const text = (value, max = 2000) => String(value ?? '')
  .replace(/\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._-]{8,}/giu, '[redacted]')
  .replace(/("(?:api_?key|token|secret|password|authorization|cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/giu, '$1"[redacted]"')
  .replace(/([?&][^=&#\s"]*(?:token|key|secret|password|auth|signature)[^=&#\s"]*=)[^&#\s"]*/giu, '$1[redacted]').slice(0, max);
export function observationUrl(value) {
  const raw = String(value), match = /^(https?):\/\/([^\s/?#@]+)((?:[/?#][^\s]*)?)$/iu.exec(raw);
  if (!match || raw.length > 4000) return '';
  return (match[1].toLowerCase() + '://' + match[2].toLowerCase() + (match[3] || '/')).replace(/([?&])([^=&#]+)=([^&#]*)/gu, (all, separator, key) => {
    let name = key; try { name = decodeURIComponent(key); } catch { /* Preserve invalid encodings as data. */ }
    return /token|key|secret|password|auth|signature/i.test(name) ? separator + key + '=[redacted]' : all;
  });
}
export function publicReasoning(items = []) {
  return items.filter(item => item?.type === 'reasoning').flatMap(item => Array.isArray(item.summary) ? item.summary : [])
    .filter(item => item?.type === 'summary_text' && typeof item.text === 'string').map(item => text(item.text, 8000)).join('\n').slice(0, 12000);
}
export function executionScene({ action, scene, runId, chatId, query, at, event = {}, outcome, reason, completion } = {}) {
  if (action === 'create') return { version: 1, runId, chatId, query: text(query, 4000), startedAt: at, status: 'running', sequence: 0, operations: [], pipeline: [], sources: [], artifacts: [], events: [], lastModule: 'compute', taskOutcome: 'running' };
  if (!scene || scene.version !== 1) throw new Error('Unknown execution scene.');
  const next = JSON.parse(JSON.stringify(scene));
  if (scene.status !== 'running') return next;
  if (action === 'finish') {
    next.taskOutcome = ['completed', 'partial', 'blocked', 'needs_user', 'cancelled', 'budget_exhausted', 'failed', 'interrupted'].includes(outcome) ? outcome : 'failed';
    if (completion?.version === 1) next.completion = completion;
    next.status = ['completed', 'cancelled', 'interrupted'].includes(next.taskOutcome) ? next.taskOutcome : 'failed';
    next.finishedAt = at; next.stopReason = text(reason, 500);
    for (const row of [...next.operations, ...next.pipeline]) if (row.status === 'running') { row.status = next.status === 'completed' ? 'interrupted' : next.status; row.finishedAt = at; }
    return next;
  }
  if (action !== 'event') throw new Error('Unknown execution operation.');
  if (event.runId && event.runId !== scene.runId) throw new Error('Execution event belongs to another run.');
  const kind = event.kind === 'operation' ? 'operation' : 'pipeline';
  const rows = kind === 'operation' ? next.operations : next.pipeline;
  if (!event.id || rows.length >= AGENT_LOOP_CONTRACT.guardLimits.executionEvents && !rows.some(row => row.id === event.id)) throw new Error('Execution observation limit.');
  let row = rows.find(item => item.id === event.id);
  if (!row) { row = { id: text(event.id, 256), name: text(event.name, 100), module: ['search', 'tools', 'compute', 'create', 'files'].includes(event.module) ? event.module : 'compute', status: 'running', startedAt: at }; rows.push(row); }
  if (row.status !== 'running') return next;
  for (const key of ['input', 'output', 'model', 'returnedModel', 'errorCode', 'deviceRunId', 'channel']) if (event[key] != null) row[key] = text(event[key], key === 'output' ? 6000 : ['model', 'returnedModel'].includes(key) ? 180 : 2000);
  if (event.result) {
    const result = event.result;
    row.resultSummary = text(result.ok !== true ? result.error || result.summary || result.code || '工具未成功完成' :
      row.name === 'web_search' ? `检索返回 ${(result.results || []).length} 条来源；搜索摘要不等于网页读取。` :
      row.name === 'fetch_url' ? `已读取网页文本 ${String(result.text || '').length} 字符${result.truncated ? '（已截断）' : ''}。内容时效仍需核对。` : result.summary || '已收到成功回执。', 2000);
  }
  if (Number.isFinite(event.durationMs)) row.durationMs = Math.max(0, event.durationMs);
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(event.status)) { row.status = event.status; row.finishedAt = at; }
  for (const raw of (event.sources || []).slice(0, 16)) {
    const url = observationUrl(raw.url);
    if (!url) continue;
    let source = next.sources.find(item => item.url === url);
    if (!source) { source = { id: `source-${next.sources.length}`, url, title: text(raw.title || url, 300), order: next.sources.length, appeared: true, accessed: false, opened: false, cited: false, reading: 'unknown', providers: [], queries: [] }; next.sources.push(source); }
    if (raw.reading === 'snippet' && source.reading === 'unknown') source.reading = 'snippet';
    if (raw.accessed === true) { source.accessed = true; source.reading = 'extracted'; }
    if (typeof raw.snippet === 'string') source.snippet = text(raw.snippet, 900);
  }
  next.lastModule = row.module; next.sequence++;
  return next;
}
export function executionContext(scenes = []) {
  const details = scenes.slice(-3).filter(scene => scene?.version === 1).map(scene => ({
    runId: scene.runId, query: text(scene.query, 1000),
    tools: (scene.operations || []).slice(0, 20).map(row => ({
      eventId: sessionEventId(scene.runId, 'tool', row.id, 'result'), name: text(row.name, 100),
      input: text(row.input, 800), result: text(row.output, 1200),
    })),
    sources: (scene.sources || []).slice(0, 8).map(source => ({ url: observationUrl(source.url), accessed: source.accessed === true, reading: source.reading })),
  }));
  // Preserve the existing Android evidence detail, now explicitly linked to
  // the same event IDs. These are observations, never replayable tool calls.
  while (JSON.stringify(details).length > 8000) {
    const row = details.find(item => item.tools.length);
    if (row) { row.tools.shift(); continue; }
    const sourceRow = details.find(item => item.sources.length);
    if (!sourceRow) break;
    sourceRow.sources.shift();
  }
  return sessionContext(scenes, { maxChars: 7500 }) + (details.length ? '\nRecorded details by event ID: ' + JSON.stringify(details) : '');
}
