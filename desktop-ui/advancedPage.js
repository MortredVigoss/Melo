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
 * @returns {string} HTML string for the Advanced pane.
 */
export function renderAdvancedPage({ data, adv, escapeHtml, scheduleRefresh }) {
  // Lazy first fetch on initial render of this section.
  if (!adv.loaded && !adv.loading && !adv.error) {
    scheduleRefresh();
  }

  const externalMcps = (data.connectors || []).filter(c => c.type === 'external-mcp');

  const externalMcpRows = externalMcps.length === 0
    ? '<div class="empty-state compact">No external MCP connectors configured. Configuration UI is deferred — for now, manage via the connector config files directly.</div>'
    : externalMcps.map(c => `
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
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="ping-connector" data-connector-id="${escapeHtml(c.id)}">
              Ping (refresh)
            </button>
          </div>
        </div>
      `).join('');

  const cliServerRows = adv.cliServers.length === 0
    ? '<div class="empty-state compact">No active CLI / stdio MCP servers.</div>'
    : adv.cliServers.map(name => `
        <div class="list-row">
          <div class="list-row-title mono">${escapeHtml(name)}</div>
          <div class="list-row-meta">stdio-launched MCP server</div>
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="disconnect-mcp-server" data-server-name="${escapeHtml(name)}">
              Disconnect
            </button>
          </div>
        </div>
      `).join('');

  const pluginRows = adv.plugins.length === 0
    ? '<div class="empty-state compact">No plugins registered.</div>'
    : adv.plugins.map(p => `
        <div class="list-row">
          <div class="list-row-title mono">${escapeHtml(p.id || '(unnamed)')}</div>
          <div class="list-row-meta">${escapeHtml((Array.isArray(p.hooks) ? p.hooks : []).join(', ') || 'no hooks')}</div>
        </div>
      `).join('');

  const taskRows = adv.tasks.length === 0
    ? '<div class="empty-state compact">No background runs.</div>'
    : adv.tasks.map(t => {
        const isRunning = t.status === 'running';
        const fmt = t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : '—';
        return `
          <div class="list-row">
            <div class="thread-meta">
              <span class="chip ${isRunning ? 'is-accent' : ''}">${escapeHtml(t.status || 'unknown')}</span>
              ${t.exitCode != null ? `<span class="chip">exit ${Number(t.exitCode)}</span>` : ''}
              <span class="meta-label">started ${escapeHtml(fmt)}</span>
            </div>
            <div class="list-row-title mono">${escapeHtml(t.command || '(no command)')}</div>
            ${isRunning
              ? `<div class="inline-actions">
                  <button class="small-button is-danger" type="button" data-action="kill-background-task" data-run-id="${escapeHtml(t.runId)}">
                    Kill
                  </button>
                </div>`
              : ''}
          </div>
        `;
      }).join('');

  const errorBlock = adv.error
    ? `<div class="alert compact-alert">${escapeHtml(adv.error)}</div>`
    : '';

  return `
    <div class="customize-pane page-advanced">
      <div class="detail-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">
              Advanced
              <span class="chip is-accent">Experimental</span>
            </h2>
            <p class="page-kicker">
              Developer features. Status, reload, disconnect, and kill operations are safe — configuration changes (adding new MCP servers, editing endpoints) happen elsewhere or are deferred.
            </p>
          </div>
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="refresh-advanced-status">
              ${adv.loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        ${errorBlock}

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">External MCP connectors</h3>
            <span class="meta-label">${externalMcps.length} configured</span>
          </div>
          <div class="list-stack">
            ${externalMcpRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">CLI / stdio MCP servers</h3>
            <span class="meta-label">${adv.cliServers.length} active</span>
          </div>
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="reload-mcp-servers">Reload all</button>
          </div>
          <div class="list-stack">
            ${cliServerRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">Plugins</h3>
            <span class="meta-label">${adv.plugins.length} registered</span>
          </div>
          <div class="list-stack">
            ${pluginRows}
          </div>
        </div>

        <div class="subsection">
          <div class="header-row">
            <h3 class="subsection-title">Background shell tasks</h3>
            <span class="meta-label">${adv.tasks.length} runs</span>
          </div>
          <div class="list-stack">
            ${taskRows}
          </div>
        </div>
      </div>
    </div>
  `;
}
