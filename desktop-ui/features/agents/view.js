// Agent settings renderers (architecture plan P2b, 2026-10-19): the Agent
// page, the shared editor (workbench) with persona, capability/collaboration
// and channel sections, and the channel runtime card. Moved out of
// desktop-ui/app.js byte-for-byte first; they now read the feature's own state
// and the bootstrap through the context. DOM, classes, data-attributes, ids
// and action names are unchanged.
import { t, ui } from '../../i18n.js';
import { renderAgentAvatar } from '../../agentAvatar.js';
import { renderCapabilityChoices } from './capabilityChoices.js';
import { getBootstrap, activeProject, isAgentChannelAvailable, escapeHtml, icon, renderCapabilityGrants } from './context.js';
// renderCapabilityGrants (the approvals feature's «临时授权» list) sits after the
// form: the settings editor keeps form controls read-only until editing, and
// revoking a grant must never wait for an edit.
import { agentsState } from './state.js';
import { selectedAgentProfile, selectedAgentScope, agentDraftFor, agentSecretVisibilityKey } from './controller.js';

function formatRuntimeTimestamp(value, fallback = 'Not yet') {
  if (!value) {
    return fallback;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  const diffMs = Math.max(0, Date.now() - parsed);
  const diffSeconds = Math.round(diffMs / 1000);
  if (diffSeconds < 5) {
    return 'Just now';
  }
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function renderChannelRuntimeMetric(label, value) {
  return ui`
    <div class="agent-runtime-metric">
      <div class="agent-runtime-metric-label">${escapeHtml(label)}</div>
      <div class="agent-runtime-metric-value">${escapeHtml(value || '—')}</div>
    </div>
  `;
}

function renderChannelRuntimeCard(channel, { showRoute = false } = {}) {
  const incomingPreview = channel?.lastIncomingPreview || '';
  const replyPreview = channel?.lastReplyPreview || '';

  return ui`
    <div class="agent-channel-runtime">
      <div class="agent-editor-header">
        <div class="agent-editor-heading">
          <div class="meta-block-label">Runtime</div>
          <div class="list-row-meta">Live polling and recent channel activity for this agent.</div>
        </div>
        <span class="chip ${channel?.statusLabel === 'Polling live' ? 'is-accent' : ''}">
          ${escapeHtml(channel?.runtimeLabel || 'Disabled')}
        </span>
      </div>
      <div class="agent-channel-runtime-grid">
        ${renderChannelRuntimeMetric('Bot', channel?.botLabel || 'Unknown bot')}
        ${renderChannelRuntimeMetric('Status', channel?.statusLabel || 'Not checked')}
        ${renderChannelRuntimeMetric('Last checked', channel?.lastCheckedLabel || formatRuntimeTimestamp(channel?.lastCheckedAt))}
        ${renderChannelRuntimeMetric('Last poll', channel?.lastPolledLabel || formatRuntimeTimestamp(channel?.lastPolledAt, 'No recent poll'))}
        ${renderChannelRuntimeMetric('Last incoming', channel?.lastIncomingLabel || formatRuntimeTimestamp(channel?.lastIncomingAt, 'No incoming messages yet'))}
        ${renderChannelRuntimeMetric('Last reply', channel?.lastReplyLabel || formatRuntimeTimestamp(channel?.lastReplyAt, 'No replies sent yet'))}
        ${
          showRoute
            ? renderChannelRuntimeMetric('Default route', channel?.chatId || channel?.lastRemoteChatId || 'Not pinned')
            : ''
        }
      </div>
      ${
        incomingPreview || replyPreview
          ? ui`
            <div class="agent-runtime-preview-stack">
              ${
                incomingPreview
                  ? ui`
                    <div class="agent-runtime-preview-card">
                      <div class="agent-runtime-preview-label">Last incoming</div>
                      <div class="agent-runtime-preview-copy">${escapeHtml(incomingPreview)}</div>
                    </div>
                  `
                  : ''
              }
              ${
                replyPreview
                  ? ui`
                    <div class="agent-runtime-preview-card">
                      <div class="agent-runtime-preview-label">Last reply</div>
                      <div class="agent-runtime-preview-copy">${escapeHtml(replyPreview)}</div>
                    </div>
                  `
                  : ''
              }
            </div>
          `
          : ''
      }
    </div>
  `;
}

function renderAgentCapabilities(selected,draft) {
  const c=draft?.capabilities || selected.capabilities || selected.capabilityMigration?.proposed;
  if (!c) return '';
  const value=k=>draft?.['cap_'+k] ?? c[k];
  const collaboration=draft?.collaboration || selected.collaboration || {};
  // One visible switch for delegation. Execution requires both stored flags, so
  // older data where they disagree shows (and behaves) as off.
  const checked=k=>(value(k)===true||value(k)==='on')&&(k!=='delegate'||draft?.['cap_delegate']!==undefined||collaboration.canDelegate===true);
  const pending=selected.pendingCapabilityChange;
  const settingText=value=>typeof value==='boolean'?t(value?'开启':'关闭'):Array.isArray(value)?value.join(', '):String(value);
  const pendingChanges=pending ? [
    ...Object.entries(selected.capabilityLabels||{}).filter(([key])=>pending.requested.capabilities[key]&&!selected.capabilities?.[key]).map(([,label])=>label),
    ...[['mcpServers','MCP 服务'],['skills','技能'],['connectors','连接器']].flatMap(([key,label])=>pending.requested.capabilities[key].filter(id=>!selected.capabilities?.[key]?.includes(id)).map(id=>`${t(label)}: ${id}`)),
    ...[['delegateTargets','委派对象'],['maxDelegationDepth','委派深度'],['maxIterations','成员轮数'],['maxTokens','成员 token 上限'],['timeoutMs','成员超时（毫秒）']].filter(([key])=>JSON.stringify(pending.baseline.current.collaboration[key])!==JSON.stringify(pending.requested.collaboration[key])).map(([key,label])=>`${t(label)}: ${settingText(pending.baseline.current.collaboration[key])} → ${settingText(pending.requested.collaboration[key])}`),
    ...[['projects','项目指引'],['knowledge','共享知识'],['memory','记忆']].filter(([key])=>pending.baseline.current.contextSources[key]!==pending.requested.contextSources[key]).map(([,label])=>`${t(label)}: ${t('开启')}`),
  ] : [];
  return ui`<details class="agent-settings-section agent-capabilities" data-agent-section="${selected.id}:capabilities" ${pending || !selected.capabilities || agentsState.agentOpenSections[`${selected.id}:capabilities`] ? 'open' : ''}><summary>能力范围与协作</summary><p>关闭的能力在工具执行时拒绝；MCP 服务可自行执行命令，请只授权可信服务。</p><p>这些能力只约束这个 Agent 在电脑上的执行。手机上的联网、生成图片和手机数据，在手机的 Agent 页“这台手机上”单独设置。</p>
    ${selected.editingScope==='project'?`<p>${escapeHtml(t('项目能力与协作设置只能收紧全局设置；需要更多能力时，请先编辑此 Agent 的全局设置。'))}</p>`:''}
    ${pending?`<section role="status"><strong>${escapeHtml(t('同步权限变更待桌面确认'))}</strong><p>${escapeHtml(t('收紧部分已生效。以下新增能力及协作、上下文变更尚未生效：'))}</p><p>${escapeHtml(pendingChanges.join('、')||t('协作或上下文设置'))}</p><button type="button" class="small-button" data-action="confirm-agent-settings" data-id="${escapeHtml(pending.id)}" data-expected="${escapeHtml(pending.fingerprint)}" data-accept="true" ${!selected.capabilities?'disabled':''}>${escapeHtml(t('确认应用同步设置'))}</button><button type="button" class="small-button" data-action="confirm-agent-settings" data-id="${escapeHtml(pending.id)}" data-expected="${escapeHtml(pending.fingerprint)}" data-accept="false">${escapeHtml(t('拒绝放宽，保留当前权限'))}</button></section>`:''}
    <input type="hidden" name="capabilityVersion" value="1">
    ${!selected.capabilities?`<p>迁移预览：${escapeHtml(selected.capabilityMigration.note)}</p><p>将失去的工具：${escapeHtml([...selected.capabilityMigration.lostTools,...(selected.capabilityMigration.lostActions||[])].join(', ') || '无')}</p><input type="hidden" name="capabilityMigrationExpected" value="${escapeHtml(selected.capabilityMigration.fingerprint)}"><label><input type="checkbox" name="confirmCapabilityMigration" ${draft?.confirmCapabilityMigration==='on'?'checked':''}>确认应用这份能力配置；保存后生效</label>`:''}
    <div class="agent-capability-flags">${Object.entries(selected.capabilityLabels || {}).map(([key,label])=>`<label class="label"><input type="checkbox" name="cap_${key}" ${checked(key)?'checked':''}>${escapeHtml(t(label))}</label>`).join('')}</div>
    <div class="agent-settings-grid">${[['skills','技能白名单'],['mcpServers','MCP 服务白名单'],['connectors','连接器白名单']].map(([key,label])=>renderCapabilityChoices('cap_'+key,label,value(key),key==='skills'?selected.capabilityOptions:key==='mcpServers'?(getBootstrap().customize.mcpAuthSurface || []).map(o=>({...o,unavailable:!o.enabled || o.unpinned})):getBootstrap().customize.connectors.filter(o=>o.type==='external-mcp'),escapeHtml)).join('')}</div>
    <p>${escapeHtml(t('开启“委派”后，这个 Agent 可以把任务交给下面勾选的 Agent，也可以发起多 Agent 协作；没勾选的 Agent 不能被委派或组队。'))}</p>
    <div class="agent-settings-grid">
    ${renderCapabilityChoices('delegateTargets','委派对象',draft?.delegateTargets ?? collaboration.delegateTargets,getBootstrap().customize.agents.filter(a=>a.id!==selected.id),escapeHtml)}
    ${[['maxDelegationDepth','委派深度',1,3],['maxIterations','成员轮数',8,20],['maxTokens','成员 token 上限',32000,200000],['timeoutMs','成员超时（毫秒）',180000,900000]].map(([key,label,fallback,max])=>`<label class="label">${escapeHtml(t(label))}<input class="config-input" type="number" min="1" max="${max}" name="${key}" value="${escapeHtml(String(draft?.[key]??collaboration[key]??fallback))}"></label>`).join('')}
    </div><p>上下文来源</p><div class="agent-capability-flags">${[['projects','项目指引'],['knowledge','共享知识'],['memory','记忆']].map(([key,label])=>`<label class="checkbox-row"><input type="checkbox" name="context_${key}" ${(draft?.['context_'+key]!==undefined?draft['context_'+key]==='on':selected.contextSources?.[key]!==false)?'checked':''}>${escapeHtml(t(label))}</label>`).join('')}
  </div></details>`;
}

function renderAgentPersonaFields(selected, draft) {
  return ui`
    ${getBootstrap()?.syncPendingPersonas?.some(row => row.kind === 'agent' && row.id === selected.id || row.kind === 'project' && row.id === activeProject()?.id && selectedAgentScope() === 'project') ? ui`<p role="status">此 Agent 的新版人设尚未同步。全文已保留在本机，其他聊天继续同步。</p>` : ''}
    ${!selected.capabilities ? ui`<p role="status">旧版权限待迁移</p>` : ''}
    <label class="label">Agent 名称<input class="config-input" name="name" value="${escapeHtml(draft?.name ?? selected.name ?? '')}" /></label>
    <label class="label">一句话定位<textarea class="textarea agent-control-editor" name="description" rows="2">${escapeHtml(draft?.description ?? selected.description ?? '')}</textarea></label>
    <label class="label">人设与工作要求<textarea class="textarea agent-content-editor" name="instructions" rows="7" placeholder="可分节填写身份、风格和补充要求。">${escapeHtml(draft?.instructions ?? selected.instructions ?? '')}</textarea></label>
    <div class="inline-actions agent-document-actions">
      <label class="small-button agent-file-button">导入 Markdown<input type="file" accept=".md,.txt,text/markdown,text/plain" data-agent-document="${escapeHtml(selected.id)}" /></label>
      <button class="small-button" type="button" data-action="export-agent-document" data-agent-id="${escapeHtml(selected.id)}">导出 Markdown</button>
      <span class="meta-label">导入后先预览，点击保存修改生效。</span>
    </div>`;
}

function renderAgentWorkbench(selected) {
  if (!selected) {
    return ui`<section class="surface-card"><div class="empty-state">新增 Agent，设置它的人设与能力。</div></section>`;
  }

  const project = activeProject();
  const scope = selectedAgentScope();
  const draft = agentDraftFor(selected);
  const formId = `agent-profile-form-${selected.id}`;
  const telegramChannel = draft?.channels?.telegram || selected.channels?.find?.(channel => channel.id === 'telegram') || selected.channels?.telegram || {};
  const discordChannel = draft?.channels?.discord || selected.channels?.find?.(channel => channel.id === 'discord') || selected.channels?.discord || {};
  const discordSecretVisible = Boolean(
    agentsState.agentSecretVisibility[agentSecretVisibilityKey(selected.id, 'discord')],
  );
  // Archived channels have no controls; their saved configuration stays in the draft.
  // The list follows src/shared/channelAvailability.js so archiving a transport
  // removes its tab, card and form inputs in one place.
  const VALID_CHANNEL_TABS = ['telegram', 'discord'].filter(id => isAgentChannelAvailable(id));
  const activeChannelTab = VALID_CHANNEL_TABS.includes(agentsState.agentChannelTab[selected.id])
    ? agentsState.agentChannelTab[selected.id]
    : (VALID_CHANNEL_TABS[0] || null);
  const channelTabDefs = [
    {
      id: 'telegram',
      label: 'Telegram',
      status: telegramChannel.statusLabel || telegramChannel.lastStatus || 'idle',
      connected: telegramChannel.lastStatus === 'connected',
      enabled: Boolean(telegramChannel.enabled),
    },
    {
      id: 'discord',
      label: 'Discord',
      status: discordChannel.statusLabel || discordChannel.lastStatus || 'idle',
      connected: discordChannel.lastStatus === 'connected',
      enabled: Boolean(discordChannel.enabled),
    },
  ];

  return ui`
    <section class="surface-card agent-workbench-card">
      <div class="agent-scope-row">
        <span class="meta-label">设置范围</span>
        <div class="chip-row">
          <button class="chip chip-button ${scope === 'global' ? 'is-accent' : ''}" type="button" data-action="switch-agent-scope" data-scope="global">全局默认</button>
          ${project ? ui`<button class="chip chip-button ${scope === 'project' ? 'is-accent' : ''}" type="button" data-action="switch-agent-scope" data-scope="project">${escapeHtml(project.name)}</button>` : ''}
        </div>
      </div>

      <form
        id="${formId}"
        class="config-form"
        data-form="agent-profile-update"
        data-agent-id="${selected.id}"
      >
        <section class="agent-settings-section agent-identity-section">
        <div class="agent-avatar-editor">${renderAgentAvatar({...selected,...draft}, escapeHtml, 40)}<label class="small-button agent-file-button">上传头像<input type="file" accept="image/png,image/jpeg,image/webp" data-agent-avatar="${escapeHtml(selected.id)}" aria-label="上传Agent头像"></label>${agentDraftFor(selected)?.avatarData?ui`<button type="button" class="small-button" data-action="clear-agent-avatar" data-agent-id="${escapeHtml(selected.id)}">恢复默认</button>`:''}<span>头像只保存在 Melo，预览后点击保存修改生效。</span></div>
        ${renderAgentPersonaFields(selected, draft)}

        <label class="label">
          模型覆盖
          <input
            class="config-input"
            type="text"
            name="model"
            value="${escapeHtml(draft?.model || '')}"
            placeholder="留空使用全局模型"
          />
        </label>

        </section>
        ${renderAgentCapabilities(selected, draft)}

        <details class="agent-settings-section agent-channels" data-agent-section="${selected.id}:channels" ${agentsState.agentOpenSections[`${selected.id}:channels`] ? 'open' : ''}>
          <summary>消息渠道</summary>
          <p class="agent-section-note">${
            VALID_CHANNEL_TABS.length
              ? 'Telegram 已归档，原有配置与历史对话保留。'
              : 'Telegram 与 Discord 已暂时归档：不轮询、不外发、不加入语音频道；原有 token、ID 与历史对话全部保留，恢复后无需重新配置。'
          }</p>
        <section class="selected-file-card agent-channel-voice">
                  <label class="label">
                    语音回复模式
                    <select class="config-select" name="voiceReplyMode">
                      <option value="summary" ${(draft?.voiceReplyMode || 'summary') === 'summary' ? 'selected' : ''}>简短口述摘要</option>
                      <option value="full" ${draft?.voiceReplyMode === 'full' ? 'selected' : ''}>朗读完整回复</option>
                      <option value="off" ${draft?.voiceReplyMode === 'off' ? 'selected' : ''}>不发送语音</option>
                    </select>
                  </label>
                  <label class="label">
                    Edge TTS 音色
                    <input class="config-input" name="edgeTtsVoice" value="${escapeHtml(
                      draft?.edgeTtsVoice || '',
                    )}" placeholder="自动选择音色" />
                  </label>
                  <label class="label">
                    语音风格要求
                    <textarea class="textarea" name="voicePersonality" rows="3" placeholder="可选：语气、常用表达或语言要求">${escapeHtml(
                      draft?.voicePersonality || '',
                    )}</textarea>
                  </label>
        </section>

        <div class="agent-channel-tabs" role="tablist">
          ${channelTabDefs
            .filter(tab => isAgentChannelAvailable(tab.id))
            .map(
              tab => ui`
                <button
                  type="button"
                  role="tab"
                  class="agent-channel-tab ${activeChannelTab === tab.id ? 'is-active' : ''} ${tab.enabled ? 'is-enabled' : ''}"
                  data-action="switch-agent-channel-tab"
                  data-agent-id="${selected.id}"
                  data-channel-id="${tab.id}"
                  aria-selected="${activeChannelTab === tab.id ? 'true' : 'false'}"
                >
                  <span class="agent-channel-tab-label">${escapeHtml(tab.label)}</span>
                  <span class="agent-channel-tab-status ${tab.connected ? 'is-accent' : ''}">${escapeHtml(tab.status)}</span>
                </button>
              `,
            )
            .join('')}
        </div>

        <div class="agent-channel-panel">
          ${!isAgentChannelAvailable('discord') ? '' : ui`
                <section class="selected-file-card agent-channel-card" ${activeChannelTab === 'discord' ? '' : 'hidden'}>
                  <div class="agent-editor-header">
                    <div class="agent-editor-heading">
                      <div class="meta-block-label">Discord</div>
                      <div class="list-row-meta">通过 Bot token 连接此 Agent。</div>
                    </div>
                    <span class="chip ${discordChannel.lastStatus === 'connected' ? 'is-accent' : ''}">
                      ${escapeHtml(discordChannel.statusLabel || discordChannel.lastStatus || 'idle')}
                    </span>
                  </div>
                  <label class="checkbox-row">
                    <input type="checkbox" name="discordEnabled" ${discordChannel.enabled ? 'checked' : ''} />
                    <span>启用 Discord</span>
                  </label>
                  <label class="checkbox-row">
                    <input type="checkbox" name="discordVoiceReply" ${discordChannel.voiceReply ? 'checked' : ''} />
                    <span>文字回复后发送语音</span>
                  </label>
                  <div class="list-row-meta" style="margin:0 0 8px 0;">
                    上方语音设置应用于此 Agent。
                  </div>
                  <label class="label">
                    Bot token
                    <div class="secure-input-row">
                      <input class="config-input" type="${discordSecretVisible ? 'text' : 'password'}" name="discordBotToken" value="${escapeHtml(
                        discordChannel.botToken || '',
                      )}" placeholder="Discord bot token" />
                      <button
                        class="icon-toggle-button"
                        type="button"
                        data-action="toggle-agent-secret"
                        data-agent-id="${selected.id}"
                        data-channel-id="discord"
                        aria-label="${discordSecretVisible ? t('隐藏 Bot token') : t('显示 Bot token')}"
                        title="${discordSecretVisible ? t('隐藏 Bot token') : t('显示 Bot token')}"
                      >
                        ${discordSecretVisible ? icon.eyeOff : icon.eye}
                      </button>
                    </div>
                  </label>
                  <label class="label">
                    Discord 服务器 ID
                    <input class="config-input" type="text" name="discordGuildId" value="${escapeHtml(
                      discordChannel.guildId || '',
                    )}" placeholder="Discord guild id" />
                  </label>
                  <label class="label">
                    Discord 频道 ID
                    <input class="config-input" type="text" name="discordChannelId" value="${escapeHtml(
                      discordChannel.channelId || '',
                    )}" placeholder="Discord channel id" />
                  </label>
                  ${
                    discordChannel.lastError
                      ? ui`<div class="list-row-meta danger-copy">${escapeHtml(discordChannel.lastError)}</div>`
                      : ''
                  }
                  ${renderChannelRuntimeCard(discordChannel)}
                  <div class="inline-actions">
                    <button class="small-button" type="button" data-action="test-agent-channel" data-channel-id="discord">
                      测试 Discord
                    </button>
                  </div>
                </section>
          `}

        </div>

        </details>
        <div class="inline-actions">
          ${
            scope === 'project' && selected.hasProjectOverride
              ? ui`
                <button
                  class="small-button"
                  type="button"
                  data-action="reset-project-agent-override"
                  data-agent-id="${selected.id}"
                >
                  恢复全局设置
                </button>
              `
              : ''
          }
        </div>
      </form>
      ${renderCapabilityGrants(selected.id)}
    </section>
  `;
}

