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
 *                                         error, cliServers[])
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
 *                                         markdown→pdf, playwright).
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

  const loginBlock=name=>{
    const state=adv.platformLogin?.[name];if(!state) return '';
    const label=({scan:'请用平台 App 扫码，然后检查登录状态',authenticated:'已登录',expired:'二维码已过期',login_required:'尚未登录'})[state.status];
    const src=state.time>Date.now()-180000 && typeof state.image==='string' && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(state.image)?state.image:null;
    return escapeHtml(t(label||'未连接'))+(src?`<div><img width="200" height="200" alt="QR" src="${escapeHtml(src)}"></div>`:'');
  };
  const socialName = name=>['melo-xiaohongshu','melo-douyin'].includes(name);
  const configuredNames=[...new Set([...adv.cliServers,...(data.customize?.mcpAuthSurface || []).filter(s=>s.enabled).map(s=>s.id)])];
  const cliServerRows = configuredNames.length === 0
    ? '<div class="empty-state compact">No active MCP servers.</div>'
    : configuredNames.map(name => ui`
        <div class="list-row">
          <div class="list-row-title mono">${escapeHtml(name)}</div>
          ${socialName(name) && adv.cliServers.includes(name) ? ui`<div data-platform-panel>
            <button type="button" class="small-button" data-action="manage-platform-login" data-server-name="${escapeHtml(name)}" data-login-action="start">扫码登录</button>
            <button type="button" class="small-button" data-action="manage-platform-login" data-server-name="${escapeHtml(name)}" data-login-action="status">检查登录状态</button>
            <div aria-live="polite" data-platform-status>${loginBlock(name)}</div></div>` : ''}
          <div class="list-row-meta">${adv.cliServers.includes(name)?t('已连接'):t(adv.mcpStates?.[name]?.status==='connecting'?'正在连接':'未连接')}</div>
          ${adv.mcpStates?.[name]?.tools?.length?`<details><summary>${t('工具')} (${adv.mcpStates[name].tools.length})</summary><code>${adv.mcpStates[name].tools.map(escapeHtml).join(', ')}</code></details>`:''}
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="${adv.cliServers.includes(name)?'disconnect-mcp-server':'manage-reconnect-mcp'}" data-server-name="${escapeHtml(name)}">
              ${adv.cliServers.includes(name)?t('断开连接'):t('重新连接')}
            </button>
          </div>
        </div>
      `).join('');

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
        const cmdSummary = preset.transport==='in-process' ? 'Melo MCP · '+preset.version : preset.transport==='managed-http' ? 'HTTP · '+preset.version : `${preset?.command || ''} ${(preset?.args || []).join(' ')}`.trim();
        const stateChip = ui`<span class="chip ${enabled ? 'is-accent' : ''}">${enabled ? t('已启用') : t('已停用')}</span>`;
        const buttonLabel = enabled ? t('停用此服务') : t('启用此服务');
        const buttonClass = `small-button${enabled ? ' is-danger' : ' is-primary'}`;
        return ui`
          <div class="list-row">
            <div class="thread-meta">
              ${stateChip}
              <span class="meta-label">flag: <code>${escapeHtml(preset?.flag || '')}</code></span>
            </div>
            <div class="list-row-title mono">${escapeHtml(preset?.id || '(unnamed)')}</div>
            <div class="list-row-meta">${escapeHtml(preset?.description || '')}</div>
            <div class="list-row-meta mono">${escapeHtml(cmdSummary)}</div>
            <div class="inline-actions">
              <button class="${buttonClass}"
                      type="button"
                      data-action="toggle-mcp-preset"
                      data-preset-id="${escapeHtml(preset?.id || '')}"
                      data-preset-flag="${escapeHtml(preset?.flag || '')}"
                      data-next-enabled="${enabled ? '0' : '1'}">
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
            公开平台读取工具默认对所有 Agent 开放，可在「自定义 → Agent」单独关闭。
          </p>
          <div class="list-stack">
            ${presetRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">自定义 HTTP 连接器</h3><button class="small-button" data-action="manage-new-connector">新增连接器</button>
            <span class="meta-label">${externalMcps.length} 个已配置</span>
          </div>
          <div class="list-stack">
            ${externalMcpRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">MCP 服务（stdio / HTTP）</h3>
            <span class="meta-label">${adv.cliServers.length} 个运行中</span>
          </div>
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="reload-mcp-servers">全部重新连接</button>
          </div>
          <div class="list-stack">
            ${cliServerRows}
            <details data-mcp-setup><summary>添加 HTTP MCP 服务</summary>
              <label>ID <input name="name" autocomplete="off"></label>
              <label>URL <input name="url" type="url" list="mcp-hosted-urls" placeholder="https://example.com/mcp"></label>
              <datalist id="mcp-hosted-urls"><option value="https://mcp.browserless.io/mcp">Browserless</option><option value="https://mcp.tavily.com/mcp">Tavily</option><option value="https://mcp.firecrawl.dev/v2/mcp">Firecrawl</option></datalist>
              <label>Bearer token <input name="bearer" type="password" autocomplete="off"></label>
              <button type="button" class="small-button" data-action="manage-add-http-mcp">保存并连接</button>
            </details>
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
