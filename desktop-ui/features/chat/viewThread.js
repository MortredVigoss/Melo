// Chat thread renderers (architecture plan P2c, 2026-10-19): the chat page
// (thread header, chat files panel, scroll region, jump-to-latest, composer
// slot), the windowed message list with "加载更早", tool-trace messages, the
// streaming assistant bubble with its live run steps and active tool strip,
// the in-place streaming patch (renderStreamingFast) and the viz mount sync
// that render() calls after the DOM update. Moved out of desktop-ui/app.js
// byte-for-byte first; they now read the feature's own state and page data
// through the context. DOM, classes, data-attributes, ids and action names are
// unchanged.
import { t, ui } from '../../i18n.js';
import { renderAgentAvatar } from '../../agentAvatar.js';
import { conversationAgent, renderModelReceipt } from '../../modelPresentation.js';
import { visibleMessageWindow, ensureMessageInThreadWindow } from './threadWindow.js';
import { isToolTraceMessage, renderToolTraceMessage } from './messageToolTrace.js';
import { sceneSteps, renderRunSteps } from './runSteps.js';
import { replyPlainText } from '../../replyDocument.js';
import { mountVizBlocks } from '../../viz/vizRenderer.js';
import { renderActiveToolCallsStrip as _renderActiveToolCallsStripFromModule } from './activeToolCallsStrip.js';
import { getBootstrap, app, activeChat, activeChatAgentProfile, newChatSelection, escapeHtml, truncate, icon, renderMessageRefs, liveSceneFor, renderSceneReplay, selectedMessagePresentation, renderWorkspaceExplorer } from './context.js';
import { chatState } from './state.js';
import { renderComposerCard } from './viewComposer.js';
import { renderRichText, renderMessageBlocks, extractSourceCitations, renderSourceCitationCards, renderMessageAttachments, renderAssistantVizMount, renderMessageActions, renderMessageToolResults } from './viewMessage.js';

function renderThinkingMessage() {
  return '';
}

function renderLiveRunSteps(chat) {
  const sent = (chatState.supplementsSent || []).map(text => `<p class="run-steps-note">${escapeHtml(t('补充已送达，会在下一步加入：{text}', { text }))}</p>`).join('');
  return `<div class="run-steps-host" data-run-steps-chat="${escapeHtml(chat?.id || '')}">${renderRunSteps(sceneSteps(liveSceneFor(chat?.id)), escapeHtml, t)}</div>${sent}`;
}

function patchLiveRunSteps(chatId) {
  const host = document.querySelector(`[data-run-steps-chat="${CSS.escape(chatId || '')}"]`);
  if (host) host.innerHTML = renderRunSteps(sceneSteps(liveSceneFor(chatId)), escapeHtml, t);
}

function renderStreamingAssistantMessage(chat) {
  if (!chatState.sending || chatState.streamingChatId !== chat?.id) {
    return '';
  }

  // Tool calls strip always shown while tools are running (even before text appears).
  // The live steps of this run (what it is doing now) sit under the newest output so
  // they stay in view; they are patched in place on scene events.
  const toolStrip = renderActiveToolCallsStrip();
  const liveSteps = renderLiveRunSteps(chat);

  if (!chatState.streamingAssistantText) {
    return toolStrip + renderThinkingMessage() + liveSteps;
  }

  // Strip any <tool_call>...</tool_call> XML blocks (and partial opening tags)
  // before display — these are internal model directives, not user-visible text.
  // Also strip any <viz-spec>...</viz-spec> trailer — complete or partial — so
  // the raw JSON trailer never flashes in the streaming text on its way to
  // being turned into a Demon viz card after the stream settles.
  const displayText = chatState.streamingAssistantText
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/, '')
    .replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, '')
    .replace(/<viz-spec>[\s\S]*$/i, '')
    .trim();

  const { citations: streamCitations, cleanText: streamCleanText } =
    extractSourceCitations(displayText);

  return ui`
    ${toolStrip}
    <article class="message assistant is-streaming">
      <div class="message-role">${renderAgentAvatar(activeChatAgentProfile() || {name:t("助手")}, escapeHtml, 24)} ${escapeHtml(activeChatAgentProfile()?.name || t("助手"))}</div>
      <div
        class="message-bubble"
        data-copyable-surface
        data-copy-text="${escapeHtml(replyPlainText(streamCleanText))}"
      >
        ${renderRichText(streamCleanText)}
      </div>
      ${renderSourceCitationCards(streamCitations)}
    </article>
    ${liveSteps}
  `;
}

