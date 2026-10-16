import { t, ui, currentLanguage } from './i18n.js';
import { renderExecutionDetail, executionApiLine, renderExecutionSignal, renderReasoningRecords, renderExecutionTiming } from './executionDetails.js';
import { EXECUTION_MODULES, moduleActivity, sceneFinished, visibleSceneSources, sourceReadingLabel, sceneSourceUrl } from '/shared/executionScene.js';

import { bindExecutionZoom, clampZoom, wideViewport, DETAIL_ZOOM, MIN_ZOOM, MAX_ZOOM } from './executionViewport.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusNames = { get idle() { return t('无调用记录'); }, get recorded() { return t('仅引用记录'); }, get queued() { return t('排队'); }, get running() { return t('执行中'); }, get waiting() { return t('等待许可'); }, get completed() { return t('已完成'); }, get failed() { return t('失败'); }, get cancelled() { return t('已取消'); }, get interrupted() { return t('已中断'); } };
const scenes = new Map(), views = new Map(), delivered = new Set();
const presentations = new Map();
const historyCursors = new Map();
const attemptedVisibleScenes = new Set(), observedMessages = new WeakMap();
let replayObserver;
let host, gpu, loading = false, currentChat = null, currentRun = null, opened = false, focus = null, more = false;
let autoRun = null, collapseTimer, pendingHandoff = null, loadedChat = null, lastPoll = 0, refreshChat = () => {}, uiStill = false;
let zoom = 1, releaseZoom = null, zoomSaveTimer, layoutObserver;
let selectionBusy = false, selectionError = '', lastSignature = '', slot = 0, closingRun = null;
let autoCollapse = true, imageRetryHandler = null;
function scheduleCollapse(runId) {
  if (!autoCollapse) return;
  clearTimeout(collapseTimer); closingRun = runId;
  collapseTimer = setTimeout(() => {
    if (closingRun !== runId || currentRun !== runId || !sceneFinished(selectedScene())) return;
    if (host?.matches(':focus-within,:hover')) { scheduleCollapse(runId); return; }
    closingRun = null; setOpen(false);
  }, 2600);
}
function cancelCollapse() { clearTimeout(collapseTimer); closingRun = null; }

