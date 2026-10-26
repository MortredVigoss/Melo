// Chat composer renderers (architecture plan P2c, 2026-10-19): the composer
// card (Agent chip, image task controls, execution panel, retry banner,
// connection alert, thinking banner, attachment menu, team / context / model
// / voice controls, slash palette, textarea, attachment chips, drop banner),
// the chat-side Agent picker and the thinking label. Moved out of
// desktop-ui/app.js byte-for-byte first; they now read the feature's own
// state and the shared new-chat selection / model picker / permission queue
// through the context. DOM, classes, data-attributes, ids and action names
// are unchanged.
import { t, ui } from '../../i18n.js';
import { renderAgentAvatar } from '../../agentAvatar.js';
import { conversationAgents, conversationAgent, conversationConnectionReady, renderModelPicker } from '../../modelPresentation.js';
import { renderAtomicButton } from '../../atomicButton.js';
import { renderConversationContext } from './conversationContext.js';
import { renderImageTaskControls } from '../../imageControls.js';
import { renderTeamPanel } from '../../teamPanel.js';
import { voiceInputSupported, voiceInputActive, voiceInputLabel, renderVoiceInput } from '../../voiceInput.js';
import { turnLabel } from './turnPresentation.js';
import { getBootstrap, isOverview, newChatSelection, modelPicker, toolPermissions, voiceLanguage, activeChat, activeChatAgentProfile, allChatAgentProfiles, composerTeamPlan, escapeHtml, icon, modelOptionsForAuthMode, renderTtsVoicePanel, renderExecutionPanel } from './context.js';
import { chatState } from './state.js';
import { attachmentIcon, attachmentLabel, slashPaletteMatches } from './controller.js';

function thinkingLabel() {
  if (!chatState.sending) {
    return '';
  }

  const label = turnLabel(chatState.activeTurn, { permission: toolPermissions().length > 0, tools: chatState.activeToolCalls.some(tool => tool.status === 'running') });
  if (!chatState.thinkingSince) return label;

  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - chatState.thinkingSince) / 1000),
  );
  return `${label} · ${t('已用时 {time}', { time: t('{seconds} 秒', { seconds: elapsedSeconds }) })}`;
}

