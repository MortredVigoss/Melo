import { renderBehaviorSettings } from './behaviorSettings.js';
import { formatTime } from './format.js';
import {renderConnectorManagement} from './managementActions.js';
import {renderRetainedFiles} from './chatFiles.js';
import { t, ui } from './i18n.js';
/**
 * Advanced page renderer (Customize → Advanced).
 *
 * Lifted out of app.js so its branches — empty-state for each subsection,
 * error banner, the "Refresh" button label flip while loading, the lazy
 * first-fetch trigger — can be exercised by smoke tests under
 * `node --test`.  The body is byte-for-byte identical to the previous
 * inline version; the only changes are:
 *
 *   - `data` / `adv` / `escapeHtml` / `scheduleRefresh` arrive as
 *     explicit params instead of being closed over from app.js's
 *     module scope.  Logic is unchanged.
 *   - The lazy-fetch line `Promise.resolve().then(refreshAdvancedStatus)`
 *     is now `scheduleRefresh()`; callers wrap their async refresher
 *     however they like.  Net runtime behaviour is identical because
 *     the original line was already a fire-and-forget microtask.
 *
 * Tests in advancedPage.test.js cover the four subsections and the
 * loading / error transitions.
 */

/**
 * @param {Object} options
 * @param {Object} options.data            uiState.bootstrap shape (connectors[], …)
 * @param {Object} options.adv             uiState.advanced shape (loaded, loading,
 *                                         error, cliServers[], plugins[], tasks[])
 * @param {Function} options.escapeHtml    HTML-escape helper from app.js
 * @param {Function} options.scheduleRefresh fire-and-forget hook called once on
 *                                         the very first render (loaded=false &&
 *                                         loading=false && error=null) so the
 *                                         caller can kick its async refresher.
 * @param {string} [options.statePathHint] verified config path copied by the
 *                                         Copy-path button. Empty until runtime
 *                                         diagnostics resolves the active home.
 * @param {Array<{id: string, command?: string, args?: string[], description?: string,
 *                flag: string, enabled: boolean}>} [options.mcpPresets]
 *                                         Built-in MCP server presets (AntV chart,
 *                                         markdown→pdf, playwright, browserless).
 *                                         Each row renders as a toggle that flips
 *                                         the underlying `enable*Mcp` config flag.
 *                                         When omitted the section shows an
 *                                         empty-state.
 * @returns {string} HTML string for the Advanced pane.
 */
import { renderRuntimePanel } from './runtimePanel.js';

