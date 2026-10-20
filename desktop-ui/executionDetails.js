export { renderExecutionTiming } from './executionTiming.js';
import { t, ui } from './i18n.js';
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : null;
const seconds = value => amount(value) === null ? null : `${(value / 1000).toFixed(2)} s`;
export function executionApiLine(op) {
  const api = op.api;
  if (!api) return '';
  const usage = api.usage || {};
  return [api.reportedModel || op.model,
    amount(usage.input) !== null ? `输入 ${amount(usage.input)}` : '',
    amount(usage.output) !== null ? `输出 ${amount(usage.output)} token` : '',
    seconds(api.durationMs) ? `耗时 ${seconds(api.durationMs)}` : '',
    !api.usage ? t("用量未返回") : '',
  ].filter(Boolean).join(' · ');
}
function renderApi(op) {
  const a = op.api;
  if (!a) return '';
  const rows = [
    [t("请求模型"), op.model], [t("返回模型"), a.reportedModel], [t("API 协议"), a.transport], [t("响应编号"), a.responseId],
    [t("服务最后状态"), a.responseStatus], [t("结束原因"), a.finishReason],
    [t("请求耗时（本机）"), seconds(a.durationMs)], [t("首个事件（本机）"), seconds(a.firstEventMs)], [t("首段正文（本机）"), seconds(a.firstTextMs)],
    [t("输入 token"), amount(a.usage?.input)], [t("输出 token"), amount(a.usage?.output)], [t("总 token（服务）"), amount(a.usage?.total)],
    [t("缓存命中 token"), amount(a.usage?.cached)], [t("缓存写入 token"), amount(a.usage?.cacheWrite)], [t("推理 token（输出内）"), amount(a.usage?.reasoning)],
    [t("返回字符"), amount(a.outputCharacters)], [t("公开摘要段数"), amount(a.summaryParts)],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  return ui`<section class="execution-api-detail" aria-label="API 返回数据"><p>${a.simulated ? t("模拟响应数据") : t("API 返回与本机计时")}${a.usage ? '' : ' · 用量未返回'}${a.summaryTruncated ? ' · 摘要较长，保留前 24,000 字符' : ''}</p><dl>${rows.map(([key, value]) => ui`<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl></section>`;
}
export function renderExecutionSignal(scene) {
  const stages = scene?.pipeline || [];
  const model = stages.filter(stage => stage.api && stage.channel !== 'reasoning-summary').at(-1);
  const summary = stages.filter(stage => stage.channel === 'reasoning-summary' && (!model || stage.id === `${model.id}:summary`)).at(-1);
  const latest = summary || model;
  if (!latest) return '';
  return ui`<button class="execution-signal" data-execution-action="inspect" data-operation="${escape(latest.id)}" aria-label="查看最新 API 记录"><b>${summary ? t("公开推理摘要") : t("API 返回记录")} · ${scene.status === 'running' ? t("本轮实时记录") : t("历史回看")}</b><span>${escape(summary?.output?.slice(-240) || model?.output || t("等待服务返回"))}</span><small>${escape(executionApiLine(model || latest))} · 点击展开</small></button>`;
}
export function renderReasoningRecords(scene, statusNames) {
  const stages = (scene?.pipeline || []).filter(stage => stage.channel === 'reasoning-summary');
  if (!stages.length) return '';
  stages.push(...(scene?.operations || []).filter(op => op.module === 'compute'));
  return ui`<div class="execution-reasoning-records" aria-label="公开推理摘要记录">${stages.map(stage => ui`<button data-execution-action="inspect" data-operation="${escape(stage.id)}"><b>${escape(stage.expression || stage.name)} · ${escape(statusNames[stage.status] || stage.status)}</b><p>${escape(stage.result || stage.output || t("等待返回"))}</p><small>${escape(executionApiLine(stage))} · 展开详情</small></button>`).join('')}</div>`;
}
export function renderExecutionDetail(op, status) {
  // v1 portable scenes carry the handoff in output, preserving old readers.
  if(!op.handoff&&typeof op.output==='string')try{const h=JSON.parse(op.output);if(h&&typeof h.subtask==='string'&&typeof h.conclusion==='string'&&Array.isArray(h.evidence)&&Array.isArray(h.changedFiles)&&Array.isArray(h.unfinished))op={...op,handoff:h};}catch{}
  const change = op.change;
  const summary = op.channel === 'reasoning-summary';
  const output = ui`<pre class="execution-detail-output">${escape(op.output || t("尚未返回输出"))}</pre>`;
  return ui`<button data-execution-action="close-inspector">关闭</button><strong>${escape(op.name)} · ${escape(status)}</strong>
    ${op.handoff ? ui`<section><strong>成员交接记录</strong><p>${escape(op.agentId)} · ${escape(op.handoff.status)}</p>${op.handoff.completion?.summary ? `<p>${escape(op.handoff.completion.summary)}</p>` : ''}<pre>${escape(op.handoff.conclusion)}</pre><p>证据与来源</p><pre>${escape((op.handoff.evidence||[]).join('\n'))}</pre><p>改动文件</p><pre>${escape((op.handoff.changedFiles||[]).join('\n'))}</pre><p>未完成事项</p><pre>${escape((op.handoff.unfinished||[]).join('\n'))}</pre><p>${op.handoff.usage?.unknown ? '用量未完整报告' : `${op.handoff.usage?.input??0} + ${op.handoff.usage?.output??0} tokens`} · ${op.handoff.usage?.estimatedCost==null?'费用未知':`${op.handoff.usage.estimatedCost}`}</p></section>` : ''}
    ${summary ? ui`<p>模型公开推理摘要 · 服务实际返回的概述</p>${output}` : ''}
    ${renderApi(op)}
    ${op.verification ? ui`<p>${escape(op.verification)} · ${op.exitCode == null ? t("尚无正常退出码") : `退出码 ${op.exitCode}`}；请结合实际输出核对检查范围。</p>` : ''}
    <pre>${escape(op.command || op.input || '')}</pre>
    ${change ? ui`<p>${escape(change.path)} · ${change.kind === 'replacement' ? t("实际替换片段") : change.kind === 'created' ? t("新建文件") : t("文件覆盖")}${change.truncated ? ' · 长内容已截断' : ''}</p><div class="execution-diff"><section><b>修改前</b><pre>${escape(change.before || t("（空）"))}</pre></section><section><b>修改后</b><pre>${escape(change.after || t("（空）"))}</pre></section></div>` : ''}
    ${summary ? '' : output}`;
}

export function renderSessionEvents(events = []) {
  if (!events.length) return '';
  return ui`<details class="execution-delivery-details execution-session-events"><summary>执行记录</summary>${events.map(event => `<p data-session-event-id="${escape(event.eventId)}"><b>${escape(event.name || event.kind)} · ${escape(event.status)}</b>${event.resultState === 'unknown' ? ' · 结果未知，请先核对再继续' : ''}<br><small>${escape(event.eventId)}</small></p>`).join('')}</details>`;
}
