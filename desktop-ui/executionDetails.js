import { t, ui } from './i18n.js';
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function renderExecutionDetail(op, status) {
  // v1 portable scenes carry the handoff in output, preserving old readers.
  if(!op.handoff&&typeof op.output==='string')try{const h=JSON.parse(op.output);if(h&&typeof h.subtask==='string'&&typeof h.conclusion==='string'&&Array.isArray(h.evidence)&&Array.isArray(h.changedFiles)&&Array.isArray(h.unfinished))op={...op,handoff:h};}catch{}
  const change = op.change;
  return ui`<button data-execution-action="close-inspector">关闭</button><strong>${escape(op.name)} · ${escape(status)}</strong>
    ${op.handoff ? ui`<section><strong>成员交接记录</strong><p>${escape(op.agentId)} · ${escape(op.handoff.status)}</p><pre>${escape(op.handoff.conclusion)}</pre><p>证据与来源</p><pre>${escape((op.handoff.evidence||[]).join('\n'))}</pre><p>改动文件</p><pre>${escape((op.handoff.changedFiles||[]).join('\n'))}</pre><p>未完成事项</p><pre>${escape((op.handoff.unfinished||[]).join('\n'))}</pre><p>${op.handoff.usage?.unknown ? '用量未完整报告' : `${op.handoff.usage?.input??0} + ${op.handoff.usage?.output??0} tokens`} · ${op.handoff.usage?.estimatedCost==null?'费用未知':`${op.handoff.usage.estimatedCost}`}</p></section>` : ''}
    ${op.channel === 'reasoning-summary' ? ui`<p>模型公开推理摘要 · 服务实际返回的概述</p>` : ''}
    ${op.verification ? ui`<p>${escape(op.verification)} · ${op.exitCode == null ? t("尚无正常退出码") : `退出码 ${op.exitCode}`}；请结合实际输出核对检查范围。</p>` : ''}
    <pre>${escape(op.command || op.input || '')}</pre>
    ${change ? ui`<p>${escape(change.path)} · ${change.kind === 'replacement' ? t("实际替换片段") : change.kind === 'created' ? t("新建文件") : t("文件覆盖")}${change.truncated ? ' · 长内容已截断' : ''}</p><div class="execution-diff"><section><b>修改前</b><pre>${escape(change.before || t("（空）"))}</pre></section><section><b>修改后</b><pre>${escape(change.after || t("（空）"))}</pre></section></div>` : ''}
    <pre class="execution-detail-output">${escape(op.output || t("尚未返回输出"))}</pre>`;
}
