import { applyButtonStyles } from './buttonStyles.js';
import { escapeHtml } from './i18n.js';
import { t, ui, currentLanguage, runtimeStageName, runtimeStageOutput, runtimeCompletionText } from './i18n.js';
import { renderExecutionDetail, renderSessionEvents, executionApiLine, renderExecutionSignal, renderReasoningRecords, renderExecutionTiming } from './executionDetails.js';
import { EXECUTION_MODULES, sessionEvents, moduleActivity, projectPhoneToolStages, sceneFinished, finishExecutionScene, visibleSceneSources, sourceReadingLabel, sceneSourceUrl } from '/shared/executionScene.js';
import { sceneMembers, operationVerb } from '/shared/executionBoard.js';
import { shouldAutoOpen, sceneNeedsUser } from '/shared/warRoom.js';
import { createWarRoom } from './warRoom.js';

const statusNames = { get idle() { return t('无调用记录'); }, get recorded() { return t('仅引用记录'); }, get queued() { return t('排队'); }, get running() { return t('执行中'); }, get waiting() { return t('等待许可'); }, get completed() { return t('已完成'); }, get failed() { return t('失败'); }, get cancelled() { return t('已取消'); }, get interrupted() { return t('已中断'); } };
const scenes = new Map(), views = new Map(), delivered = new Set();
const presentations = new Map();
const historyCursors = new Map();
const attemptedVisibleScenes = new Set(), observedMessages = new WeakMap();
let replayObserver;
// Layout A (2026-11-06): the task space opens as the full-screen war room
// (warRoom.js); in the chat it is one strip. `opened` is whether the war room
// is showing. A run opens it by itself once, when it first does something
// observable; a run the user closed while it ran stays closed; when the run
// ends the war room hands back to the chat unless the user has touched it.
let host, warRoom = null, currentChat = null, currentRun = null, opened = false, focus = null, more = false;
let autoRun = null, collapseTimer, pendingHandoff = null, loadedChat = null, lastPoll = 0, refreshChat = () => {}, uiStill = false;
let selectionBusy = false, selectionError = '', slot = 0, closingRun = null, renderNote = '';
let autoCollapse = true, imageRetryHandler = null, leadName = '', touched = false, hostManaged = false;
// `aside`: runs whose war room stepped aside for a prompt that needs the user
// (it comes back once the prompt is answered). On a phone the native screen
// decides all of this (`hostManaged`).
const autoOpened = new Set(), dismissed = new Set(), aside = new Set();
function scheduleCollapse(runId) {
  if (!autoCollapse || !autoOpened.has(runId)) return;
  clearTimeout(collapseTimer); closingRun = runId;
  collapseTimer = setTimeout(() => {
    if (closingRun !== runId || currentRun !== runId || !sceneFinished(selectedScene()) || touched || !opened) return;
    closingRun = null; setOpen(false);
  }, 2600);
}
function cancelCollapse() { clearTimeout(collapseTimer); closingRun = null; }
// A prompt waiting for the user's answer (tool permission, task scope, file
// safety, capability request) carries data-request-id on its buttons, and a
// call held for permission shows in the scene. While either is showing, the
// war room stays out of its way and comes back once it is answered.
const promptShowing = () => [...document.querySelectorAll('[data-request-id]')].some(el => !el.closest('#execution-war-room'));
const blockedByUser = scene => sceneNeedsUser(scene) || promptShowing();
let promptObserver = null, promptCheck = false;
function reconcilePrompts(scene = selectedScene()) {
  if (hostManaged || !scene || scene.runId !== currentRun) return false;
  const blocked = blockedByUser(scene);
  if (opened && blocked) { aside.add(scene.runId); setOpen(false, { stepAside: true }); return true; }
  if (!opened && !blocked && aside.has(scene.runId) && !sceneFinished(scene) && !dismissed.has(scene.runId)) { aside.delete(scene.runId); setOpen(true); return true; }
  return blocked;
}
function watchPrompts() {
  if (promptObserver || hostManaged || typeof MutationObserver === 'undefined') return;
  promptObserver = new MutationObserver(() => { if (promptCheck) return; promptCheck = true; queueMicrotask(() => { promptCheck = false; reconcilePrompts(); }); });
  promptObserver.observe(document.body, { childList: true, subtree: true });
}

