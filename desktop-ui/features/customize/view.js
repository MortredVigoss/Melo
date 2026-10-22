// Customize page — renderers and selectors
// (architecture B3 step 1, 2026-10-20). Byte-for-byte move out of
// desktop-ui/app.js: function bodies and their comments are unchanged; case
// bodies of app.js's click / submit dispatchers became the action and form
// handlers below (one indentation level less, top-level `break;` → `return;`,
// equivalent because nothing followed the switch inside its try block).
// app.js names they read come from ./context.js (transitional, live bindings).
import { renderSkillManagement } from '../../managementActions.js';
import { t, ui } from '../../i18n.js';
// Built-in connectors are authored Chinese (stateHydration BUILTIN_CONNECTORS) and
// translated here; an external connector shows the user's own text.
const connectorText = (connector, field) => connector?.type === 'external-mcp' ? String(connector?.[field] || '') : t(String(connector?.[field] || ''));
import { renderAdvancedPage } from '../../advancedPage.js';
import { credentialChipState } from '../../credentialChip.js';
import { agentsFeature, approvalsFeature, effectiveModelSetupDraft, escapeHtml, getBootstrap, memoryFeature, modelSetupDraft, renderApprovalPanel, renderCommandRunner, renderProjectArtifactShelf, renderSelectedFilePreview, renderTaskPanel } from './context.js';
import { customizeState } from './state.js';
import { refreshAdvancedStatus, refreshDomainCookies, refreshSafetyAllowlist, refreshSkillMarkdown } from './controller.js';

function selectedCustomizeItem() {
  if (!getBootstrap()) return null;
  if (getBootstrap().settings.selectedCustomizeSection === 'agents') {
    return getBootstrap().customize.agents.find(
      agent => agent.id === getBootstrap().settings.selectedAgentId,
    );
  }
  if (getBootstrap().settings.selectedCustomizeSection === 'skills') {
    return getBootstrap().customize.skills.find(
      skill => skill.id === getBootstrap().settings.selectedSkillId,
    );
  }

  return getBootstrap().customize.connectors.find(
    connector => connector.id === getBootstrap().settings.selectedConnectorId,
  );
}