// Surgical DOM update for the streaming-assistant bubble. Why this exists:
// `render()` does `app.innerHTML = ...`, i.e. it blows away AND rebuilds
// EVERY node in the page. Doing that on every streamed token makes the
// whole chat flash (`闪屏`) — every sidebar row, every settled message
// bubble, every panel gets demolished and re-painted 20-50 times a second.
//
// This fast path short-circuits that for the only update 99% of streaming
// frames actually carry: "the streaming bubble grew by a few tokens." It
// finds the already-mounted `<article class="message assistant is-streaming">`
// element and patches just its bubble (and citation strip) in place.
//
// Returns true if it handled the update; false if full `render()` is needed
// (first delta of a reply, tool-strip state changed, different chat is active,
// node missing because a prior render rebuilt, etc.).
function renderStreamingFast() {
  // Sanity: must actually be streaming into the currently-active chat.
  const chat = activeChat();
  if (!chat || !chatState.sending || chatState.streamingChatId !== chat.id) return false;

  // First delta of the reply — there's no article yet, do a full render so
  // the DOM shell gets built.
  const article = document.querySelector('.message-list .message.assistant.is-streaming');
  if (!article) return false;

  // The tool-call strip sits OUTSIDE the streaming article (it's a sibling
  // above it). Its state only changes on tool_calls_start / tool_calls_done
  // events, which both go through full render(). Here we only have to
  // assume it's already in sync.

  const bubble = article.querySelector('.message-bubble');
  if (!bubble) return false;

  // Re-apply the same strip passes the template does so the bubble never
  // flashes raw `<tool_call>` / `<viz-spec>` JSON mid-stream.
  const displayText = chatState.streamingAssistantText
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/, '')
    .replace(/<viz-spec>[\s\S]*?<\/viz-spec>/gi, '')
    .replace(/<viz-spec>[\s\S]*$/i, '')
    .trim();

  const { citations: streamCitations, cleanText: streamCleanText } =
    extractSourceCitations(displayText);

  // Update bubble text + copy-surface in place. innerHTML swap here is
  // scoped to ONE small element, not the whole app, so no flash.
  bubble.innerHTML = renderRichText(streamCleanText);
  bubble.setAttribute('data-copy-text', replyPlainText(streamCleanText));

  // Update / remove the citation cards under the bubble.
  const citationHtml = renderSourceCitationCards(streamCitations);
  let citationHost = article.querySelector('.source-citation-cards');
  if (citationHtml.trim()) {
    if (!citationHost) {
      // First time any citations appear — insert a fresh node at the end.
      const wrapper = document.createElement('div');
      wrapper.innerHTML = citationHtml;
      const node = wrapper.firstElementChild;
      if (node) article.appendChild(node);
    } else {
      // Replace the existing citation strip with freshly rendered markup.
      const wrapper = document.createElement('div');
      wrapper.innerHTML = citationHtml;
      const node = wrapper.firstElementChild;
      if (node) citationHost.replaceWith(node);
    }
  } else if (citationHost) {
    citationHost.remove();
  }

  // Autoscroll the thread so the newly appended tokens stay visible. We do
  // this lightweight version instead of full syncThreadViewport() because the
  // latter reads layout-affecting state across the whole page.
  if (chatState.threadAutoFollow) {
    const scroller = document.querySelector('.thread-scroll-region');
    if (scroller instanceof HTMLElement) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  return true;
}

