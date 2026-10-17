import { moduleForOperation, sceneText, sceneUrl } from '../shared/executionScene.js';
import { verifySignedFileUrl } from '../web/urlSigning.js';
import { observeShellWeb } from './shellWebObservation.js';
import { declaredInputKeys, declaredUiModule } from './tool.js';

const safeText = (value, max = 2200) => sceneText(value, max).replace(/\b(Bearer\s+)[^\s]+/gi, '$1[redacted]')
  .replace(/((?:api[_-]?key|password|access[_-]?token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
// Fallback summary keys for tools that declare no `inputKeys`.
const DEFAULT_INPUT_KEYS = Object.freeze(['query', 'url', 'expression', 'action', 'path', 'file_path', 'operation', 'from', 'to', 'value', 'date', 'offset', 'command', 'cwd']);
export function describeToolInput(args = {}, inputKeys = DEFAULT_INPUT_KEYS) {
  const keys = Array.isArray(inputKeys) ? inputKeys : DEFAULT_INPUT_KEYS;
  return Object.entries(args).filter(([key, value]) => keys.includes(key) && ['string', 'number'].includes(typeof value))
    .map(([key, value]) => `${key}: ${safeText(value)}`).join('\n').slice(0, 1000);
}
// `tool` is optional: the executor passes the tool object so its `uiModule` /
// `inputKeys` self-description wins; id-only callers get the legacy tables.
export function observeTool({ id, name, args = {}, status, result, tool }) {
  const module = moduleForOperation(name, args, declaredUiModule(tool, args));
  const meta = result?.meta || {};
  const event = { kind: 'operation', id, name, module, status, input: describeToolInput(args, declaredInputKeys(tool)), sources: [], artifacts: [] };
  if (result) {
    event.status = meta.aborted && !meta.timedOut ? 'cancelled' : result.ok === false ? 'failed' : 'completed';
    event.output = safeText(result.output || '');
    if (result.ok === false) event.errorCode = meta.denied ? 'PERMISSION_DENIED' : meta.timedOut ? 'TOOL_TIMEOUT' : /^[A-Z_]{2,64}$/.test(result.error || '') ? result.error : 'TOOL_FAILED';
  }
  if (name === 'calculator') {
    event.expression = sceneText(meta.expression || args.expression || event.input);
    if (meta.result !== undefined) event.result = sceneText(meta.result);
  }
  if (result?.ok && meta.change) event.change = { ...meta.change, before: safeText(meta.change.before, 8000), after: safeText(meta.change.after, 8000) };
  if (name === 'bash') {
    event.command = safeText(args.command || '');
    if (Number.isInteger(meta.exitCode)) event.exitCode = meta.exitCode;
    if (/(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint)\b|\b(?:pytest|swift\s+test|cargo\s+test|go\s+test|node\s+--test|xcodebuild)\b/.test(event.command)) {
      event.verification = '实际检查命令';
    }
  }
  if (name === 'bash') Object.assign(event, observeShellWeb(args, result));
  if (name === 'web_search' && result?.ok) {
    event.provider = sceneText(meta.provider || '搜索服务未报告名称', 100);
    event.query = sceneText(meta.query || args.query);
    const read = new Map((meta.contentItems || []).map(item => [item.url, item]));
    event.sources = (meta.results || []).map((source, rank) => {
      const content = read.get(source.url);
      return { url: source.url, title: source.title, snippet: source.snippet, rank, appeared: true,
        query: meta.query || args.query, provider: meta.provider, accessed: !!content,
        cached: !!meta.timings?.cacheHit, reading: content ? 'partial' : source.snippet ? 'snippet' : 'unknown',
        characters: content?.characters || content?.content?.length };
    });
  }
  if (name.startsWith('browser_') && result?.ok && meta.currentUrl) event.sources = [{
    url: meta.currentUrl, title: meta.title, opened: true, accessed: name === 'browser_snapshot',
    reading: name === 'browser_snapshot' ? 'partial' : 'unknown', provider: 'Melo Chrome', characters: meta.textLength }];
  if (name === 'fetch_url' && result?.ok) event.sources = [{ url: meta.url || args.url, title: meta.title,
    provider: meta.method, accessed: true, reading: 'partial', characters: meta.length || result.output?.length }];
  // Metadata is emitted only after the artifact was actually saved by a tool.
  if (result?.ok && meta.url && sceneUrl(meta.url) && (name === 'image' || meta.path)) {
    // Only renew paths proven to have been signed by this Melo process.
    // An external MCP response must not mint access to an arbitrary file.
    const signedPath = verifySignedFileUrl(new URL(meta.url).searchParams);
    event.artifacts.push({ id: `artifact-${id}`, kind: name === 'image' ? 'image' : 'file',
      url: meta.url, ...(signedPath === meta.path ? { path: meta.path } : {}), title: name === 'image' ? args.action === 'generate' ? '生成图片' : '处理后的图片' : '已保存文件', ...(name === 'image' ? {engine:meta.engine,requestedModel:meta.model,reportedModel:meta.reportedModel} : {}) });
  }
  return event;
}

// Provider fields are optional. Absence means unknown, not visited/read.
export function observeNativeItem(item, status = 'running', idPrefix = '') {
  if (!['web_search_call', 'image_generation_call'].includes(item?.type)) return null;
  const search = item.type === 'web_search_call';
  const action = item.action || {};
  const query = action.query || (action.queries || []).join(' · ');
  const event = { kind: 'operation', id: `${idPrefix}${item.id || 'unidentified-native-item'}`,
    name: search ? 'native_web_search' : 'native_image_generation', module: search ? 'search' : 'create',
    provider: 'OpenAI 原生服务', status, query: sceneText(query), input: sceneText(query || action.url || action.type || ''), sources: [] };
  if (search && status === 'completed') {
    event.sources = (action.sources || []).map((source, rank) => ({ url: source.url, title: source.title,
      rank, appeared: true, query, provider: event.provider, reading: 'unknown' }));
    if (['open_page', 'find_in_page'].includes(action.type) && action.url) {
      event.sources.push({ url: action.url, provider: event.provider, accessed: true, reading: 'range-unknown' });
    }
  }
  return event;
}
