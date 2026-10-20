import { executionMetadata, publicSummaryText } from './executionMetadata.js';

// Browser/server contract. Only observations enter this state; animation has
// no authority to create operations, URLs, progress or candidate results.
export const EXECUTION_MODULES = Object.freeze([
  { id: 'search', name: '网页检索', color: '#edb866', position: [-225, 58, 20] },
  { id: 'compute', name: '分析与计算', color: '#82bccc', position: [-110, -102, 95] },
  { id: 'files', name: '文件与代码', color: '#b9b39b', position: [56, 105, -150] },
  { id: 'tools', name: '工具调用', color: '#b69bcb', position: [232, 54, -80] },
  { id: 'create', name: '模型与成果', color: '#e88c62', position: [142, -116, 40] },
]);
export const TERMINAL_SCENE_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'];
export const sceneFinished = scene => TERMINAL_SCENE_STATUSES.includes(scene?.status);
export const sceneText = (value, max = 1000) => String(value ?? '').slice(0, max);
export function sceneUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}
// Tracking tags do not identify another page. Keep meaningful query values
// and fragments, and preserve the original URL for opening/citation handoff.
export function sceneSourceUrl(value) {
  const href = sceneUrl(value);
  if (!href) return '';
  const url = new URL(href);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_(source|medium|campaign|term|content|id)|gclid|fbclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.search = url.searchParams.toString();
  return url.href;
}
export function sceneKey(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}
// `declared` is the tool's own `uiModule` (tools/tool.js); a valid module id wins
// over the id table below, which stays as the fallback for undeclared tools.
export function moduleForOperation(name = '', args = {}, declared) {
  if (declared && EXECUTION_MODULES.some(m => m.id === declared)) return declared;
  if (name === 'web_search' || name === 'fetch_url' || name === 'web_screenshot' || name === 'native_web_search' || ['browser_open', 'browser_snapshot'].includes(name)) return 'search';
  if (name === 'calculator') return 'compute';
  if (name === 'xlsx' || name === 'pdf' && ['write', 'structured', 'from_spec'].includes(args.action)) return 'create';
  if (name === 'native_image_generation' || name === 'image' && args.action === 'generate') return 'create';
  if (/^(file_read|file_write|file_edit|file_move|file_mkdir|file_delete|glob|grep|knowledge|search_history|media_info|read_file|write_file|edit_file|list_files|search_files|file_search|pdf|document|excel|spreadsheet|image)$/.test(name)) return 'files';
  return 'tools';
}
export function requestedImageCount(text = '') {
  const chinese = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100 };
  const instruction = String(text).replace(/“[^”]*”|「[^」]*」|"[^"]*"/g, '');
  const quantity = /(\d{1,3}|[一两二三四五六七八九十百]+)\s*(?:张|幅)(?:图|图片|照片)?|\b(\d{1,3})\s+(?:images?|pictures?|photos?|posters?|illustrations?)\b/i;
  let match;
  let hasOutputAction = false;
  for (const clause of instruction.split(/[，。；！？,;!?\n]/)) {
    for (const action of clause.matchAll(/生成|绘制|画|制作|输出|出图|\b(?:generate|draw|create|produce|make)\b/gi)) {
      hasOutputAction = true;
      if (/(?:不要|不用|不必|无需|禁止|别)\s*(?:实际|真的|真正)?\s*$|\b(?:do not|don't|never)\s*(?:actually\s*)?$/iu.test(clause.slice(0,action.index))) continue;
      const tail = clause.slice(action.index + action[0].length);
      const candidate = tail.match(quantity);
      if (candidate && !/(?:参考|参照|基于|引用|使用|用|reference|using|from|based on)\s*[^，。；!?;]{0,12}$/iu.test(tail.slice(0,candidate.index)) && !/^\s*(?:参考|(?:as\s+)?references?)/iu.test(tail.slice(candidate.index+candidate[0].length))) {
        match = candidate; break;
      }
    }
    if (match) break;
  }
  if (!match) {
    for (const clause of instruction.split(/[，。；！？,;!?\n]/)) {
      if (/(?:参考|引用|上传|reference|upload)/iu.test(clause)) continue;
      const candidate = clause.match(quantity);
      if (candidate && /^(?:\s*(?:数量|总共|共|给我|要|count|total)(?:\s*(?:为|是|:|：))?)?\s*$/iu.test(clause.slice(0,candidate.index))) {
        match = candidate; break;
      }
    }
  }
  // Bare quantities remain useful for an explicitly selected image task.
  // Descriptions of supplied references must never become output requests.
  if (!match && !hasOutputAction && !/(?:参考|引用|上传|reference|upload)/iu.test(instruction)) match = instruction.match(quantity);
  const value = match?.[1] || match?.[2];
  let count = Number(value) || 0, digit = 0;
  if (!count && value) for (const char of value) {
    const n = chinese[char];
    if (n >= 10) { count += (digit || 1) * n; digit = 0; } else digit = n || 0;
  }
  return Math.max(1, count + digit);
}
export function createExecutionScene({ runId, requestId, chatId, query = '', startedAt = new Date().toISOString() }) {
  return { version: 1, runId, requestId, chatId, query: sceneText(query, 4000), startedAt,
    status: 'running', sequence: 0, operations: [], pipeline: [], sources: [], artifacts: [], previews: [],
    selectedImageIds: [], requestedImages: requestedImageCount(query), lastModule: null, events: [] };
}
const readingWeight = { unknown: 0, snippet: 1, partial: 2, 'range-unknown': 2, extracted: 3 };
export function mergeSceneSources(scene, sources = []) {
  for (const raw of sources) {
    const url = sceneUrl(raw.url), identity = sceneSourceUrl(url);
    if (!url) continue;
    let source = scene.sources.find(item => sceneSourceUrl(item.url) === identity);
    if (!source) {
      source = { id: raw.id || `source-${sceneKey(identity)}`, url, title: new URL(url).hostname, order: scene.sources.length,
        reading: 'unknown', appeared: false, accessed: false, cited: false, providers: [], queries: [] };
      scene.sources.push(source);
    }
    if (raw.title && raw.titleProvided !== false) { source.title = sceneText(raw.title, 300); source.titleProvided = true; }
    if (raw.citationLabel) source.citationLabel = sceneText(raw.citationLabel, 200);
    if (raw.citationUrl && sceneSourceUrl(raw.citationUrl) === identity) source.citationUrl = sceneUrl(raw.citationUrl);
    if (raw.snippet) source.snippet = sceneText(raw.snippet, 900);
    if (raw.rank != null) source.rank = Math.min(source.rank ?? Infinity, Math.max(0, Number(raw.rank) || 0));
    for (const flag of ['appeared', 'opened', 'accessed', 'cached', 'recovered', 'cited']) if (raw[flag]) source[flag] = true;
    if ((readingWeight[raw.reading] ?? -1) >= (readingWeight[source.reading] ?? 0)) source.reading = raw.reading;
    if (raw.characters != null) source.characters = Math.max(source.characters || 0, Number(raw.characters) || 0);
    for (const provider of [...(raw.providers || []), raw.provider].filter(Boolean)) {
      const value = sceneText(provider, 100); if (!source.providers.includes(value)) source.providers.push(value);
    }
    for (const query of [...(raw.queries || []), raw.query].filter(Boolean)) {
      const value = sceneText(query, 300); if (!source.queries.includes(value)) source.queries.push(value);
    }
  }
}
export function applyExecutionEvent(scene, event) {
  if (!scene || sceneFinished(scene) || !event || (event.runId && event.runId !== scene.runId)) return false;
  const sequence = event.sequence || scene.sequence + 1;
  if (sequence <= scene.sequence) return false;
  scene.sequence = sequence;
  const at = event.at || new Date().toISOString();
  if (event.kind === 'image-task' && event.task && ['generate', 'edit'].includes(event.task.action)) {
    scene.imageTask = { action:event.task.action, count:Math.max(1,Math.min(20,Number(event.task.count)||1)), engine:sceneText(event.task.engine,100), model:sceneText(event.task.model,200) };
    scene.requestedImages = scene.imageTask.count;
  }
  if (event.kind === 'preview' && event.id && sceneUrl(event.url)) {
    scene.previews ||= [];
    const previous=scene.previews.find(p=>p.operationId===event.id);
    const preview={operationId:sceneText(event.id,150),url:sceneUrl(event.url),path:sceneText(event.path,2000),index:Math.max(0,Number(event.index)||0)};
    if (!previous) scene.previews.push(preview);
    else if(preview.index >= previous.index) Object.assign(previous,preview);
  }
  if (event.kind === 'pipeline' && event.id) {
    scene.pipeline ||= [];
    let stage = scene.pipeline.find(item => item.id === event.id);
    if (!stage) { stage = { id: event.id, module: event.module === 'compute' ? 'compute' : 'create', name: sceneText(event.name, 100), status: 'queued' }; scene.pipeline.push(stage); }
    if (!TERMINAL_SCENE_STATUSES.includes(stage.status)) {
      for (const key of ['status', 'name', 'input', 'output', 'model', 'returnedModel']) {
        if (event[key] !== undefined) stage[key] = sceneText(event[key], key === 'output' && event.channel === 'reasoning-summary' ? 24000 : 1000);
      }
      if(event.handoff && typeof event.handoff==='object') {stage.handoff=event.handoff;stage.agentId=sceneText(event.agentId,100);stage.memberId=sceneText(event.memberId,100);}
      // Bug audit U5: first sighting of a stage is its start, whatever status
      // it arrives with (a completed-only stage used to have no time at all).
      if (!stage.startedAt) stage.startedAt = at;
      if (TERMINAL_SCENE_STATUSES.includes(event.status)) stage.finishedAt = at;
      if (event.channel === 'reasoning-summary') { stage.channel = 'reasoning-summary'; stage.output = publicSummaryText(stage.output); }
      if (event.api) {
        const next = executionMetadata(event.api);
        stage.api = { ...stage.api, ...next, ...((stage.api?.usage || next.usage) ? { usage: { ...stage.api?.usage, ...next.usage } } : {}) };
      }
      scene.lastModule = stage.module;
    }
  }
  if (event.kind === 'operation' && event.id) {
    let op = scene.operations.find(item => item.id === event.id);
    if (!op) { op = { id: event.id, module: event.module || 'tools', name: sceneText(event.name, 100), status: 'queued' }; scene.operations.push(op); }
    const wasTerminal = ['completed', 'failed', 'cancelled'].includes(op.status);
    if (!wasTerminal || ['completed', 'failed', 'cancelled'].includes(event.status)) {
      for (const key of ['status', 'input', 'output', 'errorCode', 'provider', 'expression', 'result', 'query', 'resultSummary']) {
        if (event[key] !== undefined) op[key] = sceneText(event[key], key === 'output' ? 2200 : 1000);
      }
      if (EXECUTION_MODULES.some(m => m.id === event.module)) op.module = event.module;
      if (event.change) op.change = { path: sceneText(event.change.path, 2000), before: sceneText(event.change.before, 8000), after: sceneText(event.change.after, 8000), truncated: !!event.change.truncated, kind: sceneText(event.change.kind, 40) };
      if (event.command) op.command = sceneText(event.command, 2000);
      if (Number.isInteger(event.exitCode)) op.exitCode = event.exitCode;
      if (event.verification) op.verification = sceneText(event.verification, 100);
      if (event.requestUrl && sceneUrl(event.requestUrl)) op.requestUrl = sceneUrl(event.requestUrl);
      if (event.status === 'running' && !op.startedAt) op.startedAt = at;
      if (['completed', 'failed', 'cancelled'].includes(event.status)) op.finishedAt = at;
    }
    if (event.status === 'running' || op.startedAt) scene.lastModule = op.module;
  }
  mergeSceneSources(scene, event.sources);
  for (const raw of event.artifacts || []) {
    const url = sceneUrl(raw.url);
    if (!url || scene.artifacts.some(item => item.url === url || item.id === raw.id || raw.path && item.path === raw.path)) continue;
    const artifact = { id: sceneText(raw.id || `artifact-${sceneKey(url)}`, 150), url,
      kind: raw.kind === 'image' ? 'image' : 'file', title: sceneText(raw.title || '已生成成果', 200),
      ...(raw.path ? { path: sceneText(raw.path, 2000) } : {}), operationId: event.id || '', createdAt: at };
    for (const key of ['engine','requestedModel','reportedModel']) if(raw[key]) artifact[key]=sceneText(raw[key],200);
    for (const key of ['requestedQuality','reportedQuality']) if (['auto','low','medium','high'].includes(raw[key])) artifact[key]=raw[key];
    if(sceneUrl(raw.beforeUrl) && raw.beforePath) {artifact.beforeUrl=sceneUrl(raw.beforeUrl);artifact.beforePath=sceneText(raw.beforePath,2000);}
    scene.artifacts.push(artifact);
  }
  scene.events.push({ sequence, at, kind: event.kind, id: event.id || '', status: event.status || '' });
  return true;
}
export function finishExecutionScene(scene, { status = 'completed', message, citedUrls = [], at = new Date().toISOString() } = {}) {
  if (!scene || sceneFinished(scene)) return scene;
  scene.status = status;
  scene.finishedAt = at;
  scene.sequence++;
  scene.messageId = message?.id || null;
  if (message?.metadata?.completion) { scene.completion = message.metadata.completion; scene.taskOutcome = scene.completion.outcome; }
  const citations = new Set(citedUrls.map(sceneSourceUrl).filter(Boolean));
  scene.sources.forEach(source => { source.cited = citations.has(sceneSourceUrl(source.url)); });
  for (const op of scene.operations) {
    if (['queued', 'running', 'waiting'].includes(op.status)) {
      op.status = status === 'cancelled' ? 'cancelled' : 'interrupted';
      op.finishedAt = at;
    }
  }
  for (const stage of scene.pipeline || []) {
    if (['queued', 'running', 'waiting'].includes(stage.status)) {
      stage.status = status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'interrupted';
      stage.finishedAt = at;
    }
  }
  scene.selectedImageIds = scene.artifacts.filter(a => a.kind === 'image').slice(0, scene.requestedImages).map(a => a.id);
  // Event-derived resting seed is repeatable across reloads; only atmosphere
  // continues ticking after terminal state, never the crawling animation.
  scene.restSeed = sceneKey(`${scene.runId}:${scene.lastModule}:${scene.sequence}`);
  return scene;
}
export function moduleActivity(scene, module) {
  const ops = module === 'tools' ? (scene?.operations || []) : [
    ...(scene?.operations || []).filter(op => op.module === module),
    ...(scene?.pipeline || []).filter(stage => (stage.module || 'create') === module),
  ];
  const running = sceneFinished(scene) ? [] : ops.filter(op => op.status === 'running');
  return { operations: ops, running, primaryRunning: running.filter(op => op.module === module), waiting: ops.filter(op => op.status === 'waiting'),
    status: running.length ? 'running' : ops.some(op => op.status === 'waiting') ? 'waiting' :
      ops.some(op => op.status === 'failed') ? 'failed' : ops.some(op => op.status === 'cancelled') ? 'cancelled' :
        ops.some(op => op.status === 'interrupted') ? 'interrupted' : ops.length && ops.every(op => op.status === 'completed') ? 'completed' : ops.length ? 'queued' : module === 'search' && scene?.sources.length ? 'recorded' : 'idle' };
}
function relevanceTerms(text) {
  const latin = String(text).toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  const han = String(text).match(/[\u3400-\u9fff]+/g) || [];
  return [...new Set([...latin, ...han.flatMap(word => [...word].slice(0, -1).map((_, i) => word.slice(i, i + 2)))])];
}
export function rankSceneSources(scene) {
  const terms = relevanceTerms([scene?.query, scene?.searchContext, ...(scene?.operations || []).map(op => op.query)].filter(Boolean).join(' '));
  return [...(scene?.sources || [])].map(source => {
    const text = `${source.title} ${source.citationLabel || ''} ${source.url} ${source.snippet || ''}`.toLowerCase();
    const matches = terms.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0);
    return { ...source, relevance: matches * 3 + 2 / (1 + (source.rank ?? source.order)) };
  }).sort((a, b) => b.relevance - a.relevance || a.order - b.order);
}
export function visibleSceneSources(scene, expanded = false) {
  return rankSceneSources(scene).slice(0, expanded ? 10 : 5);
}
export function sourceReadingLabel(source) {
  if (source.accessed) return `${source.cached ? '缓存正文' : '已读取'} · ${{ partial: '部分正文', extracted: '提取正文', 'range-unknown': '范围未知' }[source.reading] || '范围未知'}`;
  if (source.opened) return '已打开 · 未记录正文读取';
  return source.reading === 'snippet' ? '搜索摘要 · 未记录页面读取' : source.appeared ? '搜索结果 · 未记录页面读取' : '引用来源 · 读取范围未知';
}