export function renderAdvancedPage({
  data,
  adv,
  escapeHtml,
  scheduleRefresh,
  statePathHint = '',
  mcpPresets = [],
  taskPanelHtml = '',
  approvalPanelHtml = '',
}) {
  // Lazy first fetch on initial render of this section.
  if (!adv.loaded && !adv.loading && !adv.error) {
    scheduleRefresh();
  }

  const externalMcps = (data.customize?.connectors || data.connectors || []).filter(c => c.type === 'external-mcp');

  const externalMcpRows = externalMcps.length === 0
    ? ui`<div class="empty-state compact">尚未添加外部连接器。</div>`
    : externalMcps.map(c => ui`
        <div class="list-row">
          <div class="thread-meta">
            <span class="chip ${c.config?.lastStatus === 'ok' ? 'is-accent' : ''}">${escapeHtml(c.config?.lastStatus || 'idle')}</span>
            <span class="chip">${Number(c.config?.toolCount || 0)} tools</span>
            <span class="chip">${Number(c.config?.resourceCount || 0)} resources</span>
            <span class="chip">${Number(c.config?.promptCount || 0)} prompts</span>
            <span class="meta-label">${escapeHtml(c.config?.lastCheckedLabel || 'Never checked')}</span>
          </div>
          <div class="list-row-title">${escapeHtml(c.name)}</div>
          <div class="list-row-meta">${escapeHtml(c.config?.endpoint || '')}</div>
          ${renderConnectorManagement(c,escapeHtml)}
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="ping-connector" data-connector-id="${escapeHtml(c.id)}">
              Ping (refresh)
            </button>
          </div>
        </div>
      `).join('');

  const configuredNames=[...new Set([...adv.cliServers,...(data.customize?.mcpAuthSurface || []).filter(s=>s.enabled && !s.unpinned).map(s=>s.id)])];
  const cliServerRows = configuredNames.length === 0
    ? '<div class="empty-state compact">No active CLI / stdio MCP servers.</div>'
    : configuredNames.map(name => ui`
        <div class="list-row">
          <div class="list-row-title mono">${escapeHtml(name)}</div>
          <div class="list-row-meta">${adv.cliServers.includes(name)?t('已连接'):t('未连接')}</div>
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="${adv.cliServers.includes(name)?'disconnect-mcp-server':'manage-reconnect-mcp'}" data-server-name="${escapeHtml(name)}">
              ${adv.cliServers.includes(name)?t('断开连接'):t('重新连接')}
            </button>
          </div>
        </div>
      `).join('');

  const pluginRows = adv.plugins.length === 0
    ? '<div class="empty-state compact">No plugins registered.</div>'
    : adv.plugins.map(p => ui`
        <div class="list-row">
          <div class="list-row-title mono">${escapeHtml(p.id || '(unnamed)')}</div>
          <div class="list-row-meta">${escapeHtml((Array.isArray(p.hooks) ? p.hooks : []).join(', ') || 'no hooks')}</div>
        </div>
      `).join('');

  const taskRows = adv.tasks.length === 0
    ? '<div class="empty-state compact">No background runs.</div>'
    : adv.tasks.map(t => {
        const isRunning = t.status === 'running';
        const fmt = t.startedAt ? formatTime(t.startedAt, { style:'clock' }) : '—';
        return ui`
          <div class="list-row">
            <div class="thread-meta">
              <span class="chip ${isRunning ? 'is-accent' : ''}">${escapeHtml(t.status || 'unknown')}</span>
              ${t.exitCode != null ? ui`<span class="chip">exit ${Number(t.exitCode)}</span>` : ''}
              <span class="meta-label">started ${escapeHtml(fmt)}</span>
            </div>
            <div class="list-row-title mono">${escapeHtml(t.command || '(no command)')}</div>
            ${isRunning
              ? ui`<div class="inline-actions">
                  <button class="small-button is-danger" type="button" data-action="kill-background-task" data-run-id="${escapeHtml(t.runId)}">
                    结束任务
                  </button>
                </div>`
              : ''}
          </div>
        `;
      }).join('');

  const errorBlock = adv.error
    ? ui`<div class="alert compact-alert">${escapeHtml(adv.error)}</div>`
    : '';

  // Built-in MCP server presets (browser automation + AntV chart +
  // markdown→pdf).  Each row renders as a "list-row" with a toggle so
  // the user can flip the underlying enableXxxMcp config flag without
  // hand-editing config.json.  Per-agent whitelisting is a separate
  // surface in the Customize → Agents page.
  const presetRows = (mcpPresets || []).length === 0
    ? '<div class="empty-state compact">No built-in MCP server presets registered.</div>'
    : (mcpPresets || []).map(preset => {
        const enabled = Boolean(preset?.enabled);
        const unpinned = Boolean(preset?.unpinned);
        const cmdSummary = `${preset?.command || ''} ${(preset?.args || []).join(' ')}`.trim();
        // Codex 四轮 audit 2026-04-29: an unpinned preset has 3
        // possible UI states, not 2:
        //   - unpinned + enabled  → user can still DISABLE to
        //     clean up legacy config (was set true before the
        //     pinning sweep landed); button stays clickable but
        //     only flips off — server-side toggle refuses
        //     enabled:true for unpinned, but enabled:false is
        //     always allowed (cleanup path).
        //   - unpinned + disabled → "Unavailable", button truly
        //     disabled; clicking would only ever try to enable.
        //   - pinned → normal Enable/Disable.
        const isLegacyEnableOnUnpinned = unpinned && enabled;
        const stateChip = unpinned
          ? (isLegacyEnableOnUnpinned
              ? ui`<span class="chip is-warning">假启用 · 未锁定版本</span>`
              : ui`<span class="chip">不可用 · 未锁定版本</span>`)
          : ui`<span class="chip ${enabled ? 'is-accent' : ''}">${enabled ? t('已启用') : t('已停用')}</span>`;
        const buttonLabel = unpinned
          ? (isLegacyEnableOnUnpinned ? t('停用（清理假启用）') : t('不可用'))
          : (enabled ? t('停用此服务') : t('启用此服务'));
        const buttonClass = unpinned
          ? (isLegacyEnableOnUnpinned ? 'small-button is-danger' : 'small-button')
          : `small-button${enabled ? ' is-danger' : ' is-primary'}`;
        const buttonDisabled = unpinned && !isLegacyEnableOnUnpinned;
        return ui`
          <div class="list-row${unpinned && !isLegacyEnableOnUnpinned ? ' is-disabled-preset' : ''}">
            <div class="thread-meta">
              ${stateChip}
              <span class="meta-label">flag: <code>${escapeHtml(preset?.flag || '')}</code></span>
            </div>
            <div class="list-row-title mono">${escapeHtml(preset?.id || '(unnamed)')}</div>
            <div class="list-row-meta">${escapeHtml(preset?.description || '')}</div>
            <div class="list-row-meta mono">${escapeHtml(cmdSummary)}</div>
            ${unpinned
              ? ui`<div class="list-row-meta muted-note">npm 包尚未锁定到精确版本 — ${
                  isLegacyEnableOnUnpinned
                    ? ui`点击「停用」清除旧的 enable*Mcp:true 配置。`
                    : 'toggle disabled until a version lands in <code>PINNED_VERSIONS</code>.'
                }</div>`
              : ''}
            <div class="inline-actions">
              <button class="${buttonClass}"
                      type="button"
                      data-action="toggle-mcp-preset"
                      data-preset-id="${escapeHtml(preset?.id || '')}"
                      data-preset-flag="${escapeHtml(preset?.flag || '')}"
                      data-next-enabled="${enabled ? '0' : '1'}"
                      ${buttonDisabled ? 'disabled' : ''}>
                ${buttonLabel}
              </button>
            </div>
          </div>
        `;
      }).join('');

  return ui`
    <div class="customize-pane page-advanced">
      <div class="detail-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">
              系统状态
              <span class="chip">本机工作空间</span>
            </h2>
            <p class="page-kicker">
              查看哪些能力可用、哪些连接需要处理。技术参数和扩展管理收在下方。
            </p>

          </div>
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="refresh-advanced-status">
              ${adv.loading ? t('检查中…') : t('刷新状态')}
            </button>
          </div>
        </div>

        ${errorBlock}
        ${renderBehaviorSettings(data.settings?.config || {})}
        ${taskPanelHtml}
        ${approvalPanelHtml}
        <button class="small-button" data-action="manage-session-permissions">对话工具授权</button>
        ${renderRuntimePanel(adv.diagnostics, escapeHtml)}
        ${renderRetainedFiles(adv.retainedFiles,escapeHtml)}

        <details class="quality-details"><summary>扩展与连接管理</summary>
        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">内置 MCP 服务</h3>
            <span class="meta-label">${(mcpPresets || []).filter(p => p?.enabled).length} / ${(mcpPresets || []).length} 已启用</span>
          </div>
          <p class="page-kicker-tip">
            stdio MCP 会运行本机进程；每个 Agent 需在 自定义 → Agent 里逐个勾选。
          </p>
          <div class="list-stack">
            ${presetRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">外部 MCP 连接器</h3><button class="small-button" data-action="manage-new-connector">新增连接器</button>
            <span class="meta-label">${externalMcps.length} 个已配置</span>
          </div>
          <div class="list-stack">
            ${externalMcpRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">CLI / stdio MCP 服务</h3>
            <span class="meta-label">${adv.cliServers.length} 个运行中</span>
          </div>
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="reload-mcp-servers">全部重新连接</button>
          </div>
          <div class="list-stack">
            ${cliServerRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">插件</h3>
            <span class="meta-label">${adv.plugins.length} 个已注册</span>
          </div>
          <div class="list-stack">
            ${pluginRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">后台命令任务</h3>
            <span class="meta-label">${adv.tasks.length} 次运行</span>
          </div>
          <div class="list-stack">
            ${taskRows}
          </div>
        </div>
        </details>
        <details class="quality-details"><summary>技术详情</summary>            <p class="page-kicker page-kicker-tip">
              ${statePathHint ? ui`配置文件：<code>${escapeHtml(statePathHint)}</code>
              <button class="ghost-link" type="button"
                      data-action="copy-melo-state-path"
                      data-path="${escapeHtml(statePathHint)}">
                复制路径
              </button>` : t('刷新后显示配置文件路径。')}
            </p>
        </details>
      </div>
    </div>
  `;
}
