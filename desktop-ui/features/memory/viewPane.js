// Customize → Memory pane (architecture plan P2, 2026-10-19). Byte-for-byte
// move out of desktop-ui/app.js; the bodies still read the transitional
// context (./context.js) until the feature owns its state.
import { ui } from '../../i18n.js';
import { renderMemoryFacts } from './viewFacts.js';
import { uiState, escapeHtml } from './context.js';
import { memoryFactEdit, refreshMemoryStatus } from './controller.js';

function fmtMemoryBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMemoryRelTime(ms) {
  if (ms == null) return '—';
  const age = Date.now() - ms;
  const s = Math.floor(age / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderMemoryPane() {
  const { loading, loaded, snapshot, error, wipeConfirmOpen, wipeInFlight, wipeResult } = uiState.memoryStatus;
  if (!loaded && !loading && !error) {
    // Kick off the first fetch; re-render happens inside refreshMemoryStatus.
    Promise.resolve().then(refreshMemoryStatus);
  }
  const content = (() => {
    if (loading && !snapshot) {
      return ui`<div class="empty-state compact">正在检查记忆…</div>`;
    }
    if (error) {
      return ui`<div class="alert compact-alert">${escapeHtml(error)}</div>`;
    }
    if (!snapshot) {
      return ui`<div class="empty-state compact">暂无状态，点击刷新检查。</div>`;
    }
    const s = snapshot;
    const drift = s.embedding?.drift || {};
    const diagnosis = uiState.memoryStatus.diagnosis;
    const needsRebuild = diagnosis ? diagnosis.issues.some(issue => ['model_changed', 'missing_index'].includes(issue.code)) : drift.hasDrift;
    const semanticStatus = diagnosis?.available === false ? '暂不可用' : needsRebuild ? '需要重建' : diagnosis?.available ? '检测通过' : drift.inferredProvider ? '已配置 · 待检测' : drift.probeAttempted ? '暂不可用' : '未检测';
    const metaRows = s.meta
      ? Object.entries(s.meta)
          .map(([k, v]) => ui`<div class="meta-label">${escapeHtml(k)}</div><div class="mono">${escapeHtml(String(v))}</div>`)
          .join('')
      : '<div class="list-row-meta">(not yet populated)</div>';
    return ui`
      <div class="detail-card memory-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">记忆</h2>
            <p class="page-kicker">查看 Melo 记住了什么，以及哪些检索能力当前可用。</p>
          </div>
          <div class="inline-actions">
            <button class="small-button" data-action="refresh-memory-status">刷新</button>
          </div>
        </div>

        ${s.derivedIndex ? ui`<p class="page-kicker" role="status">${escapeHtml(({ready:'最近保存的内容已进入检索索引',pending:'内容已保存，检索索引正在后台更新',deferred:'内容已保存，索引更新暂缓，稍后自动重试',inline:'当前以本机同步方式更新索引'})[s.derivedIndex.status] || '正在检查索引状态')}</p>` : ''}
        ${drift.hasDrift ? ui`
          <div class="alert compact-alert">
            <strong>Embedding model drift detected.</strong>
            Stored vectors were written by <span class="mono">${escapeHtml(drift.stored || '?')}</span>
            but the active provider reports <span class="mono">${escapeHtml(drift.inferredProvider || '?')}</span>.
            Recall quality may degrade until old vectors are rebuilt.
          </div>
        ` : ''}

        <div class="quality-status-grid">
          <div class="quality-status-card"><span>已保存记忆</span><strong>${s.counts.memories ?? '—'}</strong><small>记录保存在本机</small></div>
          <div class="quality-status-card"><span>关键词索引</span><strong>${s.counts.memoriesFts == null ? '未确认' : s.counts.memoriesFts > 0 ? '已建立' : '等待内容'}</strong><small>可按文字检索已有记录</small></div>
          <div class="quality-status-card"><span>语义检索</span><strong>${semanticStatus}</strong><small>${diagnosis?.available === false ? '当前使用关键词检索；已有文字记忆保留' : diagnosis?.available ? '以实际检索结果为准' : '点击检测模型，验证检索是否可用'}</small></div>
        </div>
        <section class="quality-details">
          <h3>检索模型与索引</h3>
          <p>模型就绪后会在后台分批建立索引。需要修复时可安全重建，原文与旧索引保留到新索引通过验证。</p>
          <div class="inline-actions"><button class="small-button" data-action="memory-diagnose" ${uiState.memoryStatus.repairBusy ? 'disabled' : ''}>检测模型</button>
          <button class="small-button" data-action="memory-repair" ${uiState.memoryStatus.repairBusy ? 'disabled' : ''}>${s.repair?.completed && s.repair.status !== 'complete' ? '继续修复' : '安全重建索引'}</button>
          ${uiState.memoryStatus.repairBusy ? ui`<button class="small-button" data-action="memory-pause">本批完成后暂停</button>` : ''}</div>
          ${s.repair ? ui`<p role="status">${escapeHtml(s.repair.status === 'complete' ? '已验证并切换' : s.repair.status === 'failed' ? '修复暂停' : '待继续')} · ${s.repair.completed}/${s.repair.total} · ${escapeHtml(s.repair.error || s.repair.note || '')}</p>` : ''}
          ${uiState.memoryStatus.diagnosis ? ui`<p role="status">${escapeHtml(uiState.memoryStatus.diagnosis.available ? '实际嵌入请求成功' : '关键词检索模式')} · ${escapeHtml(uiState.memoryStatus.diagnosis.issues.map(i => i.message).join(' '))}</p>` : ''}
          <p>Melo 内置多语言嵌入模型，在本机后台运行，无需安装其他软件。模型资源随应用提供；检索不会自动调用外部服务。</p>
        </section>
        ${renderMemoryFacts(uiState.memoryFacts,{query:uiState.memoryFactQuery,editing:uiState.memoryFactEditing,busy:uiState.memoryFactBusy,draft:uiState.memoryFactDraft,session:memoryFactEdit,feedback:uiState.memoryFactFeedback})}
        <details class="quality-details"><summary>技术详情与维护</summary>
        <div class="meta-block-label">Store</div>
        <div class="meta-grid">
          <div><div class="meta-label">Path</div><div class="mono small">${escapeHtml(s.store.path)}</div></div>
          <div><div class="meta-label">Exists</div><div>${s.store.exists ? 'yes' : 'no'}</div></div>
          <div><div class="meta-label">Size</div><div>${fmtMemoryBytes(s.store.sizeBytes)}</div></div>
          <div><div class="meta-label">Memories</div><div>${s.counts.memories ?? '—'}</div></div>
          <div><div class="meta-label">FTS rows</div><div>${s.counts.memoriesFts ?? '—'}</div></div>
          <div><div class="meta-label">Vectors</div><div>${s.counts.vecMemories ?? '—'}</div></div>
          <div><div class="meta-label">Embed cache</div><div>${s.counts.embeddingCache ?? '—'}</div></div>
        </div>

        <div class="meta-block-label">Embedding</div>
        <div class="meta-grid">
          <div><div class="meta-label">Provider</div><div class="mono">${escapeHtml(s.embedding.provider)}</div></div>
          <div><div class="meta-label">Dims (configured)</div><div>${s.embedding.dimsConfigured}</div></div>
          <div><div class="meta-label">Model (stored)</div><div class="mono">${escapeHtml(s.embedding.storedModelId || '(not yet recorded)')}</div></div>
          <div><div class="meta-label">Model (live)</div><div class="mono">${escapeHtml(drift.inferredProvider || (drift.probeAttempted ? '(provider unavailable)' : '(probe skipped)'))}</div></div>
        </div>

        <div class="meta-block-label">Recall tuning (env)</div>
        <div class="meta-grid">
          <div><div class="meta-label">MMR λ</div><div class="mono">${s.tuning.mmrLambda}</div></div>
          <div><div class="meta-label">Recency half-life</div><div class="mono">${s.tuning.recencyHalfLifeDays}d</div></div>
        </div>
        <p class="list-row-meta">
          Set <span class="mono">MELO_MMR_LAMBDA</span> and <span class="mono">MELO_RECENCY_HALF_LIFE_DAYS</span>
          in the launch environment to override.
        </p>

        <div class="meta-block-label">Dreams</div>
        <div class="meta-grid">
          <div><div class="meta-label">Directory</div><div class="mono small">${escapeHtml(s.dreams.dir)}</div></div>
          <div><div class="meta-label">Count</div><div>${s.dreams.count}</div></div>
          <div><div class="meta-label">Latest</div><div class="mono">${escapeHtml(s.dreams.latest?.name || '—')}</div></div>
          <div><div class="meta-label">Last written</div><div>${fmtMemoryRelTime(s.dreams.latest?.mtimeMs)}</div></div>
        </div>

        <div class="subsection">
          <div class="meta-block-label">Maintenance</div>
          <div class="toggle-row">
            <div>
              <div class="list-row-title">Wipe stored embeddings</div>
              <div class="list-row-meta">
                Clears every <span class="mono">embedding</span> column and drops <span class="mono">vec_memories</span>.
                The next embed pass repopulates from the current provider's vector space.
                Memory rows themselves stay; only vectors are cleared. Use this after a deliberate
                provider swap.
              </div>
            </div>
            <button class="small-button is-danger" data-action="memory-wipe-open" ${wipeInFlight ? 'disabled' : ''}>
              Wipe embeddings…
            </button>
          </div>
          ${wipeConfirmOpen ? ui`
            <div class="alert compact-alert">
              <div><strong>This clears every stored vector.</strong> Memory rows and settings are untouched.</div>
              <div class="inline-actions" style="margin-top: 8px;">
                <button class="small-button is-danger" data-action="memory-wipe-confirm" ${wipeInFlight ? 'disabled' : ''}>
                  ${wipeInFlight ? 'Wiping…' : 'Yes, wipe embeddings'}
                </button>
                <button class="small-button" data-action="memory-wipe-cancel" ${wipeInFlight ? 'disabled' : ''}>Cancel</button>
              </div>
            </div>
          ` : ''}
          ${wipeResult ? ui`<div class="list-row-meta" style="margin-top: 8px;">${escapeHtml(wipeResult)}</div>` : ''}
        </div>

        <div class="subsection">
          <div class="meta-block-label">_meta table</div>
          <div class="meta-grid">${metaRows}</div>
        </div>
        </details>
      </div>
    `;
  })();
  return ui`<div class="customize-pane">${content}</div>`;
}

export { renderMemoryPane, fmtMemoryBytes, fmtMemoryRelTime };