export const renderExecutionPanel = () => ui`<section id="execution-panel" class="execution-panel is-collapsed" data-neural-key="execution-panel" data-execution-owned="true" aria-label="三维任务空间" hidden></section>`;
export function renderSceneReplay(message) {
  const id = message.role === 'assistant' && message.metadata?.runId;
  return id ? ui`<button type="button" class="message-scene-replay" data-execution-action="replay" data-run="${escape(id)}">◌ 回看任务空间</button><div data-execution-timing-run="${escape(id)}">${renderExecutionTiming(scenes.get(id))}</div>` : '';
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
    const presentation = saved?.messageId === message.id ? saved : { id: 'reply:render', module: 'create', name: '本机聊天渲染', status: 'completed',
      messageId: message.id, output: '回答已渲染到当前设备的聊天界面；不代表用户已阅读', finishedAt: new Date().toISOString() };
    presentations.set(runId, presentation);
    try { localStorage.setItem(`melo-scene-presented:${runId}`, JSON.stringify(presentation)); } catch {}
  }
}
function rememberView() {
  if (!currentRun) return;
  const view = { focus, more, slot, zoom };
  views.set(currentRun, view);
  try { localStorage.setItem(`melo-scene-view:${currentRun}`, JSON.stringify(view)); } catch {}
}
function chooseRun(runId) {
  rememberView(); currentRun = runId; inspectedOperation = "";
  if (host) host.querySelector('.execution-inspector').hidden = true;
  let view = views.get(runId);
  if (!view) try { view = JSON.parse(localStorage.getItem(`melo-scene-view:${runId}`) || 'null'); } catch {}
  focus = EXECUTION_MODULES.some(m => m.id === view?.focus) ? view.focus : null;
  more = !!view?.more; slot = view?.slot || 0; zoom = clampZoom(view?.zoom ?? (focus ? DETAIL_ZOOM : 1));
}
function syncZoomControls() {
  const stage = host?.querySelector('.execution-panel-stage'); if (!stage) return;
  stage.dataset.wide = String(wideViewport(zoom));
  stage.dataset.zoom = zoom.toFixed(3);
  const value = host.querySelector('[data-zoom-value]'); if (value) value.textContent = `${Math.round(zoom * 100)}%`;
  const out = host.querySelector('[data-execution-action=zoom-out]'), inside = host.querySelector('[data-execution-action=zoom-in]');
  if (out) out.disabled = zoom <= MIN_ZOOM; if (inside) inside.disabled = zoom >= MAX_ZOOM;
}
function changeZoom(value) {
  cancelCollapse(); zoom = clampZoom(value); syncZoomControls(); sizeDetails(); gpu?.setZoom(zoom);
  clearTimeout(zoomSaveTimer); zoomSaveTimer = setTimeout(rememberView, 180);
}
function showOverview() {
  cancelCollapse(); focus = null; zoom = 1; rememberView(); paint();
}
function focusModule(id) {
  if (!EXECUTION_MODULES.some(module => module.id === id)) return;
  cancelCollapse(); focus = id; zoom = DETAIL_ZOOM; rememberView(); paint();
}
function hoverModule(id) {
  host?.querySelectorAll('.execution-module').forEach(label => {
    label.dataset.hovered = String(label.dataset.module === id);
  });
}
function preserveReading(action) {
  const scroller = document.querySelector('.thread-scroll-region');
  const top = scroller?.scrollTop || 0;
  const bottom = scroller && scroller.scrollHeight - scroller.clientHeight - top < 24;
  action();
  if (scroller) scroller.scrollTop = bottom ? scroller.scrollHeight : top;
}
function setOpen(value) {
  opened = value;
  preserveReading(() => host?.classList.toggle('is-collapsed', !opened));
  updateButtons(); gpu?.setOpen(opened); paint();
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
  if (sceneFinished(scene)) return `${statusNames[scene.status]} · 回看记录，未在执行`;
  const running = scene.operations.filter(op => op.status === 'running');
  if (running.length > 1) return `${running.length} 项真实调用并行执行`;
  if (running.length === 1) return `${EXECUTION_MODULES.find(m => m.id === running[0].module)?.name} · 执行中`;
  if (scene.operations.some(op => op.status === 'waiting')) return t("等待许可 · 尚未执行");
  const stage = (scene.pipeline || []).filter(item => item.status === 'running').at(-1);
  if (stage) return `${stage.name} · ${stage.channel === 'reasoning-summary' ? t("公开摘要更新中") : stage.output || t("执行中")}`;
  return scene.operations.length ? t("调用已返回 · 等待回答") : t("请求处理中 · 等待可观测工具事件");
}
function detailsFor(scene) {
  if (focus === 'search') return visibleSceneSources(scene, more);
  if (focus === 'create') return [];
  if (focus === 'compute') return moduleActivity(scene, focus).operations.filter(op => op.channel !== 'reasoning-summary').map(op => ({ ...op, title: op.expression || op.name }));
  return moduleActivity(scene, focus).operations.map(op => ({ ...op, title: op.expression || op.name }));
}
function sizeDetails() {
  const stage = host?.querySelector('.execution-panel-stage');
  if (!stage) return;
  const items = wideViewport(zoom) ? [] : detailsFor(selectedScene());
  const columns = Math.max(2, Math.min(5, Math.floor((stage.clientWidth - 24) / 140)));
  const height = items.length ? `${Math.ceil(items.length / columns) * (focus === 'search' ? 112 : 86) + (focus === 'search' ? 140 : 90)}px` : '0px';
  if (stage.style.getPropertyValue('--detail-height') !== height) stage.style.setProperty('--detail-height', height);
}
function renderDetails(scene, items) {
  if (focus === 'search') return items.map((source, index) => {
    const linkUrl = source.citationUrl || source.url;
    const sourceUrl = new URL(linkUrl);
    const title = source.titleProvided ? source.title : source.citationLabel || (sourceUrl.pathname === '/' ? sourceUrl.hostname : sourceUrl.pathname.split('/').filter(Boolean).slice(-2).join('/'));
    const reading = sourceReadingLabel(source), citation = source.cited ? '已被最终引用' : '未被最终引用';
    return ui`<a class="execution-label execution-source" data-node-id="${escape(source.id)}" data-priority="${index < 5 ? 'primary' : 'secondary'}" data-cited="${source.cited}" href="${escape(linkUrl)}" data-external-url="${escape(linkUrl)}" target="_blank" rel="noopener noreferrer" title="${escape(`${source.titleProvided ? source.title : '页面标题未提供'}\n${linkUrl}\n${reading}\n${citation}\n服务：${source.providers.join('、') || '未报告'}${source.recovered ? '\n从截断记录与最终引用恢复；正文范围未知' : ''}`)}"><span class="execution-source-rank">${String(index + 1).padStart(2, '0')} · ${source.cited ? '回答引用' : index < 5 ? '相关来源' : '更多候选'}</span><strong>${escape(title)}</strong><small>${escape(new URL(source.url).hostname)}</small><small>${escape(reading)}</small><small>${source.cited ? '✦ 已引用' : '未引用 · 点击检查'}</small></a>`;
  }).join('');
  return items.map(op => ui`<button class="execution-label execution-source execution-operation" data-node-id="${escape(op.id)}" data-execution-action="inspect" data-operation="${escape(op.id)}" title="${escape(`${op.input || ''}\n${op.output || ''}`)}"><strong>${escape(op.result ?? op.expression ?? op.name)}</strong><small>${escape(op.channel === 'reasoning-summary' ? (op.output || '').slice(-100) : focus === 'tools' ? `归属：${EXECUTION_MODULES.find(m => m.id === op.module)?.name || t("工具调用")} · ${op.provider || op.name}` : op.expression || op.input || op.name)}</small><small>${escape(statusNames[op.status])}</small></button>`).join('');
}
function renderSearchTrail(scene) {
  if (focus !== 'search') return '';
  const ops = (scene?.operations || []).filter(op => op.module === 'search');
  return ui`<div class="execution-search-trail" aria-label="真实检索调用">${ops.map(op => ui`<button data-execution-action="inspect" data-operation="${escape(op.id)}" title="${escape(`${op.input || ''}\n${op.resultSummary || op.status}`)}"><b>${escape(op.provider || op.name)}</b> · ${escape(op.resultSummary || statusNames[op.status])}</button>`).join('')}</div>`;
}
function renderCandidates(scene) {
  if (focus !== 'create') return '';
  const artifacts = scene?.artifacts || [];
  const stages = moduleActivity(scene, 'create').operations;
  const delivery = ui`<div class="execution-pipeline" aria-label="模型与交付记录">${stages.map(stage => ui`<button data-execution-action="inspect" data-operation="${escape(stage.id)}" data-stage-status="${escape(stage.status)}"><strong>${escape(stage.name)}</strong><span>${escape(statusNames[stage.status] || stage.status)}</span><small>${escape(stage.output || stage.input || t("等待返回"))}</small>${stage.api ? ui`<small class="execution-api-line">${escape(executionApiLine(stage))}</small>` : ''}</button>`).join('')}</div>`;
  const previews = (scene?.previews || []).filter(p => !artifacts.some(a=>a.operationId===p.operationId));
  const previewCards = previews.map(p => ui`<article class="execution-candidate execution-preview"><img src="${escape(p.url)}" alt="服务返回的生成预览"><p>${sceneFinished(scene)?'生成未完成的预览':'生成中的预览'} · 非最终成果</p></article>`).join('');
  const missing = Math.max(0,(scene?.imageTask?.count || 0)-artifacts.filter(a=>a.kind==='image').length);
  const retry = imageRetryHandler && sceneFinished(scene) && missing ? ui`<button class="execution-image-retry" data-execution-action="retry-images">重试缺少的 ${missing} 张 · 发起新请求</button>` : '';
  if (!artifacts.length) return stages.length || previews.length ? ui`<div class="execution-outcomes">${delivery}<div class="execution-candidates">${previewCards}</div>${retry}</div>` : ui`<div class="execution-empty"><strong>暂无模型与交付记录</strong>旧任务未记录的接收、整理与保存过程不会补造</div>`;
  const images = artifacts.filter(a => a.kind === 'image'), selected = scene.selectedImageIds || [];
  return ui`<div class="execution-outcomes"><details class="execution-delivery-details"><summary>查看 ${stages.length} 条执行记录</summary>${delivery}</details>${retry}<div class="execution-candidates">${previewCards}${artifacts.map(artifact => ui`<article class="execution-candidate" data-selected="${selected.includes(artifact.id)}">
    <a href="${escape(artifact.url)}" data-external-url="${escape(artifact.url)}" target="_blank" rel="noopener noreferrer">${artifact.kind === 'image' ? ui`<img src="${escape(artifact.url)}" alt="${escape(artifact.title)}" loading="lazy">` : escape(artifact.title)}</a>
    <p>${escape(artifact.title)} ${selected.includes(artifact.id) ? `· 展示第 ${selected.indexOf(artifact.id) + 1} 张` : '· 可检查候选'}</p>
    ${artifact.requestedModel ? ui`<small>${escape(artifact.engine)} · 请求 ${escape(artifact.requestedModel)} · 返回 ${escape(artifact.reportedModel || t("服务未报告"))}</small>` : ''}
    ${artifact.requestedQuality ? ui`<small aria-label="查看图片质量">质量：请求 ${escape(artifact.requestedQuality)} · 返回 ${escape(artifact.reportedQuality || t("服务未报告"))}</small>` : ''}
    ${artifact.beforeUrl ? ui`<details class="execution-comparison"><summary>查看修改前后</summary><div><figure><img src="${escape(artifact.beforeUrl)}" alt="修改前" loading="lazy"><figcaption>修改前</figcaption></figure><figure><img src="${escape(artifact.url)}" alt="修改后" loading="lazy"><figcaption>修改后</figcaption></figure></div></details>` : ''}
    ${artifact.kind === 'image' && sceneFinished(scene) ? ui`<div class="execution-candidate-controls"><select aria-label="替换图片位置" data-execution-slot>${Array.from({ length: Math.min(scene.requestedImages, images.length) }, (_, i) => ui`<option value="${i}" ${i === slot ? 'selected' : ''}>第 ${i + 1} 张</option>`).join('')}</select><button data-execution-action="select-image" data-artifact="${escape(artifact.id)}" ${selectionBusy ? 'disabled' : ''}>${selected.includes(artifact.id) ? t("已选中") : t("选为展示")}</button></div>` : ''}
  </article>`).join('')}</div></div>`;
}
let inspectedOperation = '';
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
function paint() {
  if (!host?.isConnected) return;
  const scene = selectedScene(), items = detailsFor(scene);
  if (inspectedOperation) {
    const op = [...(scene?.operations || []), ...(scene?.pipeline || [])].find(item => item.id === inspectedOperation);
    if (op) {
      const inspector = host.querySelector('.execution-inspector'), html = renderExecutionDetail(op, statusNames[op.status]);
      if (inspector.innerHTML !== html) { const top = inspector.scrollTop; inspector.innerHTML = html; inspector.scrollTop = top; }
    }
  }
  const searchOps = (scene?.operations || []).filter(op => op.module === 'search');
  host.hidden = !opened && !scene;
  host.classList.toggle('is-collapsed', !opened);
  const history = [...scenes.values()].filter(s => s.chatId === currentChat).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  host.querySelector('.execution-panel-header').innerHTML = ui`<strong>NEURAL / 任务空间</strong><span class="execution-status" role="status">${escape(headerStatus(scene))}</span>
    ${history.length > 1 ? ui`<select aria-label="选择历史任务" data-execution-history>${history.map(s => ui`<option value="${escape(s.runId)}" ${s.runId === currentRun ? 'selected' : ''}>${escape(s.query.slice(0, 24) || t("任务"))}</option>`).join('')}</select>` : ''}
    ${historyCursors.get(currentChat) ? ui`<button data-execution-action="older-scenes">更早的任务</button>` : ''}
    <button class="execution-voice" data-action="toggle-tts-autoplay" title="朗读设置">朗读设置</button>
    <button data-execution-action="toggle" aria-expanded="${opened}">${opened ? t("收起") : t("展开回看")} ↗</button>`;
  const stage = host.querySelector('.execution-panel-stage'); stage.dataset.focus = focus || '';
  sizeDetails();
  const signature = JSON.stringify([currentLanguage(), scene?.runId, scene?.sequence, scene?.pipeline, scene?.selectionChangedAt, scene?.artifacts.map(a => a.url), focus, more, slot, selectionBusy, zoom]);
  if (signature !== lastSignature) {
    lastSignature = signature;
    host.querySelector('.execution-labels').innerHTML = EXECUTION_MODULES.map(module => {
      const activity = moduleActivity(scene, module.id);
      return ui`<button class="execution-label execution-module" data-node-id="${module.id}" data-execution-action="focus" data-module="${module.id}" data-status="${activity.status}" style="--module-color:${module.color}" aria-label="进入${escape(t(module.name))}" title="${module.id === 'search' ? '搜索和网页读取都归入网页检索' : module.id === 'compute' ? '显示模型公开摘要与实际计算；两者独立标记' : module.id === 'files' ? '显示文件读写、代码修改片段和实际结果' : module.id === 'create' ? '显示模型请求、接收、整理、保存、渲染及实际成果' : '汇总所有真实工具调用；搜索、计算、文件操作也在这里，每次仅计一次'} · ${activity.operations.length} ${['create', 'compute'].includes(module.id) ? '条执行记录' : '次工具调用'}"><i></i><strong>${escape(t(module.name))}</strong><small>${escape(statusNames[activity.status])}${module.id === 'search' && scene?.sources.length ? ` · ${scene.sources.length} 条来源 ↗` : module.id === 'tools' ? ` · ${activity.operations.length} 次工具调用` : module.id === 'create' ? ` · ${activity.operations.length} 条记录` : activity.running.length > 1 ? ` ×${activity.running.length}` : ''}</small></button>`;
    }).join('') + renderDetails(scene, items);
    host.querySelector('.execution-focus-tools').innerHTML = focus ? ui`<button data-execution-action="overview">← 整体视角</button><span title="按问题、实际搜索词与标题、网址、摘要的匹配及搜索排名排序；引用只作标记，不占用保留名额。相关性是启发式分数，不是概率">${escape(t(EXECUTION_MODULES.find(m => m.id === focus)?.name))}${focus === 'search' ? ` · 展示 ${items.length} / ${scene?.sources.length || 0} 条记录 · 按相关性` : ''}</span>${focus === 'search' && (scene?.sources.length || 0) > 5 ? ui`<button data-execution-action="more">${more ? '收起至五个' : '展开更多 · 最多十个'}</button>` : ''}` : '<span></span>';
    const extra = host.querySelector('.execution-extra'), scrollTop = extra.querySelector('.execution-reasoning-records')?.scrollTop || 0;
    extra.innerHTML = renderSearchTrail(scene) + (focus === 'compute' ? renderReasoningRecords(scene, statusNames) : '') + (renderCandidates(scene) || (!scene || focus && !items.length && !(focus === 'compute' && scene?.pipeline?.some(p => p.channel === 'reasoning-summary')) ? ui`<div class="execution-empty"><strong>${!scene ? '任务发生时，空间随之点亮' : focus === 'search' && searchOps.length ? (moduleActivity(scene, 'search').running.length ? '检索执行中 · 等待来源记录' : '此调用未返回来源清单') : '此区域暂无执行记录'}</strong>${!scene ? '点击区域靠近 · 电子与微光仅为氛围' : '不补造步骤、来源或进度'}</div>` : ''));
    const records = extra.querySelector('.execution-reasoning-records'); if (records) records.scrollTop = scrollTop;
    host.querySelector('.execution-signal-host').innerHTML = wideViewport(zoom) ? renderExecutionSignal(scene) : '';
    host.querySelector('.execution-inspector').hidden = !inspectedOperation;
    gpu?.update(scene, focus, items, zoom);
  }
  const images = scene?.artifacts.filter(a => a.kind === 'image') || [];
  const deficit = scene?.operations.some(op => ['image', 'image_edit', 'native_image_generation'].includes(op.name)) && sceneFinished(scene) && images.length < scene.requestedImages ? ` · 图片 ${images.length}/${scene.requestedImages} 张成功` : '';
  host.querySelector('.execution-panel-footer').innerHTML = ui`<span>${escape(selectionError || scene?.persistenceError || scene?.observationNote || (sceneFinished(scene) ? '执行已停止 · 神经脉冲是低强度氛围动画' : scene ? '只展示已记录的执行 · 不代表模型内部思维' : '准备就绪 · 尚未搜索、计算或调用工具'))}${escape(deficit)}</span><span>${scene?.operations.length || 0} 次工具调用 · ${scene?.pipeline?.length || 0} 条执行记录 · ${scene?.sources.length || 0} 条来源</span>`;
  updateButtons(); syncZoomControls(); paintTiming();
  if (opened && !gpu && !loading) {
    loading = true;
    const currentHost = host;
    import('./executionScene3D.js').then(({ createExecutionScene3D }) => {
      if (host !== currentHost || !host.isConnected) return;
      gpu = createExecutionScene3D(host.querySelector('.execution-webgl'), { onProject: projectLabels, onFailure: fallback, onSelect: focusModule, onHover: hoverModule });
      gpu.update(selectedScene(), focus, detailsFor(selectedScene()), zoom); gpu.setStill(uiStill); gpu.setOpen(opened);
    }).catch(() => fallback('此设备暂不支持三维渲染，可继续检查执行记录。')).finally(() => { loading = false; });
  }
}
function fallback(message) { host?.classList.add('is-fallback'); const el = host?.querySelector('.execution-panel-footer span'); if (el) el.textContent = message; }
function projectLabels(labels, { width, height }) {
  if (!host || !opened) return;
  const elements = new Map([...host.querySelectorAll('[data-node-id]')].map(el => [el.dataset.nodeId, el]));
  for (const position of labels) {
    const el = elements.get(position.id); if (!el) continue;
    const w = el.offsetWidth || 120, h = el.offsetHeight || 45;
    const moduleOffscreen = !position.detail && (position.x < 0 || position.x > width || position.y < 0 || position.y > height);
    const x = Math.min(width - w - 7, Math.max(7, position.x - w / 2));
    const y = Math.min(height - h - 40, Math.max(position.detail ? focus === 'search' ? 88 : 42 : 9, position.y - h / 2));
    el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    el.style.visibility = position.visible && !moduleOffscreen ? 'visible' : 'hidden';
  }
}
export function receiveExecutionScene(scene) {
  if (!scene?.runId || scene.version !== 1) return;
  const previous = scenes.get(scene.runId);
  if (previous && previous.sequence > scene.sequence) return;
  scenes.set(scene.runId, scene);
  if (scene.chatId !== currentChat) return;
  if (!sceneFinished(scene) && autoRun !== scene.runId) {
    autoRun = scene.runId; chooseRun(scene.runId); cancelCollapse(); setOpen(true);
  }
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
export function syncExecutionPanel({ chat, still = false, autoCollapse: shouldAutoCollapse = true, onImageRetry = null, onSelectionChanged = () => {} } = {}) {
  autoCollapse = shouldAutoCollapse; imageRetryHandler = onImageRetry;
  if (!autoCollapse) cancelCollapse();
  refreshChat = onSelectionChanged; uiStill = still;
  const next = document.querySelector('#execution-panel');
  if (next !== host) {
    releaseZoom?.(); releaseZoom = null; layoutObserver?.disconnect(); layoutObserver = null; clearTimeout(zoomSaveTimer); gpu?.dispose(); gpu = null; host = next; lastSignature = '';
    if (host) host.innerHTML = ui`<header class="execution-panel-header"></header><div class="execution-timing-host"></div><div class="execution-panel-viewport" tabindex="0" aria-label="任务空间内容，内容较多时可滚动查看"><div class="execution-panel-stage" tabindex="0" role="group" aria-label="任务空间，滚轮或双指缩放，加减键缩放，零键返回总览"><div class="execution-webgl"></div><div class="execution-labels"></div><div class="execution-focus-tools"></div><div class="execution-extra"></div><aside class="execution-inspector" hidden></aside></div><div class="execution-zoom" aria-label="场景缩放"><span class="execution-zoom-hint">滚轮 / 双指缩放</span><button data-execution-action="zoom-out" aria-label="缩小任务空间" title="缩小，查看其他模块">−</button><output data-zoom-value aria-label="缩放比例">100%</output><button data-execution-action="zoom-in" aria-label="放大任务空间" title="放大">＋</button><button data-execution-action="overview" title="同时查看五个模块">总览</button></div></div><div class="execution-signal-host"></div><footer class="execution-panel-footer"></footer>`;
  }
  if (host && !releaseZoom) {
    const stage = host.querySelector('.execution-panel-stage');
    releaseZoom = bindExecutionZoom(stage, { getZoom: () => zoom, setZoom: changeZoom, overview: showOverview });
    if (typeof ResizeObserver !== 'undefined') {
      layoutObserver = new ResizeObserver(sizeDetails);
      layoutObserver.observe(stage);
    }
  }
  if (currentChat !== (chat?.id || null)) {
    cancelCollapse(); selectionError = ''; rememberView(); currentChat = chat?.id || null; currentRun = null; focus = null; zoom = 1; more = false; opened = false; autoRun = null; loadedChat = null;
  }
  if (host && loadedChat !== currentChat) { loadedChat = currentChat; void loadScenes(currentChat); }
  observeRenderedMessages(chat);
  gpu?.setStill(still); paint();
  if (pendingHandoff && chat?.messages.some(m => m.id === pendingHandoff.messageId)) {
    handoff(pendingHandoff); pendingHandoff = null;
  }
}
function handoff(scene, imageOnly = false) {
  if (!opened || !host || !scene.messageId || (!imageOnly && delivered.has(scene.runId))) return;
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
    const target = item.target.getBoundingClientRect(), stage = host.querySelector('.execution-panel-stage').getBoundingClientRect();
    if (target.bottom < 0 || target.top > innerHeight || !stage.height) continue;
    const source = host.querySelector(`[data-node-id="${item.nodeId || item.module}"]`)?.getBoundingClientRect() || host.querySelector(`[data-node-id="${item.module}"]`)?.getBoundingClientRect();
    const x = source?.x || stage.x + stage.width / 2, y = source?.y || stage.y + stage.height / 2;
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
  if (action === 'toggle') { cancelCollapse(); setOpen(!opened); }
  else if (action === 'focus') focusModule(trigger.dataset.module);
  else if (action === 'overview') showOverview();
  else if (action === 'zoom-in') changeZoom(zoom * 1.18);
  else if (action === 'zoom-out') changeZoom(zoom / 1.18);
  else if (action === 'more') { more = !more; rememberView(); paint(); }
  else if (action === 'older-scenes') { await loadScenes(currentChat, { before: historyCursors.get(currentChat) }); }
  else if (action === 'replay') {
    cancelCollapse();
    await loadScenes(currentChat, { runId: trigger.dataset.run });
    chooseRun(trigger.dataset.run); setOpen(true);
    if (!selectedScene()) { const el = host?.querySelector('.execution-panel-footer span'); if (el) el.textContent = '这条旧任务未保存执行场景，不会重新执行。'; }
  } else if (action === 'inspect') {
    const scene = selectedScene();
    const op = [...(scene?.operations || []), ...(scene?.pipeline || [])].find(item => item.id === trigger.dataset.operation);
    if (op) { inspectedOperation = op.id; const inspector = host.querySelector('.execution-inspector'); inspector.innerHTML = renderExecutionDetail(op, statusNames[op.status]); inspector.hidden = false; }
  } else if (action === 'retry-images') {
    const scene=selectedScene(), count=Math.max(0,(scene?.imageTask?.count || 0)-(scene?.artifacts || []).filter(a=>a.kind==='image').length);
    if (sceneFinished(scene) && count) imageRetryHandler?.({chatId:scene.chatId,query:scene.query,task:{...scene.imageTask,count,retryOf:scene.runId}});
  } else if (action === 'close-inspector') { inspectedOperation = ''; host.querySelector('.execution-inspector').hidden = true; }
  else if (action === 'select-image' && !selectionBusy) {
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
  if (event.target.matches('[data-execution-history]')) { cancelCollapse(); chooseRun(event.target.value); setOpen(true); }
  if (event.target.matches('[data-execution-slot]')) { slot = Number(event.target.value); rememberView(); paint(); }
});
document.addEventListener('visibilitychange', () => { document.documentElement.dataset.executionHidden = String(document.hidden); paintTiming(); });
setInterval(() => {
  if (!document.hidden && host?.isConnected && currentChat && Date.now() - lastPoll > 3500 && [...scenes.values()].some(s => s.chatId === currentChat && !sceneFinished(s))) { lastPoll = Date.now(); void loadScenes(currentChat); }
}, 4000);

// Refresh only text/progress, preserving images, reading position and WebGL.
setInterval(() => { if (!document.hidden && host?.isConnected) paintTiming(true); }, 1000);