function renderAgentPage() {
  const selected = selectedAgentProfile();
  return ui`
    <section class="page agent-page">
      <div class="page-grid agent-page-grid">
        <div class="header-row agent-page-header">
          <h1 class="page-title compact">Agent</h1>
          <div class="inline-actions">
            <select class="config-select agent-select" data-action="select-agent-profile" aria-label="选择 Agent">
              ${(getBootstrap()?.customize?.agents || []).map(agent => ui`<option value="${agent.id}" ${selected?.id === agent.id ? 'selected' : ''}>${escapeHtml(agent.name)}${!agent.capabilities ? ' · '+t('旧版权限待迁移') : ''}</option>`).join('')}
            </select>
            <button class="small-button agent-create-button" type="button" data-action="create-custom-agent" ${agentsState.agentCreating ? 'disabled' : ''}>${agentsState.agentCreating ? t('正在创建…') : t('新增 Agent')}</button>
          </div>
        </div>
        <div class="agent-detail-column">${renderAgentWorkbench(selected)}</div>
      </div>
    </section>
  `;
}

export { formatRuntimeTimestamp, renderChannelRuntimeMetric, renderChannelRuntimeCard, renderAgentCapabilities, renderAgentPersonaFields, renderAgentWorkbench, renderAgentPage };