export const renderExecutionPanel = () => ui`<section id="execution-panel" class="execution-panel is-collapsed" data-neural-key="execution-panel" data-execution-owned="true" aria-label="三维任务空间" hidden></section>`;
export function renderSceneReplay(message) {
  const id = message.role === 'assistant' && message.metadata?.runId;
  return id ? ui`<button type="button" class="message-scene-replay" data-execution-action="replay" data-run="${escapeHtml(id)}">◌ 回看任务空间</button><div data-execution-timing-run="${escapeHtml(id)}">${renderExecutionTiming(scenes.get(id))}</div>` : '';
}
const selectedScene = () => {
  const scene = scenes.get(currentRun); if (!scene) return null;
  let presentation = presentations.get(currentRun);
  if (!presentation) try { presentation = JSON.parse(localStorage.getItem(`melo-scene-presented:${currentRun}`) || 'null'); } catch {}
  if (!presentation || presentation.messageId !== scene.messageId || scene.pipeline?.some(p => p.id === 'reply:render')) return scene;
  return { ...scene, pipeline: [...(scene.pipeline || []), presentation] };
};
function observeRenderedMessages(chat) {
  // Old replies load their saved image selection when they enter the viewport;
  // paging the scene inspector must not change the images shown in chat history.
  if (typeof IntersectionObserver !== 'undefined') {
    replayObserver ||= new IntersectionObserver(entries => {
      for (const entry of entries) {
        const target = observedMessages.get(entry.target);
        if (!entry.isIntersecting || !target || scenes.has(target.runId) || attemptedVisibleScenes.has(target.runId)) continue;
        attemptedVisibleScenes.add(target.runId);
        replayObserver.unobserve(entry.target);
        void loadScenes(target.chatId, { runId: target.runId });
      }
    }, { rootMargin: '400px' });
    replayObserver.disconnect();
    const messages = new Map((chat?.messages || []).map(message => [message.id, message]));
    for (const element of document.querySelectorAll('.message[data-message-id]')) {
      const message = messages.get(element.dataset.messageId), runId = message?.metadata?.runId;
      if (message?.role !== 'assistant' || !runId || scenes.has(runId)) continue;
      observedMessages.set(element, { chatId: chat.id, runId });
      replayObserver.observe(element);
    }
  }
  for (const message of chat?.messages || []) {
    const runId = message.metadata?.runId, scene = scenes.get(runId);
    if (!sceneFinished(scene) || scene.messageId !== message.id || presentations.has(runId)) continue;
    const rendered = [...document.querySelectorAll('.message[data-message-id]')].some(el => el.dataset.messageId === message.id);
    if (!rendered) continue;
    let saved;
    try { saved = JSON.parse(localStorage.getItem(`melo-scene-presented:${runId}`) || 'null'); } catch {}
    const presentation = saved?.messageId === message.id ? saved : { id: 'reply:render', module: 'create', name: t('本机对话渲染'), status: 'completed',
      messageId: message.id, output: t('回答已渲染到当前设备的对话界面；不代表用户已阅读'), finishedAt: new Date().toISOString() };
    presentations.set(runId, presentation);
    try { localStorage.setItem(`melo-scene-presented:${runId}`, JSON.stringify(presentation)); } catch {}
  }
}
function rememberView() {
  if (!currentRun) return;
  const view = { focus, more, slot, zoom: 1 };
  views.set(currentRun, view);
  try { localStorage.setItem(`melo-scene-view:${currentRun}`, JSON.stringify(view)); } catch {}
}
function chooseRun(runId) {
  rememberView(); currentRun = runId; renderNote = '';
  let view = views.get(runId);
  if (!view) try { view = JSON.parse(localStorage.getItem(`melo-scene-view:${runId}`) || 'null'); } catch {}
  focus = EXECUTION_MODULES.some(m => m.id === view?.focus) ? view.focus : null;
  more = !!view?.more; slot = view?.slot || 0;
  warRoom?.restore(focus, runId);
}
function preserveReading(action) {
  const scroller = document.querySelector('.thread-scroll-region');
  const top = scroller?.scrollTop || 0;
  const bottom = scroller && scroller.scrollHeight - scroller.clientHeight - top < 24;
  action();
  if (scroller) scroller.scrollTop = bottom ? scroller.scrollHeight : top;
}
function setOpen(value, { focus = false, stepAside = false } = {}) {
  // Closing a run that is still working means: do not open it again by itself
  // (stepping aside for a prompt is not the user closing it).
  if (opened && !value && !stepAside && currentRun && !sceneFinished(selectedScene())) { dismissed.add(currentRun); aside.delete(currentRun); }
  opened = value;
  // Only a user's own open moves keyboard focus; an automatic one never takes it from a prompt or the composer.
  ensureWarRoom().setOpen(value, { focus });
  updateButtons(); paint();
  if (!value && pendingHandoff && [...document.querySelectorAll('.message[data-message-id]')].some(el => el.dataset.messageId === pendingHandoff.messageId)) { handoff(pendingHandoff); pendingHandoff = null; }
}
function ensureWarRoom() {
  if (warRoom) return warRoom;
  warRoom = createWarRoom({
    onClose: () => { cancelCollapse(); setOpen(false); },
    onInteract: () => { touched = true; cancelCollapse(); },
    onRegionChange: id => { focus = id; rememberView(); },
    recordDetail: id => { const scene = selectedScene(), op = [...(scene?.operations || []), ...(scene?.pipeline || [])].find(item => item.id === id); return op ? renderExecutionDetail(op, statusNames[op.status]) : ''; },
    regionExtra,
    traceExtra: key => key === 'calls' ? renderSessionEvents(sessionEvents(selectedScene())) : key === 'tokens' ? renderExecutionSignal(selectedScene()) : '',
  });
  // The run was chosen before the war room existed: give it that run's remembered region now.
  warRoom.restore(focus, currentRun);
  return warRoom;
}
// What a region shows beyond its list of calls: the sources it found (with
// links and whether the answer cited them), the model's public summaries, or
// the generated results with their selection controls.
function regionExtra(id) {
  focus = id;
  const scene = selectedScene();
  if (id === 'search') return ui`<div class="war-extra">${renderSearchTrail(scene)}<div class="war-source-grid">${renderDetails(scene, detailsFor(scene))}</div>${(scene?.sources.length || 0) > 5 ? ui`<button type="button" class="war-link" data-execution-action="more">${more ? '收起至五个' : '展开更多 · 最多十个'}</button>` : ''}</div>`;
  if (id === 'compute') return ui`<div class="war-extra">${renderReasoningRecords(scene, statusNames)}</div>`;
  if (id === 'create') return ui`<div class="war-extra">${renderCandidates(scene)}</div>`;
  return '';
}
function updateButtons() {
  document.querySelectorAll('.atomic-button').forEach(button => {
    button.setAttribute('aria-expanded', String(opened));
    button.setAttribute('aria-label', opened ? t("收起任务动画") : t("展开任务动画"));
    button.dataset.busy = String(!!selectedScene() && !sceneFinished(selectedScene()));
  });
}
function headerStatus(scene) {
  if (!scene) return t("待机 · 氛围动画");
  if (sceneFinished(scene) && scene.completion?.summary) return runtimeCompletionText(scene.completion);
  if (sceneFinished(scene)) return t('{status} · 回看记录，未在执行', { status: statusNames[scene.status] });
  const members = sceneMembers(scene).filter(member => member.running);
  if (members.length > 1) return t('{count} 个成员并行工作', { count: members.length });
  if (members.length === 1) {
    const member = members[0], op = scene.operations.find(row => row.id === member.activeOperation);
    const role = { research: t('检索成员'), lookup: t('资料读取成员'), calculate: t('计算成员'), execute: t('执行成员') }[member.role] || member.label;
    const verb = op ? { search: t('检索'), read: t('读取'), lookup: t('查询'), compute: t('计算'), write: t('写入'), call: t('调用') }[operationVerb(op)] : t('思考中');
    return `${role} · ${verb}`;
  }
  const running = scene.operations.filter(op => op.status === 'running');
  if (running.length > 1) return t('{count} 项真实调用并行执行', { count: running.length });
  if (running.length === 1) return t('{module} · 执行中', { module: EXECUTION_MODULES.find(m => m.id === running[0].module)?.name });
  if (scene.operations.some(op => op.status === 'waiting')) return t("等待许可 · 尚未执行");
  const stage = (scene.pipeline || []).filter(item => item.status === 'running').at(-1);
  if (stage) return `${runtimeStageName(stage, currentLanguage())} · ${stage.channel === 'reasoning-summary' ? t("公开摘要更新中") : runtimeStageOutput(stage) || t("执行中")}`;
  return scene.operations.length ? t("调用已返回 · 等待回答") : t("请求处理中 · 等待可观测工具事件");
}
function detailsFor(scene) {
  if (focus === 'search') return visibleSceneSources(scene, more);
  if (focus === 'create') return [];
  if (focus === 'compute') return moduleActivity(scene, focus).operations.filter(op => op.channel !== 'reasoning-summary').map(op => ({ ...op, title: op.expression || runtimeStageName(op) }));
  return moduleActivity(scene, focus).operations.map(op => ({ ...op, title: op.expression || runtimeStageName(op) }));
}
function renderDetails(scene, items) {
  if (focus === 'search') return items.map((source, index) => {
    const linkUrl = source.citationUrl || source.url;
    const sourceUrl = new URL(linkUrl);
    const title = source.titleProvided ? source.title : source.citationLabel || (sourceUrl.pathname === '/' ? sourceUrl.hostname : sourceUrl.pathname.split('/').filter(Boolean).slice(-2).join('/'));
    const reading = sourceReadingLabel(source), citation = source.cited ? t('已被最终引用') : t('未被最终引用');
    return ui`<a class="execution-label execution-source" data-node-id="${escapeHtml(source.id)}" data-priority="${index < 5 ? 'primary' : 'secondary'}" data-cited="${source.cited}" href="${escapeHtml(linkUrl)}" data-external-url="${escapeHtml(linkUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(`${source.titleProvided ? source.title : '页面标题未提供'}\n${linkUrl}\n${reading}\n${citation}\n服务：${source.providers.join('、') || '未报告'}${source.recovered ? '\n从截断记录与最终引用恢复；正文范围未知' : ''}`)}"><span class="execution-source-rank">${String(index + 1).padStart(2, '0')} · ${source.cited ? '回答引用' : index < 5 ? '相关来源' : '更多候选'}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(new URL(source.url).hostname)}</small><small>${escapeHtml(reading)}</small><small>${source.cited ? '✦ 已引用' : '未引用 · 点击检查'}</small></a>`;
  }).join('');
  return items.map(op => ui`<button class="execution-label execution-source execution-operation" data-node-id="${escapeHtml(op.id)}" data-execution-action="inspect" data-operation="${escapeHtml(op.id)}" title="${escapeHtml(`${op.input || ''}\n${runtimeStageOutput(op) || ''}`)}"><strong>${escapeHtml(op.result ?? op.expression ?? runtimeStageName(op))}</strong><small>${escapeHtml(op.channel === 'reasoning-summary' ? (runtimeStageOutput(op) || '').slice(-100) : focus === 'tools' ? `归属：${EXECUTION_MODULES.find(m => m.id === op.module)?.name || t("工具调用")} · ${op.provider || op.name}` : op.expression || op.input || op.name)}</small><small>${escapeHtml(statusNames[op.status])}</small></button>`).join('');
}
function renderSearchTrail(scene) {
  if (focus !== 'search') return '';
  const ops = (scene?.operations || []).filter(op => op.module === 'search');
  return ui`<div class="execution-search-trail" aria-label="真实检索调用">${ops.map(op => ui`<button data-execution-action="inspect" data-operation="${escapeHtml(op.id)}" title="${escapeHtml(`${op.input || ''}\n${op.resultSummary || op.status}`)}"><b>${escapeHtml(op.provider === 'iPhone' ? runtimeStageName(op) : op.provider || op.name)}</b> · ${escapeHtml((op.provider === 'iPhone' ? runtimeStageOutput(op) : op.resultSummary) || statusNames[op.status])}</button>`).join('')}</div>`;
}
function renderCandidates(scene) {
  if (focus !== 'create') return '';
  const artifacts = scene?.artifacts || [];
  const stages = moduleActivity(scene, 'create').operations;
  const delivery = ui`<div class="execution-pipeline" aria-label="模型与交付记录">${stages.map(stage => ui`<button data-execution-action="inspect" data-operation="${escapeHtml(stage.id)}" data-stage-status="${escapeHtml(stage.status)}"><strong>${escapeHtml(runtimeStageName(stage, currentLanguage()))}</strong><span>${escapeHtml(statusNames[stage.status] || stage.status)}</span><small>${escapeHtml(runtimeStageOutput(stage) || stage.input || t("等待返回"))}</small>${stage.api ? ui`<small class="execution-api-line">${escapeHtml(executionApiLine(stage))}</small>` : ''}</button>`).join('')}</div>`;
  const previews = (scene?.previews || []).filter(p => !artifacts.some(a=>a.operationId===p.operationId));
  const previewCards = previews.map(p => ui`<article class="execution-candidate execution-preview"><img src="${escapeHtml(p.url)}" alt="服务返回的生成预览"><p>${sceneFinished(scene)?'生成未完成的预览':'生成中的预览'} · 非最终成果</p></article>`).join('');
  const missing = Math.max(0,(scene?.imageTask?.count || 0)-artifacts.filter(a=>a.kind==='image').length);
  const retry = imageRetryHandler && sceneFinished(scene) && missing ? ui`<button class="execution-image-retry" data-execution-action="retry-images">重试缺少的 ${missing} 张 · 发起新请求</button>` : '';
  if (!artifacts.length) return stages.length || previews.length ? ui`<div class="execution-outcomes">${delivery}<div class="execution-candidates">${previewCards}</div>${retry}</div>` : ui`<div class="execution-empty"><strong>还没有模型与交付记录</strong>旧任务未记录的接收、整理与保存过程不会补造</div>`;
  const images = artifacts.filter(a => a.kind === 'image'), selected = scene.selectedImageIds || [];
  return ui`<div class="execution-outcomes"><details class="execution-delivery-details"><summary>查看 ${stages.length} 条执行记录</summary>${delivery}</details>${retry}<div class="execution-candidates">${previewCards}${artifacts.map(artifact => ui`<article class="execution-candidate" data-selected="${selected.includes(artifact.id)}">
    <a href="${escapeHtml(artifact.url)}" data-external-url="${escapeHtml(artifact.url)}" target="_blank" rel="noopener noreferrer">${artifact.kind === 'image' ? ui`<img src="${escapeHtml(artifact.url)}" alt="${escapeHtml(artifact.title)}" loading="lazy">` : escapeHtml(artifact.title)}</a>
    <p>${escapeHtml(artifact.title)} ${selected.includes(artifact.id) ? `· 展示第 ${selected.indexOf(artifact.id) + 1} 张` : '· 可检查候选'}</p>
    ${artifact.requestedModel ? ui`<small>${escapeHtml(artifact.engine)} · 请求 ${escapeHtml(artifact.requestedModel)} · 返回 ${escapeHtml(artifact.reportedModel || t("服务未报告"))}</small>` : ''}
    ${artifact.requestedQuality ? ui`<small aria-label="查看图片质量">质量：请求 ${escapeHtml(artifact.requestedQuality)} · 返回 ${escapeHtml(artifact.reportedQuality || t("服务未报告"))}</small>` : ''}
    ${artifact.beforeUrl ? ui`<details class="execution-comparison"><summary>查看修改前后</summary><div><figure><img src="${escapeHtml(artifact.beforeUrl)}" alt="修改前" loading="lazy"><figcaption>修改前</figcaption></figure><figure><img src="${escapeHtml(artifact.url)}" alt="修改后" loading="lazy"><figcaption>修改后</figcaption></figure></div></details>` : ''}
    ${artifact.kind === 'image' && sceneFinished(scene) ? ui`<div class="execution-candidate-controls"><select aria-label="替换图片位置" data-execution-slot>${Array.from({ length: Math.min(scene.requestedImages, images.length) }, (_, i) => ui`<option value="${i}" ${i === slot ? 'selected' : ''}>第 ${i + 1} 张</option>`).join('')}</select><button data-execution-action="select-image" data-artifact="${escapeHtml(artifact.id)}" ${selectionBusy ? 'disabled' : ''}>${selected.includes(artifact.id) ? t("已选中") : t("选为展示")}</button></div>` : ''}
  </article>`).join('')}</div></div>`;
}
function paintTiming(liveOnly = false) {
  if (document.hidden) return;
  const update = (node, scene) => {
    if (!node || liveOnly && (!scene || sceneFinished(scene))) return;
    const html = renderExecutionTiming(scene);
    if (node.innerHTML !== html) node.innerHTML = html;
  };
  update(host?.querySelector('.execution-timing-host'), selectedScene());
  for (const node of document.querySelectorAll('[data-execution-timing-run]')) update(node, scenes.get(node.dataset.executionTimingRun));
}
const imageDeficit = scene => {
  const images = scene?.artifacts.filter(a => a.kind === 'image') || [];
  return scene?.operations.some(op => ['image', 'image_edit', 'native_image_generation'].includes(op.name)) && sceneFinished(scene) && images.length < scene.requestedImages ? ` · ${t('图片 {done}/{total} 张成功', { done: images.length, total: scene.requestedImages })}` : '';
};
function paint() {
  const scene = selectedScene();
  const history = [...scenes.values()].filter(s => s.chatId === currentChat).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (host?.isConnected) {
    host.hidden = !scene; host.classList.add('is-collapsed');
    const header = ui`<strong>NEURAL / 任务空间</strong><span class="execution-status" role="status" aria-live="polite">${escapeHtml(headerStatus(scene))}</span>
    ${history.length > 1 ? ui`<select aria-label="选择历史任务" data-execution-history>${history.map(s => ui`<option value="${escapeHtml(s.runId)}" ${s.runId === currentRun ? 'selected' : ''}>${escapeHtml(s.query.slice(0, 24) || t("任务"))}</option>`).join('')}</select>` : ''}
    ${historyCursors.get(currentChat) ? ui`<button data-execution-action="older-scenes">更早的任务</button>` : ''}
    <button class="execution-voice" data-action="toggle-tts-autoplay" title="朗读设置">朗读设置</button>
    <button data-execution-action="toggle" aria-expanded="${opened}">${opened ? t("回到对话") : t("进入作战大屏")} ↗</button>`;
    const element = host.querySelector('.execution-panel-header'); if (element && element.dataset.html !== header) { element.innerHTML = header; element.dataset.html = header; }
    updateButtons(); paintTiming(); applyButtonStyles(host);
  }
  warRoom?.render(scene, { leadName, still: uiStill, older: !!historyCursors.get(currentChat),
    history: history.map(s => ({ runId: s.runId, label: s.query.slice(0, 24) || t('任务') })),
    note: (selectionError || scene?.persistenceError || scene?.observationNote || renderNote || (sceneFinished(scene) ? t('执行已停止 · 回看记录') : scene ? t('只展示已记录的执行 · 不代表模型内部思维') : t('准备就绪 · 尚未搜索、计算或调用工具'))) + imageDeficit(scene) });
}
// The newest unfinished run of a chat, for the live steps shown inside the chat.
export function liveSceneFor(chatId) {
  let latest = null;
  for (const scene of scenes.values()) if (scene.chatId === chatId && !sceneFinished(scene)) latest = scene;
  return latest;
}
// Bug audit U4: a client-side Stop gets no further scene events, so the run
// would stay `running` here (and feed the next turn's live steps). Finish it
// locally as cancelled, then re-read the chat's scenes once the server has
// written its own cancelled scene and the [工具轨迹] message.
export function cancelLiveScene(runId, { chatId = null, delays = [800, 2500] } = {}) {
  const scene = runId ? scenes.get(runId) : null;
  if (scene && !sceneFinished(scene)) {
    receiveExecutionScene(finishExecutionScene(structuredClone(scene), { status: 'cancelled' }));
    // No reply message to hand results to; drop the handoff the receive queued.
    if (pendingHandoff && !pendingHandoff.messageId) pendingHandoff = null;
  }
  const target = scene?.chatId || chatId;
  if (!target) return;
  for (const delay of delays) setTimeout(() => { void loadScenes(target); }, delay);
}
export function receiveExecutionScene(scene) {
  if (!scene?.runId || scene.version !== 1) return;
  const previous = scenes.get(scene.runId);
  if (previous && previous.sequence > scene.sequence) return;
  scene = projectPhoneToolStages(scene);
  scenes.set(scene.runId, scene);
  if (scene.chatId !== currentChat) return;
  if (!sceneFinished(scene) && autoRun !== scene.runId) { autoRun = scene.runId; chooseRun(scene.runId); cancelCollapse(); }
  if (!hostManaged && scene.runId === currentRun && !reconcilePrompts(scene) && !promptShowing()
    && shouldAutoOpen(scene, { opened, dismissed: dismissed.has(scene.runId), autoOpened: autoOpened.has(scene.runId) })) { autoOpened.add(scene.runId); touched = false; setOpen(true); }
  if (previous && !sceneFinished(previous) && sceneFinished(scene) && currentRun === scene.runId) {
    pendingHandoff = scene;
    scheduleCollapse(scene.runId);
  }
  paint();
}
async function loadScenes(chatId, { runId, before } = {}) {
  if (!chatId) return;
  try {
    const params = new URLSearchParams({ chatId, ...(runId ? { runId } : {}), ...(before ? { before } : {}) });
    const response = await fetch(`/api/chat/scenes?${params}`);
    if (!response.ok) return;
    const payload = await response.json();
    if (!runId) historyCursors.set(chatId, payload.nextCursor || null);
    for (const scene of payload.scenes || []) receiveExecutionScene(scene);
    if (chatId !== currentChat) return;
    if (!currentRun) {
      const latest = [...scenes.values()].filter(s => s.chatId === chatId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (latest) chooseRun(latest.runId);
    }
    paint(); refreshChat();
  } catch {}
}
export function syncExecutionPanel({ chat, still = false, autoCollapse: shouldAutoCollapse = true, onImageRetry = null, onSelectionChanged = () => {}, leadName: lead = '', hostManaged: managed = false } = {}) {
  autoCollapse = shouldAutoCollapse; imageRetryHandler = onImageRetry; leadName = String(lead || '').slice(0, 40); hostManaged = !!managed;
  if (!autoCollapse) cancelCollapse();
  refreshChat = onSelectionChanged; uiStill = still;
  const next = document.querySelector('#execution-panel');
  if (next !== host) {
    host = next;
    if (host) host.innerHTML = ui`<header class="execution-panel-header"></header><div class="execution-timing-host"></div>`;
  }
  if (currentChat !== (chat?.id || null)) {
    cancelCollapse(); selectionError = ''; rememberView(); currentChat = chat?.id || null; currentRun = null; focus = null; more = false; autoRun = null; loadedChat = null;
    if (opened) setOpen(false);
  }
  if (host && loadedChat !== currentChat) { loadedChat = currentChat; void loadScenes(currentChat); }
  observeRenderedMessages(chat);
  ensureWarRoom(); watchPrompts(); paint();
  if (pendingHandoff && !opened && chat?.messages.some(m => m.id === pendingHandoff.messageId)) {
    handoff(pendingHandoff); pendingHandoff = null;
  }
}
function handoff(scene, imageOnly = false) {
  // Hand-off flies from the chat's task-space strip, so only once the war room is closed.
  if (opened || !host || !scene.messageId || (!imageOnly && delivered.has(scene.runId))) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  delivered.add(scene.runId);
  const message = [...document.querySelectorAll('.message[data-message-id]')].find(el => el.dataset.messageId === scene.messageId);
  if (!message) return;
  const links = [...message.querySelectorAll('a[href], [data-external-url]')];
  const deliveries = imageOnly ? [] : scene.sources.filter(s => s.cited).slice(0, 4).map(source => ({ module: 'search', nodeId: source.id, label: source.title, target: links.find(a => sceneSourceUrl(a.dataset.externalUrl || a.href) === sceneSourceUrl(source.url)) }));
  const calculation = scene.operations.find(op => op.module === 'compute' && op.status === 'completed');
  if (!imageOnly && calculation) deliveries.push({ module: 'compute', label: calculation.result || calculation.output, target: message.querySelector('.message-bubble') });
  if (scene.selectedImageIds.length) deliveries.push({ module: 'create', label: '已选图片', target: message.querySelector('.message-image') });
  if (!imageOnly) for (const artifact of scene.artifacts.filter(a => a.kind === 'file')) deliveries.push({ module: 'create', label: artifact.title, target: links.find(a => [artifact.url, artifact.originalUrl].includes(a.dataset.externalUrl || a.href)) });
  for (const item of deliveries) {
    if (!item.target) continue;
    const target = item.target.getBoundingClientRect(), stage = host.getBoundingClientRect();
    if (target.bottom < 0 || target.top > innerHeight || !stage.height) continue;
    const x = stage.x + Math.min(160, stage.width / 2), y = stage.y + stage.height / 2;
    const node = document.createElement('span'); node.className = 'execution-handoff'; node.textContent = String(item.label).slice(0, 32);
    node.style.left = `${x}px`; node.style.top = `${y}px`; document.body.append(node);
    const dx = target.x + Math.min(80, target.width / 2) - x, dy = target.y - y;
    node.animate([{ transform: 'translate3d(0,0,0) scale(.72)', opacity: 0 }, { transform: `translate3d(${dx * .18}px,${dy * .15 - 24}px,0) scale(1.16)`, opacity: .95, offset: .3 }, { transform: `translate3d(${dx}px,${dy}px,0) scale(.65)`, opacity: 0 }], { duration: 850, easing: 'cubic-bezier(.22,.68,.2,1)' }).finished.finally(() => node.remove());
  }
}
export function selectedMessagePresentation(message) {
  if (message?.role !== 'assistant') return message;
  const scene = scenes.get(message?.metadata?.runId);
  const images = scene?.artifacts.filter(a => a.kind === 'image') || [];
  if (!images.length || !sceneFinished(scene)) return message;
  const generatedUrls = new Set(images.flatMap(a => [a.url, a.originalUrl].filter(Boolean)));
  const selected = scene.selectedImageIds.map(id => images.find(a => a.id === id)).filter(Boolean);
  const clean = text => String(text || '').replace(/!\[[^\]]*\]\((https?:\/\/[^\s]+?)\)/g, (all, url) => generatedUrls.has(url) ? '' : all);
  return { ...message, content: clean(message.content), blocks: (message.blocks || []).map(b => ({ ...b, text: clean(b.text) })),
    attachments: [...(message.attachments || []).filter(a => !generatedUrls.has(a.url)), ...selected.map(a => ({ id: a.id, kind: 'image', title: a.title, url: a.url }))] };
}
document.addEventListener('click', async event => {
  const trigger = event.target.closest('[data-execution-action]'); if (!trigger) return;
  const action = trigger.dataset.executionAction;
  if (sceneFinished(selectedScene())) cancelCollapse();
  // A prompt waiting for the user's answer comes first: the button takes them to it.
  if (action === 'toggle' && !opened && promptShowing()) { [...document.querySelectorAll('[data-request-id]')].find(el => !el.closest('#execution-war-room'))?.focus(); return; }
  if (action === 'toggle') { cancelCollapse(); setOpen(!opened, { focus: true }); }
  else if (action === 'focus') { if (!opened) setOpen(true, { focus: true }); warRoom?.showRegion(trigger.dataset.module); }
  else if (action === 'more') { more = !more; rememberView(); paint(); }
  else if (action === 'older-scenes') { await loadScenes(currentChat, { before: historyCursors.get(currentChat) }); }
  else if (action === 'replay') {
    cancelCollapse();
    await loadScenes(currentChat, { runId: trigger.dataset.run });
    chooseRun(trigger.dataset.run); setOpen(true, { focus: true });
    if (!selectedScene()) { renderNote = t('这条旧任务未保存执行场景，不会重新执行。'); paint(); }
  } else if (action === 'inspect') { if (!opened) setOpen(true, { focus: true }); warRoom?.showRecord(trigger.dataset.operation); }
  else if (action === 'close-inspector') warRoom?.back();
  else if (action === 'retry-images') {
    const scene=selectedScene(), count=Math.max(0,(scene?.imageTask?.count || 0)-(scene?.artifacts || []).filter(a=>a.kind==='image').length);
    if (sceneFinished(scene) && count) imageRetryHandler?.({chatId:scene.chatId,query:scene.query,task:{...scene.imageTask,count,retryOf:scene.runId}});
  } else if (action === 'select-image' && !selectionBusy) {
    const scene = selectedScene(); if (!scene) return;
    selectionError = ''; selectionBusy = true; paint();
    try {
      const response = await fetch('/api/chat/scenes/select-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: scene.chatId, runId: scene.runId, artifactId: trigger.dataset.artifact, slot }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '选择失败');
      receiveExecutionScene(payload.scene); refreshChat(); handoff(payload.scene, true);
    } catch (error) { selectionError = error.message; }
    finally { selectionBusy = false; paint(); }
  }
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-execution-history]')) { cancelCollapse(); chooseRun(event.target.value); setOpen(true, { focus: true }); }
  if (event.target.matches('[data-execution-slot]')) { slot = Number(event.target.value); rememberView(); paint(); }
});
document.addEventListener('visibilitychange', () => { document.documentElement.dataset.executionHidden = String(document.hidden); paintTiming(); });
setInterval(() => {
  if (!document.hidden && host?.isConnected && currentChat && Date.now() - lastPoll > 3500 && [...scenes.values()].some(s => s.chatId === currentChat && !sceneFinished(s))) { lastPoll = Date.now(); void loadScenes(currentChat); }
}, 4000);

// Refresh only text/progress, preserving images, reading position and WebGL.
setInterval(() => { if (!document.hidden && host?.isConnected) paintTiming(true); }, 1000);
