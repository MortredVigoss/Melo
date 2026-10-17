import { t, currentLanguage } from './i18n.js';

const terminal = value => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value?.status);
const instant = value => typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Merge overlapping model requests: parallel members and summary telemetry
// must not multiply the wall-clock time shown to the user.
function intervalDuration(items, end) {
  const intervals = items.flatMap(item => {
    const start = instant(item.startedAt), stop = instant(item.finishedAt) ?? (terminal(item) ? null : end);
    return start !== null && stop !== null && stop >= start ? [[start, stop]] : [];
  }).sort((a, b) => a[0] - b[0]);
  if (!intervals.length) return null;
  let total = 0, [start, stop] = intervals[0];
  for (const [a, b] of intervals.slice(1)) {
    if (a > stop) { total += stop - start; start = a; stop = b; }
    else stop = Math.max(stop, b);
  }
  return total + stop - start;
}
export function executionTiming(scene, now = Date.now()) {
  if (!scene) return null;
  const legacy = scene.runId?.startsWith('legacy-');
  const done = terminal(scene), start = legacy ? null : instant(scene.startedAt), finished = legacy ? null : instant(scene.finishedAt);
  const end = done ? finished : now;
  const elapsedMs = start !== null && end !== null && end >= start ? end - start : null;
  const modelMs = intervalDuration((scene.pipeline || []).filter(stage => /^model:/.test(stage.id) && stage.channel !== 'reasoning-summary' && !stage.id.endsWith(':summary')), end);
  const images = (scene.artifacts || []).filter(a => a?.kind === 'image');
  const imageOps = (scene.operations || []).filter(op => ['image_edit', 'native_image_generation'].includes(op.name) || op.name === 'image' && op.module === 'create');
  const imageStages = (scene.pipeline || []).filter(stage => stage.id === 'image:generate');
  const hasImages = scene.imageTask || scene.imageProgress || imageOps.length || imageStages.length || images.length;
  let image = null;
  if (hasImages) {
    const requested = Math.max(1, Math.floor(Number(scene.imageTask?.count ?? scene.imageProgress?.requested ?? scene.requestedImages) || 1));
    const saved = scene.imageProgress ? Math.max(0, Math.floor(Number(scene.imageProgress.saved) || 0)) : images.length;
    const starts = [scene.imageProgress?.startedAt, ...imageOps.map(op => op.startedAt), ...imageStages.map(stage => stage.startedAt)].map(instant).filter(v => v !== null);
    const imageStart = starts.length ? Math.min(...starts) : null;
    const savedTimes = [scene.imageProgress?.finishedAt, ...images.map(a => a.createdAt)].map(instant).filter(v => v !== null);
    const savedAt = savedTimes.length ? Math.max(...savedTimes) : null;
    const imageEnd = saved >= requested ? savedAt : end;
    image = { requested, saved, percent: Math.min(100, Math.floor(saved / requested * 100)), savedAt,
      elapsedMs: imageStart !== null && imageEnd !== null && imageEnd >= imageStart ? imageEnd - imageStart : null };
  }
  return { done, elapsedMs, modelMs, finishedAt: finished, completed: scene.status === 'completed', image };
}
export function formatExecutionDuration(ms) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return t('用时未记录');
  return t('{seconds} 秒', { seconds: Math.floor(ms / 1000).toLocaleString(currentLanguage()) });
}
function dateText(value) {
  return new Date(value).toLocaleString(currentLanguage(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
export function renderExecutionTiming(scene, now = Date.now()) {
  const value = executionTiming(scene, now); if (!value) return '';
  const labels = [value.elapsedMs === null ? t('用时未记录') : t(value.done ? '本轮用时 {time}' : '已用时 {time}', { time: formatExecutionDuration(value.elapsedMs) })];
  if (value.modelMs !== null) labels.push(t('思考与回复 {time}', { time: formatExecutionDuration(value.modelMs) }));
  if (value.done && value.finishedAt !== null) labels.push(t(value.completed ? '完成于 {time}' : '停止于 {time}', { time: dateText(value.finishedAt) }));
  const img = value.image;
  const progress = img ? `<div class="execution-image-progress"><span>${escape(t('图片成果 {percent}% · 已保存 {saved}/{total} 张', { percent: img.percent, saved: img.saved, total: img.requested }))}</span><progress value="${img.percent}" max="100" aria-label="${escape(t('图片成果进度'))}"></progress>${img.elapsedMs !== null ? `<span>${escape(t('图片处理 {time}', { time: formatExecutionDuration(img.elapsedMs) }))}</span>` : ''}${img.savedAt !== null ? `<span>${escape(t('图片保存于 {time}', { time: dateText(img.savedAt) }))}</span>` : ''}${!value.done && img.percent < 100 ? `<small>${escape(t('按已保存张数计；单张生成进度未提供'))}</small>` : ''}</div>` : '';
  return `<div class="execution-timing"><span title="${escape(t('本轮含等待和工具执行；思考与回复为模型请求用时，并非内部推理计时'))}">${labels.map(escape).join(' · ')}</span>${progress}</div>`;
}
