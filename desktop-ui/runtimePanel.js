export function renderRuntimePanel(report, escapeHtml) {
  if (!report) return '<p class="page-kicker-tip">正在读取状态，尚未确认各项能力是否可用。</p>';
  const labels = { model: '对话模型', search: '联网搜索', image: '图片', audio: '音频', video: '视频', document: '文档', link: '链接读取', memory: '记忆存储' };
  const rows = [...(report.capabilities || []), { id: 'memory', label: '记忆存储', ...report.memory }];
  const states = { green: '近期验证通过', red: '需要处理', yellow: '待验证 / 部分可用' };
  return `<div class="subsection runtime-diagnostics">
    <h3 class="subsection-title">能力状态</h3>
    <p class="page-kicker-tip">只有真实使用结果才会标记通过；已安装、已配置或历史结果不代表当前可用。</p>
    <div class="quality-status-grid">${rows.map(row => {
      const status = ['green', 'red'].includes(row.status) ? row.status : 'yellow';
      return `<article class="quality-status-card">
        <span>${escapeHtml(labels[row.id] || row.label || row.id)}</span>
        <strong class="runtime-status-${status}">${states[status]}</strong>
        <small>${row.checkedAt ? `最近检查：${escapeHtml(new Date(row.checkedAt).toLocaleString())}` : '暂无近期验证记录'}</small>
        <details class="quality-details"><summary>查看依据</summary>
          <p>${escapeHtml(row.reason || 'not-tested')}</p>
          <p>验证层级：${escapeHtml(row.level || 'storage')}</p>
          ${row.id === 'model' ? `<p>请求模型：${escapeHtml(row.model || '未知')}<br>服务报告：${escapeHtml(row.reportedModel || '未报告')}${row.simulated ? ' · 模拟结果' : ''}</p>` : ''}
        </details>
      </article>`;
    }).join('')}</div>
    <details class="quality-details"><summary>运行环境与存储</summary>
      <p>默认模型：${escapeHtml(report.config?.model || '未配置')} · ${escapeHtml(report.config?.authMode || '')}</p>
      <p>登录状态：${escapeHtml(report.authentication?.reason || '未检查')}</p>
      <p>桌面状态：${escapeHtml(report.desktop?.status || '未知')}</p>
      <p>数据目录：<code>${escapeHtml(report.paths?.home || '')}</code></p>
      <p>配置文件：<code>${escapeHtml(report.paths?.configPath || '')}</code></p>
      <p>${(report.readers || []).map(reader => `${escapeHtml(reader.id)}：${reader.installed ? '已安装，访问待验证' : '未安装'}`).join(' · ')}</p>
      ${(report.storage?.categories || []).map(c => `<p>${escapeHtml(c.label)}：${(Number(c.bytes || 0) / 1024 / 1024).toFixed(1)} MiB</p>`).join('')}
    </details>
  </div>`;
}
