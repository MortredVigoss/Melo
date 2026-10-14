const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function renderExecutionDetail(op, status) {
  const change = op.change;
  return `<button data-execution-action="close-inspector">关闭</button><strong>${escape(op.name)} · ${escape(status)}</strong>
    ${op.channel === 'reasoning-summary' ? '<p>模型公开推理摘要 · 服务实际返回的概述</p>' : ''}
    ${op.verification ? `<p>${escape(op.verification)} · ${op.exitCode == null ? '尚无正常退出码' : `退出码 ${op.exitCode}`}；请结合实际输出核对检查范围。</p>` : ''}
    <pre>${escape(op.command || op.input || '')}</pre>
    ${change ? `<p>${escape(change.path)} · ${change.kind === 'replacement' ? '实际替换片段' : change.kind === 'created' ? '新建文件' : '文件覆盖'}${change.truncated ? ' · 长内容已截断' : ''}</p><div class="execution-diff"><section><b>修改前</b><pre>${escape(change.before || '（空）')}</pre></section><section><b>修改后</b><pre>${escape(change.after || '（空）')}</pre></section></div>` : ''}
    <pre class="execution-detail-output">${escape(op.output || '尚未返回输出')}</pre>`;
}