// Phase 3.3.2 — apply Customize → Skills filter state (query + tag + state)
// to the full skill list. Returns a new array; does not mutate bootstrap.
function filteredSkills() {
  const all = getBootstrap()?.customize?.skills || [];
  const { query, tag, state } = customizeState.skillFilter;
  const q = (query || '').trim().toLowerCase();

  return all.filter(skill => {
    // State filter.
    if (state === 'enabled' && !skill.enabled) return false;
    if (state === 'disabled' && skill.enabled) return false;
    if (state === 'custom' && skill.source !== 'custom') return false;
    if (state === 'builtin' && skill.source !== 'built-in') return false;
    if (state === 'disk' && skill.origin !== 'disk') return false;

    // Tag filter (exact, case-insensitive).
    if (tag) {
      const tags = Array.isArray(skill.tags) ? skill.tags : [];
      if (!tags.some(t => String(t).toLowerCase() === String(tag).toLowerCase())) {
        return false;
      }
    }

    // Free-text query over name, id, description, tags, triggers.
    if (q) {
      const haystack = [
        skill.name,
        skill.id,
        skill.description,
        ...(skill.tags || []),
        ...(skill.triggers || []),
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

// All unique tags across the current skill set, sorted alphabetically.
// Used to render the tag-filter chip row.
function allSkillTags() {
  const all = getBootstrap()?.customize?.skills || [];
  const set = new Set();
  for (const skill of all) {
    for (const tag of skill.tags || []) {
      if (tag) set.add(String(tag).toLowerCase());
    }
  }
  return [...set].sort();
}

function renderConnectorDetails(selected) {
  if (!selected) {
    return '<div class="empty-state">Select a skill, agent, or connector to inspect it.</div>';
  }

  if (getBootstrap().settings.selectedCustomizeSection==='connectors' && ['local-files','local-command'].includes(selected.id)) return ui`<section class="detail-card"><p>本地文件与命令由 Agent 能力设置控制。</p><button class="small-button" data-action="open-view" data-view="agent">查看 Agent 能力</button></section>`;

  if (getBootstrap().settings.selectedCustomizeSection === 'agents') {
    return agentsFeature.renderWorkbench(selected);
  }

  if (getBootstrap().settings.selectedCustomizeSection === 'skills') {
    const isCustomSkill = selected.source === 'custom';
    const isExecutable = selected.type === 'executable';
    const allowedAgentIds = Array.isArray(selected.allowedAgentIds) ? selected.allowedAgentIds : null;
    const isGlobalSkill = !allowedAgentIds || allowedAgentIds.length === 0;
    const toolWhitelist = Array.isArray(selected.toolWhitelist) ? selected.toolWhitelist : null;
    // Phase 3 — Overview | Markdown tabs.
    const activeTab = customizeState.skillDetailTab || 'overview';
    if (activeTab === 'markdown') {
      return renderSkillMarkdownTab(selected);
    }
    return ui`
      <div class="detail-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
            <p class="page-kicker">${escapeHtml(selected.description)}</p>
          </div>
          <div class="chip-row">
            <span class="chip ${isCustomSkill ? 'is-accent' : ''}">${isCustomSkill ? t('自定义技能') : t('内置技能')}</span>
            <span class="chip ${isExecutable ? 'is-accent' : ''}">${isExecutable ? t('可执行') : t('提示词')}</span>
            <span class="chip">${isGlobalSkill ? t('全局') : t('仅限 {count} 个 Agent', { count: allowedAgentIds.length })}</span>
            ${selected._suspicious ? `<span class="chip is-danger">⚠ ${t('可疑')}</span>` : ''}
          </div>
        </div>

        ${renderSkillDetailTabs(selected, activeTab)}

        <div class="meta-grid">
          <div>
            <div class="meta-block-label">添加者</div>
            <div>${escapeHtml(selected.addedBy)}</div>
          </div>
          <div>
            <div class="meta-block-label">调用方</div>
            <div>${escapeHtml(selected.invokedBy)}</div>
          </div>
          <div>
            <div class="meta-block-label">最多迭代次数</div>
            <div>${Number(selected.maxIterations || 6)}</div>
          </div>
          <div>
            <div class="meta-block-label">工具白名单</div>
            <div>${toolWhitelist ? escapeHtml(toolWhitelist.join(', ')) : t('（全部工具）')}</div>
          </div>
        </div>

        <div class="detail-meta">
          <div>${escapeHtml(selected.systemPrompt)}</div>
          <div class="chip-row">
            ${(selected.folders || [])
              .map(folder => ui`<span class="chip">${escapeHtml(folder)}</span>`)
              .join('')}
          </div>
          ${
            !isGlobalSkill
              ? ui`<div class="chip-row">
                   <span class="meta-label">仅对以下 Agent 可见：</span>
                   ${allowedAgentIds
                     .map(aid => ui`<span class="chip">${escapeHtml(aid)}</span>`)
                     .join('')}
                 </div>`
              : ''
          }
        </div>

        <div class="toggle-row">
          <div>
            <div class="list-row-title">开启</div>
            <div class="list-row-meta">让已开启技能的 Agent 能发现这个技能。</div>
          </div>
          <button
            class="toggle-switch ${selected.enabled ? 'is-on' : ''}"
            data-action="toggle-skill"
            data-skill-id="${selected.id}"
          ></button>
        </div>

        ${isCustomSkill ? ui`
          <form id="skill-custom-update-form-${selected.id}" class="config-form" data-form="skill-custom-update" data-skill-id="${selected.id}">
            <div class="detail-meta">
              <div class="meta-block-label">编辑自定义技能</div>
            </div>
            <label class="label">
              名称
              <input class="input" name="name" value="${escapeHtml(selected.name)}" required />
            </label>
            <label class="label">
              描述
              <input class="input" name="description" value="${escapeHtml(selected.description || '')}" />
            </label>
            <label class="label">
              添加者
              <input class="input" name="addedBy" value="${escapeHtml(selected.addedBy || '')}" />
            </label>
            <label class="label">
              调用方
              <input class="input" name="invokedBy" value="${escapeHtml(selected.invokedBy || '')}" />
            </label>
            <label class="label">
              系统提示词
              <textarea class="config-textarea" name="systemPrompt">${escapeHtml(selected.systemPrompt || '')}</textarea>
            </label>
            <label class="label">
              类型
              <select class="input" name="type">
                <option value="executable" ${selected.type === 'executable' ? 'selected' : ''}>可执行 — 作为工具在循环中调用</option>
                <option value="prompt" ${selected.type === 'prompt' ? 'selected' : ''}>提示词 — 原样注入系统提示词</option>
              </select>
            </label>
            <label class="label">
              最多迭代次数（仅可执行）
              <input class="input" type="number" name="maxIterations" min="1" max="16" value="${Number(selected.maxIterations || 6)}" />
            </label>
            <label class="label">
              允许的 Agent（逗号分隔 ID，留空表示全部）
              <input class="input mono" name="allowedAgentIds" value="${escapeHtml((selected.allowedAgentIds || []).join(', '))}" />
            </label>
            <label class="label">
              工具白名单（逗号分隔工具 ID，留空表示全部）
              <input class="input mono" name="toolWhitelist" value="${escapeHtml((selected.toolWhitelist || []).join(', '))}" />
            </label>
            <label class="label">
              文件夹（逗号分隔）
              <input class="input" name="folders" value="${escapeHtml((selected.folders || []).join(', '))}" />
            </label>
            <div class="inline-actions">
              <button class="small-button is-primary" type="submit">保存修改</button>
              <button
                class="small-button is-danger"
                type="button"
                data-action="remove-custom-skill"
                data-skill-id="${selected.id}"
              >移除技能</button>
            </div>
          </form>
        ` : ''}
      </div>
    `;
  }

  const workspace = getBootstrap().workspace;
  let extra = '';

  if (selected.type === 'external-mcp') {
    // External-MCP connectors are now managed from Customize → Advanced.
    // The list filter on Customize → Connectors hides them, but a stale
    // selectedConnectorId can still point here — render a redirect notice
    // instead of the legacy edit form (Codex audit / config edits deferred).
    return ui`
      <div class="detail-card">
        <div class="header-row">
          <div>
            <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
            <p class="page-kicker">外部 MCP 连接器已移至 自定义 → 高级。</p>
          </div>
          <span class="chip is-accent">实验性</span>
        </div>
        <div class="detail-meta">
          <div>Status, reload, and disconnect are available there. Configuration editing is deferred until the dedicated MCP UI lands.</div>
        </div>
      </div>
    `;
  }

  if (selected.id === 'openai-compatible') {
    // Read editable values from the shared draft so that any background
    // render (mcpAuthSurface poll, undo-toast tick, autosave response)
    // doesn't blow away in-flight typing. Read-only fields (codexAuth,
    // masked* / has* status flags) keep coming from selected.config.
    const draft = effectiveModelSetupDraft();
    // Visible save-status chip for masked credential inputs
    // (Codex audit 2026-04-29 — user reported "保存不了" when in
    // fact every save was succeeding; the password mask hid the
    // confirmation).  The pure state machine lives in
    // `desktop-ui/credentialChip.js` so it's covered by node:test;
    // we only translate the state here into the visible chip
    // markup. The "saved" state is reached when the explicit Save
    // clears the field from `modelSetupDraft` (clearModelFormDraft)
    // — without that clear the chip would stay stuck on "pending".
    const credentialChip = fieldName => {
      const { state, masked } = credentialChipState(
        fieldName,
        modelSetupDraft(),
        selected.config,
      );
      if (state === 'pending') {
        return ui`<span class="chip is-warning is-tiny">● 待保存（点击保存后生效）</span>`;
      }
      if (state === 'saved') {
        return ui`<span class="chip is-success is-tiny">✓ 已保存 · ${escapeHtml(masked)}</span>`;
      }
      return ui`<span class="chip is-tiny">● 未配置</span>`;
    };
    extra = ui`
      <p>模型地址、密钥和登录授权在模型连接中统一管理。</p>
      <button type="button" class="small-button" data-action="open-view" data-view="model">打开模型连接</button>
      <form id="connector-config-form" class="config-form" data-form="connector-config">
        <div class="detail-meta">
          <div class="meta-block-label">语音转写（Whisper）</div>
          <div>用于音频和语音消息转写。</div>
          <div>API 密钥模式：自动使用主 API 密钥，无需额外配置。</div>
          <div>本地模式：自动使用本机 Ollama 地址，无需授权。</div>
          <div>Codex OAuth 模式：自动尝试本机 Ollama（http://127.0.0.1:11434/v1），运行 ollama serve 后可用；也可以在下方单独设置 Whisper 密钥。</div>
          <div>下方字段会覆盖任何模式的自动选择。</div>
        </div>
        <label class="label">
          <span class="label-row"><span>Whisper API 密钥（可选覆盖）</span>${credentialChip('whisperApiKey')}</span>
          <input
            class="input"
            name="whisperApiKey"
            type="password"
            value=""
            placeholder="${escapeHtml(selected.config.maskedWhisperApiKey || t('留空则使用自动检测的密钥'))}"
          />
        </label>
        <div class="list-row-meta">
          ${selected.config.hasWhisperKey ? t('已保存覆盖密钥：{key}', { key: escapeHtml(selected.config.maskedWhisperApiKey) }) : t('没有覆盖密钥，按授权模式自动检测。')}
          <span>留空保持当前设置。</span>
        </div>
        <label class="label">
          Whisper 服务地址（可选覆盖）
          <input
            class="input"
            name="whisperBaseUrl"
            value="${escapeHtml(draft.whisperBaseUrl || '')}"
            placeholder="留空则使用自动检测的地址"
          />
        </label>

        <div class="detail-meta">
          <div class="meta-block-label">MiniMax T2A V2（克隆音色朗读）</div>
          <div>为语音面板中的“自定义语音”提供声音。在 minimaxi.com 创建或克隆音色后，把凭据粘贴到下方，可用试听按钮直接验证。</div>
        </div>
        <label class="label">
          <span class="label-row"><span>MiniMax API 密钥</span>${credentialChip('minimaxApiKey')}</span>
          <input
            class="input"
            name="minimaxApiKey"
            type="password"
            value=""
            placeholder="${escapeHtml(selected.config.maskedMinimaxApiKey || t('留空保持当前值'))}"
          />
        </label>
        <div class="list-row-meta">
          ${selected.config.hasMinimaxKey ? t('已保存密钥：{key}', { key: escapeHtml(selected.config.maskedMinimaxApiKey) }) : t('没有 MiniMax 密钥，朗读会回退到 OpenAI / Edge。')}
          <span>留空保持当前值。</span>
        </div>
        <label class="label">
          MiniMax Group ID
          <input
            class="input"
            name="minimaxGroupId"
            value="${escapeHtml(draft.minimaxGroupId || '')}"
            placeholder="在 MiniMax 控制台中查看"
          />
        </label>
        <label class="label">
          默认音色 ID
          <input
            class="input"
            name="minimaxVoiceId"
            value="${escapeHtml(draft.minimaxVoiceId || '')}"
            placeholder="moss_audio_… 或任意克隆音色 ID"
          />
        </label>
        <div class="chip-row">
          <button
            class="small-button is-outline"
            type="button"
            data-action="test-minimax-tts"
          >
            试听
          </button>
          <span class="meta-label" data-tts-test-status></span>
        </div>

        <button class="small-button is-primary" type="submit">
          保存连接器设置
        </button>
      </form>
    `;
  } else if (selected.id === 'local-files') {
    extra = ui`
      <div class="detail-meta">
        <div class="meta-block-label">工作区根目录</div>
        <div class="mono">${escapeHtml(selected.config.workspaceRoot || '(none)')}</div>
      </div>
      <div class="chip-row">
        <span class="chip is-accent">${selected.config.fileCount || 0} 个文件</span>
        <span class="chip">${selected.config.exists ? t('可用') : t('不可用')}</span>
        ${
          selected.config.selectedFilePath
            ? ui`<span class="chip">${escapeHtml(selected.config.selectedFilePath)}</span>`
            : ''
        }
      </div>
      ${workspace.selectedFile ? renderSelectedFilePreview() : ''}
    `;
  } else if (selected.id === 'local-command') {
    extra = ui`
      <div class="chip-row">
        ${(workspace.commandTemplates || [])
          .map(
            template => ui`
              <span class="chip">${escapeHtml(template.label)}</span>
            `,
          )
          .join('')}
      </div>
      ${(workspace.commandRuns || []).length ? renderCommandRunner() : `<div class="empty-state compact">${t('还没有命令运行记录。')}</div>`}
    `;
  } else if (selected.id === 'artifacts') {
    extra = ui`
      <div class="chip-row">
        <span class="chip is-accent">共 ${selected.config.totalArtifacts} 个</span>
        <span class="chip">当前项目 ${selected.config.projectArtifacts} 个</span>
      </div>
      ${renderProjectArtifactShelf()}
    `;
  } else if (selected.id === 'projects') {
    extra = ui`
      <div class="chip-row">
        <span class="chip is-accent">${escapeHtml(
          selected.config.activeProject || '(none)',
        )}</span>
        <span class="chip mono">${escapeHtml(selected.config.workspacePath || '')}</span>
      </div>
    `;
  }

  return ui`
    <div class="detail-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">${escapeHtml(connectorText(selected, 'name'))}</h2>
          <p class="page-kicker">${escapeHtml(connectorText(selected, 'description'))}</p>
        </div>
      </div>

      <div class="detail-meta">
        <div>${escapeHtml(connectorText(selected, 'details'))}</div>
      </div>

      <div class="toggle-row">
        <div>
          <div class="list-row-title">开启</div>
          <div class="list-row-meta">在 Melo 桌面端和提示上下文中提供此连接器。</div>
        </div>
        <button
          class="toggle-switch ${selected.enabled ? 'is-on' : ''}"
          data-action="toggle-connector"
          data-connector-id="${selected.id}"
        ></button>
      </div>

      ${extra}
    </div>
  `;
}

// Phase 3.3.2 — filter bar shown above the Customize → Skills list. Three
// controls: free-text search input, a horizontally scrollable row of tag
// chips (with an "All tags" reset chip), and a select for state.
function renderSkillFilterBar() {
  const { query, tag, state } = customizeState.skillFilter;
  const tags = allSkillTags();
  const totalCount = (getBootstrap()?.customize?.skills || []).length;
  const filteredCount = filteredSkills().length;
  const isFiltering = Boolean(query || tag || state !== 'all');

  return ui`
    <div class="skill-filter-bar">
      <div class="skill-filter-row">
        <input
          class="input skill-filter-query"
          type="search"
          placeholder="按名称、标签或触发词搜索技能…"
          value="${escapeHtml(query)}"
          data-action="set-skill-filter-query"
        />
        <select class="input skill-filter-state" data-action="set-skill-filter-state">
          <option value="all"      ${state === 'all' ? 'selected' : ''}>全部</option>
          <option value="enabled"  ${state === 'enabled' ? 'selected' : ''}>已启用</option>
          <option value="disabled" ${state === 'disabled' ? 'selected' : ''}>已停用</option>
          <option value="builtin"  ${state === 'builtin' ? 'selected' : ''}>内置</option>
          <option value="custom"   ${state === 'custom' ? 'selected' : ''}>自定义</option>
          <option value="disk"     ${state === 'disk' ? 'selected' : ''}>磁盘上</option>
        </select>
      </div>
      ${tags.length
        ? ui`
          <div class="skill-filter-tags">
            <button
              type="button"
              class="chip chip-button ${!tag ? 'is-accent' : ''}"
              data-action="set-skill-filter-tag"
              data-tag=""
            >全部标签</button>
            ${tags
              .map(
                t => ui`
                  <button
                    type="button"
                    class="chip chip-button ${tag === t ? 'is-accent' : ''}"
                    data-action="set-skill-filter-tag"
                    data-tag="${escapeHtml(t)}"
                  >${escapeHtml(t)}</button>
                `,
              )
              .join('')}
          </div>
        `
        : ''}
      <div class="skill-filter-status">
        ${isFiltering
          ? ui`显示 ${filteredCount} / ${totalCount} 个技能 · <button type="button" class="link-button" data-action="reset-skill-filter">重置</button>`
          : t('{count} 个技能', { count: totalCount })}
      </div>
    </div>
  `;
}

function renderCustomSkillCreateCard() {
  return ui`
    <div class="detail-card create-connector-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">添加自定义技能</h2>
        </div>
      </div>

      <form id="skill-custom-create-form" class="config-form" data-form="skill-custom-create">
        <label class="label">
          ID
          <input class="input mono" name="id" placeholder="my-skill" required />
        </label>
        <label class="label">
          名称
          <input class="input" name="name" placeholder="My Skill" required />
        </label>
        <label class="label">
          描述
          <input class="input" name="description" placeholder="这个技能做什么。" />
        </label>
        <label class="label">
          添加者
          <input class="input" name="addedBy" placeholder="User" value="User" />
        </label>
        <label class="label">
          调用方
          <input class="input" name="invokedBy" placeholder="User or Melo" value="User or Melo" />
        </label>
        <label class="label">
          系统提示词
          <textarea class="config-textarea" name="systemPrompt" placeholder="启用此技能时注入 Agent 系统提示词的说明。"></textarea>
        </label>
        <label class="label">
          类型
          <select class="input" name="type">
            <option value="executable" selected>可执行 — 作为工具在循环中调用</option>
            <option value="prompt">提示词 — 原样注入系统提示词</option>
          </select>
        </label>
        <label class="label">
          最多迭代次数（仅可执行）
          <input class="input" type="number" name="maxIterations" min="1" max="16" value="6" />
        </label>
        <label class="label">
          允许的 Agent（逗号分隔 ID，留空表示全部）
          <input class="input mono" name="allowedAgentIds" placeholder="main, planner" />
        </label>
        <label class="label">
          工具白名单（逗号分隔工具 ID，留空表示全部）
          <input class="input mono" name="toolWhitelist" placeholder="web_search, read_file" />
        </label>
        <label class="label">
          文件夹（逗号分隔）
          <input class="input" name="folders" placeholder="plans, references" />
        </label>
        <div class="inline-actions">
          <button class="small-button is-primary" type="submit">创建技能</button>
        </div>
      </form>
    </div>
  `;
}

function formatSuccessRate(row) {
  if (!row || typeof row.successRate !== 'number') return '—';
  return `${Math.round(row.successRate * 100)}%`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function formatLastRunAt(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const secondsAgo = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  return `${Math.floor(secondsAgo / 86400)}d ago`;
}

function renderSafetyPane() {
  const { loading, loaded, error, pendingRemoveId } = customizeState.safetyAllowlist;
  const filters = customizeState.safetyAllowlist.filters || {};
  const matches = row => (!filters.role || (row.permissionScope?.role || row.role || 'global') === filters.role) && (!filters.project || (row.permissionScope?.project || row.project || 'none') === filters.project) && (!filters.operation || row.operation === filters.operation);
  const allRules = customizeState.safetyAllowlist.rules || [];
  const rules = allRules.filter(matches);
  const audit = (customizeState.safetyAllowlist.audit || []).filter(matches);
  if (!loaded && !loading && !error) {
    Promise.resolve().then(refreshSafetyAllowlist);
  }

  const opLabel = (op, scope) => {
    if (scope === 'tool') return op === 'allow' ? t("始终允许此工具") : t("拒绝此工具");
    const opPart = op === 'read' ? t("读取") : op === 'write' ? t("写入") : op === 'edit' ? t("编辑") : op;
    const scopePart = scope === 'dir' ? t("整个目录") : t("当前文件");
    return `${opPart} — ${scopePart}`;
  };

  const fmtTimestamp = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return '';
    }
  };

  const body = (() => {
    if (loading && !loaded) {
      return ui`<div class="empty-state compact">正在读取授权…</div>`;
    }
    if (error) {
      return ui`<div class="alert compact-alert">${escapeHtml(error)}</div>`;
    }
    if (!rules.length) {
      return ui`
        <div class="empty-state compact">
          还没有长期授权。点击权限弹窗中的「始终允许」后，可在这里查看和撤销。
        </div>
      `;
    }
    return ui`
      <div class="safety-rule-list">
        ${rules.map(rule => ui`
          <div class="safety-rule-row">
            <div class="safety-rule-main">
              <div class="safety-rule-op">${escapeHtml(opLabel(rule.operation, rule.scope))}</div>
              <div class="safety-rule-path mono small">${escapeHtml(rule.realPath)}</div>
<div class="list-row-meta">${escapeHtml(rule.permissionScope ? `Agent ${rule.permissionScope.role} · 项目 ${rule.permissionScope.project || "无"} · ${rule.permissionScope.workspace?.path || "无工作目录"}` : "原有全局授权")} · 保存于 ${escapeHtml(fmtTimestamp(rule.createdAt))}</div>
            </div>
            <button class="small-button is-danger"
              data-action="safety-allowlist-remove"
              data-rule-id="${escapeHtml(rule.id)}"
              ${pendingRemoveId === rule.id ? 'disabled' : ''}>
              ${pendingRemoveId === rule.id ? '撤销中…' : t("撤销")}
            </button>
          </div>
        `).join('')}
      </div>
    `;
  })();

  return ui`
    <div class="detail-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">权限与隐私</h2>
          <p class="page-kicker">
            管理你通过「始终允许」保存的工具与文件授权。撤销后，下次操作将重新询问。
          </p>
        </div>
        <div class="inline-actions">
          <button class="small-button" data-action="refresh-safety-allowlist">刷新</button>
        </div>
      </div>
      <div class="inline-actions">${[['role',t("Agent"),r=>r.permissionScope?.role || r.role || 'global'],['project',t("项目"),r=>r.permissionScope?.project || r.project || 'none'],['operation',t("操作"),r=>r.operation]].map(([key,label,get])=>ui`<label>${label}<select data-permission-filter="${key}"><option value="">全部</option>${[...new Set([...allRules,...(customizeState.safetyAllowlist.audit || [])].map(get))].filter(Boolean).map(value=>ui`<option value="${escapeHtml(value)}" ${filters[key]===value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label>`).join('')}</div>
      ${body}
      ${approvalsFeature.renderGrantList()}
      <details class="quality-details"><summary>最近授权使用记录 · ${audit.length}</summary>${audit.slice(0,80).map(e=>ui`<p>${escapeHtml(e.at)} · ${escapeHtml(e.operation)} · ${escapeHtml(e.decision)} · ${escapeHtml(e.reason)} · ${escapeHtml(e.role || '未指定Agent')}${e.path ? ` · ${escapeHtml(e.path)}` : ''}</p>`).join('') || ui`<p>尚无记录。</p>`}</details>
      <p class="list-row-meta">敏感路径（~/.ssh、/etc、MELO_HOME 等）永远不能加入长期授权，弹窗只提供“允许一次”或“拒绝”。移动和删除操作也按设计不提供“始终允许”。</p>

      ${renderDomainCookiesPane()}
    </div>
  `;
}

function renderDomainCookiesPane() {
  const { loading, loaded, hosts, error, addHost, addCookie, addInFlight, addError, pendingRemoveHost } = customizeState.domainCookies;
  if (!loaded && !loading && !error) {
    Promise.resolve().then(refreshDomainCookies);
  }

  const list = (() => {
    if (loading && !loaded) {
      return ui`<div class="empty-state compact">加载中…</div>`;
    }
    if (error) {
      return ui`<div class="alert compact-alert">${escapeHtml(error)}</div>`;
    }
    if (!hosts.length) {
      return ui`
        <div class="empty-state compact">
          还没有配置域名 Cookie。需要登录状态的网站（小红书、抖音、哔哩哔哩等）添加后，yt-dlp 和 fetch_url 会自动使用。
        </div>
      `;
    }
    return ui`
      <div class="safety-rule-list">
        ${hosts.map(entry => ui`
          <div class="safety-rule-row">
            <div class="safety-rule-main">
              <div class="safety-rule-op">${escapeHtml(entry.host)}</div>
              <div class="list-row-meta">
                Cookie 长度：${entry.length}${entry.fingerprint ? ui` · 指纹 <code>${escapeHtml(entry.fingerprint)}</code>` : ''}
              </div>
            </div>
            <button class="small-button is-danger"
              data-action="domain-cookie-remove"
              data-host="${escapeHtml(entry.host)}"
              ${pendingRemoveHost === entry.host ? 'disabled' : ''}>
              ${pendingRemoveHost === entry.host ? t('正在移除…') : t('移除')}
            </button>
          </div>
        `).join('')}
      </div>
    `;
  })();

  return ui`
    <div class="meta-block-label">网页抓取 Cookie</div>
    <p class="list-row-meta">按域名保存的 Cookie 会随网页抓取（fetch_url）和平台提取（yt-dlp）一起发送。列表只显示长度和 sha256 指纹，不显示保存的值，会话令牌不会出现在页面中。只填写主机名，不含协议和路径。</p>
    <p class="list-row-meta">建议添加：社交链接提取会用这些站点读取需要登录的内容；未配置时，登录后才能看的帖子只返回 OpenGraph 预览。</p>
    <p class="list-row-meta mono">xiaohongshu.com · xhslink.com · douyin.com · v.douyin.com · iesdouyin.com · bilibili.com</p>

    <div class="domain-cookie-form">
      <input type="text"
        class="domain-cookie-host"
        placeholder="主机名（例如 xiaohongshu.com）"
        value="${escapeHtml(addHost)}"
        data-domain-cookie-host
        ${addInFlight ? 'disabled' : ''} />
      <textarea
        class="domain-cookie-string"
        placeholder="${escapeHtml(t('Cookie 请求头的值，例如 name1=val1; name2=val2'))}"
        data-domain-cookie-string
        rows="2"
        ${addInFlight ? 'disabled' : ''}>${escapeHtml(addCookie)}</textarea>
      <div class="inline-actions">
        <button class="small-button is-primary"
          data-action="domain-cookie-save"
          ${addInFlight ? 'disabled' : ''}>
          ${addInFlight ? t('正在保存…') : t('保存 Cookie')}
        </button>
        <button class="small-button" data-action="refresh-domain-cookies">刷新列表</button>
      </div>
      ${addError ? ui`<div class="alert compact-alert" style="margin-top: 8px;">${escapeHtml(addError)}</div>` : ''}
    </div>

    ${list}
  `;
}

function renderSkillDetailTabs(selected, activeTab) {
  return ui`
    <div class="skill-tab-strip">
      <button
        class="skill-tab ${activeTab === 'overview' ? 'is-active' : ''}"
        data-action="skill-detail-tab"
        data-skill-id="${escapeHtml(selected.id)}"
        data-tab="overview"
      >概览</button>
      <button
        class="skill-tab ${activeTab === 'markdown' ? 'is-active' : ''}"
        data-action="skill-detail-tab"
        data-skill-id="${escapeHtml(selected.id)}"
        data-tab="markdown"
      >SKILL.md</button>
    </div>
  `;
}

function renderSkillMarkdownTab(selected) {
  const activeTab = 'markdown';
  const cached = customizeState.skillMarkdown[selected.id] || {};
  const body = (() => {
    if (cached.loading) return ui`<div class="empty-state compact">Loading SKILL.md…</div>`;
    if (cached.error) return ui`<div class="alert compact-alert">${escapeHtml(cached.error)}</div>`;
    if (!cached.markdown) {
      // Kick off initial load when rendered for the first time.
      Promise.resolve().then(() => refreshSkillMarkdown(selected.id));
      return ui`<div class="empty-state compact">Loading SKILL.md…</div>`;
    }
    return ui`<pre class="skill-markdown-block">${escapeHtml(cached.markdown)}</pre>`;
  })();
  return ui`
    <div class="detail-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">${escapeHtml(selected.name)}</h2>
          <p class="page-kicker">SKILL.md — the on-disk representation used by agentskills.io / Claude Code.</p>
        </div>
        <div class="inline-actions">
          <button class="small-button" data-action="copy-skill-markdown" data-skill-id="${escapeHtml(selected.id)}" ${cached.markdown ? '' : 'disabled'}>
            ${cached.copyToast || 'Copy SKILL.md'}
          </button>
        </div>
      </div>

      ${renderSkillDetailTabs(selected, activeTab)}

      ${body}
    </div>
  `;
}

function renderSkillHealthPanel() {
  const { loading, loaded, skills, error } = customizeState.skillRunStats;
  const nameFor = id => {
    const found = (getBootstrap()?.customize?.skills || []).find(s => s.id === id);
    return found?.name || id;
  };
  return ui`
    <div class="detail-card skill-health-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">技能健康度</h2>
          <p class="page-kicker">最近 30 天：每个技能的成功率、速度和最近错误。</p>
        </div>
        <button class="small-button" data-action="refresh-skill-runs">
          ${loading ? 'Loading…' : loaded ? 'Refresh' : 'Load'}
        </button>
      </div>
      ${error ? ui`<div class="banner is-warning">${escapeHtml(error)}</div>` : ''}
      ${
        !loaded && !loading
          ? ui`<div class="empty-state compact">Click "Load" to see run statistics.</div>`
          : skills.length === 0 && loaded
            ? ui`<div class="empty-state compact">No skill runs recorded yet.</div>`
            : ui`
              <div class="list-stack">
                ${skills
                  .map(row => {
                    const rate = formatSuccessRate(row);
                    const durLabel = formatDurationMs(row.p50DurationMs ?? row.avgDurationMs);
                    const lastAt = formatLastRunAt(row.lastRunAt);
                    const metaLabel = `${row.runs} runs • ${rate} ok • p50 ${durLabel} • last ${lastAt}`;
                    const errHtml = (row.recentErrors || [])
                      .slice(0, 3)
                      .map(e => ui`
                        <div class="skill-health-error">
                          <span class="meta-label">${escapeHtml(e.errorType || 'error')}</span>
                          <span>${escapeHtml((e.errorMessage || '').slice(0, 160))}</span>
                        </div>
                      `)
                      .join('');
                    const isDegraded = typeof row.successRate === 'number' && row.successRate < 0.7 && row.runs >= 3;
                    return ui`
                      <div class="list-row skill-health-row ${isDegraded ? 'is-degraded' : ''}">
                        <div>
                          <div class="list-row-title">${escapeHtml(nameFor(row.skillId))}</div>
                          <div class="list-row-meta">${escapeHtml(metaLabel)}</div>
                          ${errHtml ? ui`<div class="skill-health-errors">${errHtml}</div>` : ''}
                        </div>
                      </div>
                    `;
                  })
                  .join('')}
              </div>
            `
      }
    </div>
  `;
}

function renderSkillProposalsPanel() {
  const proposals = getBootstrap()?.customize?.skillProposals || [];
  if (proposals.length === 0) return '';
  return ui`
    <div class="detail-card skill-proposals-card">
      <div class="header-row">
        <div>
          <h2 class="pane-title">技能建议</h2>
          <p class="page-kicker">最近重复出现的工作流程。保存有用的，忽略其余的。</p>
        </div>
        <span class="chip is-accent">${proposals.length}</span>
      </div>
      <div class="list-stack">
        ${proposals
          .map(p => ui`
            <div class="list-row">
              <div>
                <div class="list-row-title">${escapeHtml(p.summary || '(workflow)')}</div>
                <div class="list-row-meta">
                  ${escapeHtml(
                    [
                      `${p.occurrences || 1}× seen`,
                      `${p.toolCallCount || 0} tool calls`,
                      p.involvesConnectors ? 'connector' : '',
                      p.involvesWrites ? 'file-write' : '',
                    ]
                      .filter(Boolean)
                      .join(' • '),
                  )}
                </div>
              </div>
              <div class="inline-actions">
                <button
                  class="small-button is-primary"
                  data-action="promote-skill-proposal"
                  data-seed-id="${escapeHtml(p.seedId)}"
                >存为技能</button>
                <button
                  class="small-button"
                  data-action="dismiss-skill-proposal"
                  data-seed-id="${escapeHtml(p.seedId)}"
                >忽略</button>
              </div>
            </div>
          `)
          .join('')}
      </div>
    </div>
  `;
}

function renderCustomizePage() {
  const data = getBootstrap();
  const selected = selectedCustomizeItem();
  // Old saved settings may still carry 'runtime' from before the
  // Advanced page replaced it — coerce here so the user lands on the
  // new section without an extra click.
  const rawSection = data.settings.selectedCustomizeSection;
  const section = rawSection === 'runtime' ? 'advanced' : rawSection;
  if (section === 'agents') return agentsFeature.renderPage();

  return ui`
    <section class="page page-customize">
      <div class="customize-layout">
        <div class="customize-pane">
          <div class="customize-pane-header">
            <h2 class="pane-title">自定义设置</h2>
          </div>

          <div class="section-nav">
            <button
              class="section-button ${section === 'skills' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="skills"
            >
              <div class="list-row-title">技能</div>
              <div class="list-row-meta">塑造角色行为与提示策略。</div>
            </button>
            <button
              class="section-button ${section === 'agents' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="agents"
            >
              <div class="list-row-title">Agent</div>
              <div class="list-row-meta">设置 Agent 的人设、能力与消息渠道</div>
            </button>
            <button
              class="section-button ${section === 'connectors' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="connectors"
            >
              <div class="list-row-title">连接器</div>
              <div class="list-row-meta">模型接入、文件、命令、项目与成果。</div>
            </button>
            <button
              class="section-button ${section === 'advanced' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="advanced"
            >
              <div class="list-row-title">
                系统状态
              </div>
              <div class="list-row-meta">任务、能力状态与扩展管理。</div>
            </button>
            <button
              class="section-button ${section === 'memory' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="memory"
            >
              <div class="list-row-title">记忆</div>
              <div class="list-row-meta">Inspect the memory store, embedding model, and dreaming activity.</div>
            </button>
            <button
              class="section-button ${section === 'safety' ? 'is-active' : ''}"
              data-action="open-customize-section"
              data-section="safety"
            >
              <div class="list-row-title">权限与隐私</div>
              <div class="list-row-meta">查看并撤销通过「始终允许」保存的工具与文件授权。</div>
            </button>
          </div>
        </div>

        ${
          section === 'advanced'
            ? renderAdvancedPage({
                data: getBootstrap(),
                adv: customizeState.advanced,
                escapeHtml,
                scheduleRefresh: () => Promise.resolve().then(refreshAdvancedStatus),
                statePathHint: customizeState.advanced.diagnostics?.paths?.configPath || '',
                mcpPresets: getBootstrap()?.customize?.mcpPresets || [],
                taskPanelHtml: renderTaskPanel(),
                approvalPanelHtml: renderApprovalPanel(),
              })
            : section === 'memory'
              ? memoryFeature.renderPane()
            : section === 'safety'
              ? renderSafetyPane()
              : ui`
        <div class="customize-pane">
          <div class="customize-pane-header">
            <h2 class="pane-title">${
              section === 'skills' ? t('技能') : section === 'agents' ? 'Agent' : t('连接器')
            }</h2>
          </div>

          ${section === 'skills' ? renderSkillFilterBar()+renderSkillManagement(selected,escapeHtml) : ''}

          <div class="list-stack">
            ${(section === 'skills'
              ? filteredSkills()
              : section === 'agents'
                ? data.customize.agents
                : (data.customize.connectors || []).filter(c => c.type !== 'external-mcp' && !['local-files','local-command'].includes(c.id)))
              .map(item => {
                const isActive =
                  section === 'skills'
                    ? data.settings.selectedSkillId === item.id
                    : section === 'agents'
                      ? data.settings.selectedAgentId === item.id
                      : data.settings.selectedConnectorId === item.id;
                return ui`
                  <button
                    class="list-row ${isActive ? 'is-active' : ''}"
                    data-action="select-customize-item"
                    data-section="${section}"
                    data-id="${item.id}"
                  >
                    <div class="list-row-title">
                      ${escapeHtml(section === 'connectors' ? connectorText(item, 'name') : item.name)}
                      ${section==='agents' && !item.capabilities ? ui`<span class="chip">旧版权限待迁移</span>` : ''}
                    </div>
                    <div class="list-row-meta">${escapeHtml(
                      section === 'agents' ? item.laneLabel : section === 'connectors' ? connectorText(item, 'description') : item.description,
                    )}</div>
                  </button>
                `;
              })
              .join('')}
            ${section === 'skills' && filteredSkills().length === 0
              ? ui`<div class="empty-state compact">No skills match the current filter.</div>`
              : ''}
          </div>
        </div>

        <div class="customize-pane">
          ${renderConnectorDetails(selected)}
          ${
            section === 'skills'
              ? ui`
                ${renderSkillHealthPanel()}
                ${renderSkillProposalsPanel()}
                <div class="subsection">${renderCustomSkillCreateCard()}</div>
              `
              : ''
          }
        </div>
          `
        }
      </div>
    </section>
  `;
}

export { allSkillTags, filteredSkills, formatDurationMs, formatLastRunAt, formatSuccessRate, renderConnectorDetails, renderCustomSkillCreateCard, renderCustomizePage, renderDomainCookiesPane, renderSafetyPane, renderSkillDetailTabs, renderSkillFilterBar, renderSkillHealthPanel, renderSkillMarkdownTab, renderSkillProposalsPanel, selectedCustomizeItem };