// Collect viz specs from the currently active chat's assistant messages
// and mount them into the DOM. Called once per render() pass, after the
// innerHTML swap.
function syncVizBlocks() {
  const chat = activeChat();
  if (!chat || !Array.isArray(chat.messages)) return;
  const specsById = new Map();
  for (const message of chat.messages) {
    if (message.role !== 'assistant') continue;
    if (!message.viz || typeof message.viz !== 'object') continue;
    specsById.set(message.id, message.viz);
  }
  if (!specsById.size) return;
  mountVizBlocks(app, specsById);
}

// Which slice of `chat.messages` gets rendered. Long threads only render the
// newest THREAD_RENDER_WINDOW messages plus whatever the user expanded via
// "加载更早"; a highlighted message (search hit / quote jump) always pulls the
// window wide enough to include it, and that expansion is persisted so the
// window doesn't snap back when the highlight is later cleared.
function activeMessageWindow(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  chatState.threadWindow ||= {};
  if (chatState.highlightedMessageId) {
    ensureMessageInThreadWindow(chatState.threadWindow, chat?.id, messages, chatState.highlightedMessageId);
  }
  return visibleMessageWindow(messages, {
    chatId: chat?.id,
    state: chatState.threadWindow,
    highlightedMessageId: chatState.highlightedMessageId,
  });
}

function renderThreadLoadEarlier(hiddenCount) {
  if (!hiddenCount) return '';
  return `<button class="small-button thread-load-earlier" type="button" data-action="thread-load-earlier">${escapeHtml(
    t('加载更早的 {count} 条', { count: hiddenCount }),
  )}</button>`;
}

function renderMessageList(chat) {
  const { messages: windowed, hiddenCount } = activeMessageWindow(chat);
  return ui`
    <div class="message-list">
      ${renderThreadLoadEarlier(hiddenCount)}
      ${windowed
        .map(selectedMessagePresentation)
        .map(
          message => ui`
            <article class="message ${message.role} ${
              chatState.highlightedMessageId === message.id ? 'is-highlighted' : ''
            } ${isToolTraceMessage(message) ? 'is-tool-trace' : ''}" data-message-id="${escapeHtml(message.id)}">
              ${isToolTraceMessage(message) ? ui`${renderToolTraceMessage(message, escapeHtml)}${renderSceneReplay(message)}` : ui`<div class="message-role">
                ${message.role === 'assistant' ? `${renderAgentAvatar((getBootstrap().customize?.agents || []).find(a=>a.id===message.metadata?.agent?.id) || {name:message.metadata?.agent?.name || 'Melo'}, escapeHtml, 24)} ${escapeHtml(message.metadata?.agent?.name || 'Melo')}` : `${renderAgentAvatar(getBootstrap().profile, escapeHtml, 24)} ${escapeHtml(getBootstrap().profile.name)}`}
              </div>
              ${renderMessageBlocks(message)}
              ${renderAssistantVizMount(message)}
              ${renderMessageToolResults(message)}
              ${renderMessageRefs(message)}
              ${renderMessageAttachments(message)}
              ${renderModelReceipt(message, escapeHtml)}
              ${renderSceneReplay(message)}
              ${renderMessageActions(message)}`}
            </article>
          `,
        )
        .join('')}
      ${renderStreamingAssistantMessage(chat)}
    </div>
  `;
}