function renderAttachmentPreviewList(attachments = []) {
  if (!attachments.length) {
    return '';
  }

  return ui`
    <div class="composer-attachment-list">
      ${attachments
        .map(
          attachment => ui`
            <div class="composer-attachment-chip">
              <span class="chip-icon">${attachmentIcon(attachment.kind, attachment)}</span>
              <span class="composer-attachment-label">${escapeHtml(attachmentLabel(attachment))}</span>
              ${
                attachment.sizeLabel
                  ? ui`<span class="meta-label">${escapeHtml(attachment.sizeLabel)}</span>`
                  : ''
              }
              <button
                class="composer-attachment-remove"
                type="button"
                data-action="remove-composer-attachment"
                data-attachment-id="${attachment.id}"
                title="Remove attachment"
              >
                ×
              </button>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderComposerAttachmentMenu() {
  if (!chatState.composerAttachmentMenuOpen) {
    return '';
  }

  return ui`
    <div class="composer-attachment-menu">
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="image/*">
        <span class="chip-icon">${icon.image}</span>
        图片文件
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="video/*" title="Direct video files are parsed best-effort: audio is transcribed and keyframes are sent when the media is accessible. Platform links may fall back to preview text.">
        <span class="chip-icon">${icon.video}</span>
        <span class="composer-menu-item-text">
          <span>视频文件</span>
          <span class="composer-menu-item-hint">尽力转写并提取关键画面</span>
        </span>
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="audio/*" title="Audio is transcribed first, then the transcript is sent to the model. Raw audio is only used when the selected backend supports it.">
        <span class="chip-icon">${icon.audio}</span>
        <span class="composer-menu-item-text">
          <span>音频</span>
          <span class="composer-menu-item-hint">先转写文字再发送</span>
        </span>
      </button>
      <button class="composer-menu-item" type="button" data-action="pick-composer-attachment" data-accept="application/pdf,.pdf" title="Text-based PDFs are extracted via pdf-parse and the text is sent to the model. Scanned image-only PDFs may need OCR.">
        <span class="chip-icon">${icon.file}</span>
        <span class="composer-menu-item-text">
          <span>PDF</span>
          <span class="composer-menu-item-hint">仅限文字型 PDF</span>
        </span>
      </button>
      <button class="composer-menu-item" type="button" data-action="add-link-attachment">
        <span class="chip-icon">${icon.link}</span>
        Link
      </button>
    </div>
  `;
}

function composerHintText({ inline = false } = {}) {
  if (chatState.attachmentUploading) {
    return t('正在上传视频「{name}」，完成后可发送。', { name: chatState.attachmentUploading });
  }
  if (chatState.sending) {
    return t('正在回复。可以继续输入补充要求，会在下一步加入；更换 Agent、模型或项目从下一条消息生效。');
  }
  if (chatState.voice.recording) {
    return '正在听写，点击麦克风停止。文字可修改，确认后发送。';
  }
  if (chatState.voice.preview) {
    return '转写完成后可编辑，再点击发送。';
  }
  if (!inline && !chatState.composer.trim()) {
    return 'Type / for Melo commands, files, projects, and actions.';
  }
  if (inline) {
    return 'Reply in this thread';
  }
  return 'Enter to send. Shift+Enter for a new line.';
}

function composerPlaceholder() {
  if (!activeChat()) {
    return t("问问 Melo，或输入 / 使用命令…");
  }

  switch (getBootstrap()?.settings.activeMode) {
    case 'cowork':
      return 'What are we solving together?';
    case 'code':
      return 'Ask about files, builds, code changes, or your workspace...';
    case 'chat':
    default:
      return t("今天有什么可以帮你？");
  }
}

// Phase 3.3.3 — slash-command palette popover. Rendered inside the
// composer input frame above the textarea. Returns empty string when the
// palette isn't open OR there's nothing to show; this is the normal state.
function renderSlashPalette() {
  if (!chatState.slashPalette.open) return '';
  const matches = slashPaletteMatches();
  if (!matches.length) {
    return ui`
      <div class="slash-palette" role="listbox">
        <div class="slash-palette-empty">No skills match /${escapeHtml(chatState.slashPalette.query)}</div>
      </div>
    `;
  }
  const selectedIndex = Math.min(
    Math.max(0, chatState.slashPalette.selectedIndex | 0),
    matches.length - 1,
  );
  return ui`
    <div class="slash-palette" role="listbox">
      ${matches
        .map((skill, i) => ui`
          <button
            type="button"
            class="slash-palette-item ${i === selectedIndex ? 'is-active' : ''}"
            data-action="pick-slash-skill"
            data-skill-id="${escapeHtml(skill.id)}"
            role="option"
          >
            <span class="slash-palette-id">/${escapeHtml(skill.id)}</span>
            <span class="slash-palette-name">${escapeHtml(skill.name)}</span>
            ${skill.description
              ? ui`<span class="slash-palette-desc">${escapeHtml(skill.description)}</span>`
              : ''}
          </button>
        `)
        .join('')}
      <div class="slash-palette-hint">↑↓ to move · Enter to pick · Esc to close</div>
    </div>
  `;
}

function renderComposerCard({ inline = false } = {}) {
  const data = getBootstrap();
  const composerChat = !isOverview() ? activeChat() : null;
  const project = data.projects.find(p=>p.id===(composerChat ? composerChat.projectId : newChatSelection().projectId));
  const workspace = data.workspace || {};
  const selectedFile = workspace.selectedFile;
  const voiceSupported = voiceInputSupported();
  const isHomeComposer = !inline;
  const voicePreviewMarkup = renderVoiceInput(chatState.voice, escapeHtml);
  const footerMarkup =
    isHomeComposer || selectedFile
      ? ui`
        <div class="composer-footer">
          <div class="composer-footer-copy">
            ${project ? `Project: ${escapeHtml(project.name)}` : 'Local-first Melo chat is ready.'}
          </div>
          ${
            selectedFile
              ? ui`<div class="composer-footer-copy is-secondary">Selected file: ${escapeHtml(selectedFile.path)}</div>`
              : ''
          }
        </div>
      `
      : '';

  return ui`
    <div class="composer-shell">
      <div class="composer-conversation-choice agent-chip-anchor">${renderAgentSelectorChip()}${chatState.agentSelectionSaving?ui`<span class="list-row-meta" role="status" aria-live="polite">正在切换Agent…</span>`:''}</div>
      ${renderImageTaskControls(chatState.composerAttachments)}
      ${renderExecutionPanel()}
      ${chatState.composerRetry?.interrupted && chatState.composerRetry.chatId === composerChat?.id ? ui`<div class="alert">上次请求已中断，可能已有部分操作完成。请先核对对话与执行记录。<button type="button" class="small-button" data-action="restart-interrupted-send">已核对，作为新请求重新执行</button></div>` : ''}
      ${
        !conversationConnectionReady(data.settings.config, composerChat ? composerChat.modelSelection : newChatSelection().model)
          ? ui`
            <div class="alert">
              ${
                data.settings.config.authMode === 'codex'
                  ? 'OAuth is not configured yet. Open Model and start the Codex login flow.'
                  : data.settings.config.authMode === 'local'
                    ? 'Local model mode is not configured yet. Open Model and enter your local endpoint and model.'
                    : 'API mode is not configured yet. Open Model and add your API key.'
              }
            </div>
          `
          : ''
      }

      ${chatState.sending ? ui`<div class="thinking-banner">${escapeHtml(thinkingLabel())}</div>` : ''}

      <div class="composer-card ${inline ? 'is-thread' : ''}">
        <form data-form="composer" class="composer-form">
          <div class="composer-core">
            ${footerMarkup}
            <div class="composer-actions">
              <div class="composer-bottom-left">
                <button
                  class="composer-icon-button"
                  type="button"
                  data-action="toggle-composer-attachment-menu"
                  title="添加附件"
                >
                  <span class="toolbar-icon">${icon.plus}</span>
                </button>
                ${renderComposerAttachmentMenu()}
                <span class="composer-status-copy">${escapeHtml(composerHintText({ inline }))}</span>
              </div>

              <div class="composer-bottom-right">
                ${renderTeamPanel({scope:'chat',lead:activeChatAgentProfile(),agents:conversationAgents(data,{overview:isOverview(),newProjectId:newChatSelection().projectId}),plan:composerTeamPlan(),disabled:false,escapeHtml})}
                ${renderConversationContext({chat:!isOverview()?activeChat():null,projectId:newChatSelection().projectId,artifactIds:newChatSelection().artifactIds,projects:data.projects,artifacts:data.artifacts,disabled:false},escapeHtml)}
                ${renderModelPicker({
                  config: data.settings.config,
                  selection:!isOverview() && activeChat() ? activeChat().modelSelection : newChatSelection().model,
                  models: modelOptionsForAuthMode(data.settings.config.authMode),
                  agent: conversationAgent(data, { overview: isOverview(), newAgentId: newChatSelection().agentId, newProjectId: newChatSelection().projectId }),
                  open: modelPicker().open,
                  saving: modelPicker().saving,
                }, escapeHtml)}

                <div class="tts-voice-panel-anchor">
                  ${renderTtsVoicePanel()}
                  ${renderAtomicButton()}
                </div>

                <select class="voice-language" aria-label="语音识别语言" data-voice-language ${voiceInputActive(chatState.voice) || chatState.agentSelectionSaving ? 'disabled' : ''}>
                  ${[['zh-CN', t("中文")], ['en-US', 'English'], ['system', t("系统语言")]].map(([value, label]) => ui`<option value="${value}" ${(voiceLanguage() || 'system') === value ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
                <button
                  class="composer-icon-button ${chatState.voice.recording ? 'is-recording' : ''}"
                  type="button"
                  data-action="toggle-voice-input"
                  ${chatState.voice.status !== 'stopping' ? '' : 'disabled'}
                  aria-label="${escapeHtml(voiceInputLabel(chatState.voice))}"
                  aria-pressed="${voiceInputActive(chatState.voice)}"
                  title="${voiceSupported ? escapeHtml(voiceInputLabel(chatState.voice)) : '当前浏览器不支持语音识别，点击查看说明'}"
                >
                  <span class="toolbar-icon">${chatState.voice.recording ? icon.stop : icon.mic}</span>
                </button>

                ${
                  chatState.sending
                    ? ui`
                      <button class="composer-icon-button" type="submit" title="补充到正在进行的回复">
                        <span class="toolbar-icon">${icon.send}</span>
                      </button>
                      <button class="composer-icon-button is-stop" type="button" data-action="stop-send" title="停止生成">
                        <span class="toolbar-icon">${icon.stop}</span>
                      </button>
                    `
                    : ui`
                      <button class="composer-icon-button is-primary" type="submit" title="发送消息" ${voiceInputActive(chatState.voice) || chatState.agentSelectionSaving ? 'disabled' : ''}>
                        <span class="toolbar-icon">${icon.send}</span>
                      </button>
                    `
                }
              </div>
            </div>

            ${voicePreviewMarkup}

            <div
              class="composer-input-frame ${chatState.voice.recording ? 'is-recording' : ''} ${
                chatState.composerDragActive ? 'is-drop-target' : ''
              }"
            >
              ${renderSlashPalette()}
              <textarea
                id="composer"
                class="composer-textarea"
                rows="2"
                placeholder="${escapeHtml(chatState.sending ? t("输入补充要求") : inline ? t("回复…") : composerPlaceholder())}"
                aria-label="消息输入框"
              >${escapeHtml(chatState.composer)}</textarea>
            </div>

            ${renderAttachmentPreviewList(chatState.composerAttachments)}
            ${
              chatState.composerDragActive
                ? ui`
                  <div class="composer-drop-banner">
                    Drop image, audio, video, or PDF here. Media extraction runs best-effort before the model sees it.
                  </div>
                `
                : ''
            }
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderAgentSelectorChip() {
  const agent = activeChatAgentProfile();
  if (!agent) return '';
  return ui`
    <button type="button" class="chip chip-btn ${chatState.agentSelectorOpen ? 'is-active' : ''}"
            data-action="toggle-agent-selector"
            aria-haspopup="dialog" aria-expanded="${chatState.agentSelectorOpen}" aria-controls="agent-selector-panel"
            title="选择对话Agent" aria-label="选择对话 Agent" ${chatState.agentSelectionSaving ? 'disabled' : ''}>
      <span class="agent-selector-caption">Agent</span>${renderAgentAvatar(agent, escapeHtml, 22)} ${escapeHtml(agent.name)}
      <span style="margin-left:4px;opacity:.6;font-size:.75em">▾</span>
    </button>
  `;
}

function renderAgentSelectorDropdown() {
  if (!chatState.agentSelectorOpen) return '';
  const agents = allChatAgentProfiles();
  if (!agents.length) return '';
  return ui`
    <div id="agent-selector-panel" class="agent-selector-dropdown agent-selector-slide-up" popover="manual" role="dialog" aria-label="选择对话Agent">
      <header><strong>选择对话 Agent</strong><p>默认Agent和你创建的Agent都在这里。切换只影响后续回复。</p></header>
      ${agents.map(agent => ui`
        <button type="button" class="agent-selector-row ${activeChatAgentProfile()?.id === agent.id ? 'is-selected' : ''}" aria-pressed="${activeChatAgentProfile()?.id === agent.id}"
                data-action="select-chat-agent" ${chatState.agentSelectionSaving?'disabled':''}
                data-agent-id="${escapeHtml(agent.id)}">
          ${renderAgentAvatar(agent, escapeHtml, 28)}<span class="agent-selector-name">${escapeHtml(agent.name)}</span>

          ${agent.id === 'main' ? ui`<span class="agent-selector-tag">默认</span>` : agent.isCustom ? ui`<span class="agent-selector-tag">自定义</span>` : ''}
        </button>
      `).join('')}
    </div>
  `;
}

export { thinkingLabel, renderAttachmentPreviewList, renderComposerAttachmentMenu, composerHintText, composerPlaceholder, renderSlashPalette, renderComposerCard, renderAgentSelectorChip, renderAgentSelectorDropdown };