function renderThreadArtifactStrip(artifacts) {
  if (!artifacts.length) {
    return '';
  }

  return ui`
    <section class="surface-card thread-artifact-strip">
      <div class="header-row">
        <div>
          <h2 class="pane-title">本对话成果</h2>
        </div>
        <button class="small-button" data-action="open-view" data-view="artifacts">
          Open shelf
        </button>
      </div>

      <div class="card-grid compact-grid">
        ${artifacts
          .slice(0, 3)
          .map(
            artifact => ui`
              <button
                class="artifact-card artifact-mini-card"
                data-action="open-artifact"
                data-artifact-id="${artifact.id}"
              >
                <div class="thread-meta">
                  <span class="chip is-accent">${escapeHtml(
                    artifact.language || artifact.kind,
                  )}</span>
                </div>
                <h3 class="card-title">${escapeHtml(artifact.title)}</h3>
                <p class="card-summary">${escapeHtml(truncate(artifact.content, 140))}</p>
              </button>
            `,
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderRegularChatPage() {
  const chat = activeChat();
  const project = getBootstrap().projects.find(p=>p.id===chat?.projectId);
  const chatAgent = conversationAgent(getBootstrap(), { newAgentId: newChatSelection().agentId, newProjectId: newChatSelection().projectId });

  if (!chat) {
    return ui`<section class="page is-chat neural-chat-home"><div class="neural-chat-intro"><div class="neural-overview-kicker">A NEW CONNECTION</div><h1>此刻，你在想什么？</h1><p>与 Melo 一起，把想法延伸下去。</p></div>${renderComposerCard()}</section>`;
  }

  return ui`
    <section class="page is-chat">
      <div class="chat-thread">
        <div class="thread-header">
          <div>
            <h1 class="page-title compact">
              ${escapeHtml(chat.title)}
              <span class="thread-title-caret">${icon.chevronDown}</span>
            </h1>
            <div class="thread-meta">
              ${
                project ? ui`<span class="chip">${escapeHtml(project.name)}</span>` : ''
              }
            </div>
          </div>
          <div class="inline-actions">
            <button class="small-button" type="button" data-action="delete-active-chat">删除对话</button>
            <button
              class="small-button is-outline"
              type="button"
              data-action="save-chat-as-skill"
              data-chat-id="${chat.id}"
              title="从这段对话起草一个可复用技能，保存前会先让你确认。"
            >
              存为技能
            </button>
          </div>
        </div>

        <details class="chat-files-panel" ${chatState.chatFilesOpen ? 'open' : ''}><summary data-action="toggle-chat-files">对话文件</summary>${renderWorkspaceExplorer()}${getBootstrap().workspace.selectedFile ? ui`<pre>${escapeHtml(getBootstrap().workspace.selectedFile.content)}</pre>` : ''}</details>
        <div class="thread-scroll-region">
          ${renderMessageList(chat)}
        </div>
        <div class="thread-footer">
          ${
            // "Jump to latest" floating button — appears only while the user has
            // scrolled away from the bottom. While AI is still streaming, the
            // existing updateThreadAutoFollow() keeps threadAutoFollow=false so
            // their reading position is preserved across each chunk; this
            // button lets them pull back to the newest output on demand (same
            // UX as claude.ai). Hidden when the user is already at the bottom
            // so it doesn't cover the reply.
            //
            // Wrapped with the composer in .thread-footer so the button can be
            // anchored directly above the composer card (bottom: 100% of the
            // footer) regardless of how tall the composer grows when the user
            // types multi-line, opens the slash palette, attaches files, etc.
            !chatState.threadAutoFollow && chat.messages.length
              ? ui`
                <button
                  class="thread-scroll-jump-button"
                  type="button"
                  data-action="scroll-thread-to-bottom"
                  title="Jump to latest"
                  aria-label="Jump to latest message"
                >
                  ${icon.chevronDown}
                </button>
              `
              : ''
          }
          ${renderComposerCard({ inline: true })}
        </div>
      </div>
    </section>
  `;
}

// ─── Tool call status strip (shown while tool is executing) ───────────────────
//
// G-1f (2026-05-12): extracted to ./activeToolCallsStrip.js so the renderer
// can be exercised by node --test without a DOM.  This wrapper closes over
// the chat state + the icon table + escapeHtml; the sibling module is pure
// (deps injected).  The sibling also adds evidence-trail rendering under
// each pill when the trail is informative (failure path OR multi-tier
// fallback) — same heuristic as the G-1e prompt-side surfacing.
function renderActiveToolCallsStrip() {
  return _renderActiveToolCallsStripFromModule(chatState.activeToolCalls, {
    escapeHtml,
    terminalIcon: icon.terminal,
  });
}

export { renderThinkingMessage, renderLiveRunSteps, patchLiveRunSteps, renderStreamingAssistantMessage, renderStreamingFast, syncVizBlocks, activeMessageWindow, renderThreadLoadEarlier, renderMessageList, renderThreadArtifactStrip, renderRegularChatPage, renderActiveToolCallsStrip };
