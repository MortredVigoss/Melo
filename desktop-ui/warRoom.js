// War room (layout A, 2026-11-06): the full-screen task space. A fixed
// layer over the whole window (on a phone, the whole task-space screen):
// top bar (what is happening, the phases that happened, views, back to the
// chat), the 3D space, the operations band and a status line. Every number
// here opens the list of records it counts; every record opens its execution
// detail. Calls finished by a spider fly as chips from its claw into their
// row of the log; candidates the lead admits surface from the core and fly
// into their row of the evidence table. Nothing is shown that the scene did
// not record.
import { escapeHtml, t, runtimeCompletionText } from './i18n.js';
import { EXECUTION_MODULES, sceneFinished } from '/shared/executionScene.js';
import { sceneMembers, sceneEvaluation, sceneStageRail, sceneLog, sceneResources, sceneHasBoard, evaluationChanges, MEMBER_ROLE_MODULE } from '/shared/executionBoard.js';
import { regionSummary, deliveryGate, deliveryStatus, fieldCoverage, traceList, operationChip, sceneActors } from '/shared/warRoom.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const roleName = role => ({ research: t('检索成员'), lookup: t('资料读取成员'), calculate: t('计算成员'), execute: t('执行成员'), lead: t('主 Agent') })[role] || t('内部成员');
const verbName = verb => ({ dispatch: t('分派'), handoff: t('交接'), search: t('检索'), read: t('读取'), lookup: t('查询'), compute: t('计算'), write: t('写入'), call: t('调用'),
  approval: t('审批'), evaluate: t('评估'), review: t('核验'), stop: t('停止'), deliver: t('交付') })[verb] || verb;
const phaseName = key => ({ contract: t('合同'), dispatch: t('分派'), approval: t('审批'), evaluate: t('评估'), review: t('核验'), deliver: t('交付') })[key] || key;
const statusText = status => ({ running: t('进行中'), waiting: t('等待'), queued: t('排队'), completed: t('完成'), failed: t('未通过'), cancelled: t('已取消'), interrupted: t('已中断') })[status] || status || '';
// How a run ended, from its completion receipt (see deliveryStatus): the short
// word for the rail and the log, and the gate's state line.
const endName = state => ({ 'delivered-verified': t('交付'), delivered: t('交付'), 'delivered-unverified': t('交付'), partial: t('部分交付'), 'needs-user': t('待补充'),
  budget: t('预算用尽'), blocked: t('未完成'), cancelled: t('已取消'), failed: t('失败'), interrupted: t('中断'), ended: t('结束') })[state] || t('结束');
const deliveryText = (state, nextBatch) => ({ continue: nextBatch ? t('继续检索 · 下一批 {count}', { count: nextBatch }) : t('继续检索'), ready: t('可进入核验'), checking: t('核验中'),
  'check-failed': t('核验未通过 · 继续补证'), 'delivered-verified': t('已核验 · 已交付'), delivered: t('已交付'), 'delivered-unverified': t('已交付 · 未核验'),
  partial: t('部分完成 · 未全部交付'), 'needs-user': t('等待你的补充'), budget: t('预算用尽 · 未完成交付'), blocked: t('未能完成交付'), cancelled: t('任务已取消'),
  failed: t('任务失败'), interrupted: t('任务已中断'), ended: t('已结束 · 没有完成回执') })[state] || '';
const tierName = tier => ({ primary: t('主推'), alternative: t('备选'), eligible: t('合格'), pending: t('待补'), excluded: t('排除') })[tier] || tier;
const fieldName = field => ({ name: t('名称'), startsAt: t('时间'), place: t('地点'), participation: t('参与方式'), model: t('型号'), region: t('地区'), price: t('价格'), currency: t('币种'), availability: t('在售') })[field] || String(field).slice(0, 8);
const regionName = id => t(EXECUTION_MODULES.find(m => m.id === id)?.name || id);
const num = value => new Intl.NumberFormat().format(Number(value) || 0);
const clock = ms => { if (!Number.isFinite(ms)) return '--:--'; const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const tokens = value => value >= 10000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : num(value);
// No response reported usage yet: the count is unknown, not zero.
const tokenCount = res => res.usageRecords ? tokens(res.inputTokens) : '—';
const offset = (scene, at) => { const a = Date.parse(scene?.startedAt), b = Date.parse(at); return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null; };
const dot = (role, module) => `<i class="war-dot" data-role="${escapeHtml(role || 'lead')}" data-module="${escapeHtml(module || MEMBER_ROLE_MODULE[role] || '')}"></i>`;
const trace = (key, inner, label = '') => `<button type="button" class="war-num" data-war-trace="${escapeHtml(key)}"${label ? ` aria-label="${escapeHtml(label)}"` : ''}>${inner}</button>`;
const empty = text => `<p class="war-empty">${escapeHtml(text)}</p>`;
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
// Attribute selectors here are always double-quoted; only quotes and backslashes need escaping.
const attrValue = value => String(value).replace(/["\\]/g, '\\$&');

export function createWarRoom({ onClose, onInteract, onFailure, onRegionChange, recordDetail, regionExtra, traceExtra } = {}) {
  const root = document.createElement('section');
  root.className = 'war-room'; root.id = 'execution-war-room'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', t('作战大屏'));
  root.innerHTML = `<header class="war-top"><div class="war-brand"><b>NEURAL / ${escapeHtml(t('作战大屏'))}</b><span class="war-now" role="status" aria-live="polite"></span></div><ol class="war-rail" aria-label="${escapeHtml(t('已发生的阶段'))}"></ol>
    <div class="war-controls"><span class="war-history"></span><div class="war-views" role="radiogroup" aria-label="${escapeHtml(t('视角'))}">${['global', 'follow', 'free'].map(id => `<button type="button" role="radio" data-war-view="${id}" aria-checked="${id === 'global'}" title="${escapeHtml({ global: t('看到全部模块与星核；缓慢环绕，拖动可接管'), follow: t('镜头跟随正在工作的成员；拖动改变角度，滚轮缩放'), free: t('拖动旋转，方向键每次 15°，滚轮缩放') }[id])}">${escapeHtml({ global: t('全局'), follow: t('跟随'), free: t('自由') }[id])}</button>`).join('')}</div><button type="button" class="war-voice" data-action="toggle-tts-autoplay">${escapeHtml(t('朗读设置'))}</button><button type="button" class="war-close" data-war-close>${escapeHtml(t('回到对话'))}</button></div></header>
    <section class="war-stage" tabindex="0" aria-label="${escapeHtml(t('三维任务空间：拖动旋转，滚轮或双指缩放，方向键旋转，加减键缩放，零键回到全局'))}"><div class="war-gl"></div><div class="war-captions"></div>
      <div class="war-zoom" aria-label="${escapeHtml(t('场景缩放'))}"><button type="button" data-war-zoom="out" aria-label="${escapeHtml(t('缩小'))}">−</button><output class="war-zoom-value">100%</output><button type="button" data-war-zoom="in" aria-label="${escapeHtml(t('放大'))}">＋</button></div>
      <span class="war-hint">${escapeHtml(t('拖动旋转 · 滚轮或双指缩放'))}</span></section>
    <section class="war-band" aria-label="${escapeHtml(t('作战台'))}"></section>
    <footer class="war-status"></footer>`;
  document.body.append(root);
  const $ = selector => root.querySelector(selector);
  const band = $('.war-band'), stage = $('.war-stage'), captionsLayer = $('.war-captions'), hint = $('.war-hint'), zoomBox = $('.war-zoom');
  let scene = null, ctx = {}, opened = false, gpu = null, loading = false, failed = false, detail = null, mode = '', keepDetail = null;
  // Per-render caches the per-frame caption pass reads.
  let summary = new Map(), working = new Set(), gateOpen = false, memberNames = new Map();
  const cells = new Map(), captions = new Map(), chips = [], pending = new Map(), statuses = new Map(), shownSnapshot = new Map();
  // Candidate rises wait on timers; each belongs to one run and one showing of
  // the war room. Switching runs, closing and disposing cancel them all.
  const rises = new Set(); let riseGeneration = 0;
  const cancelRises = () => { for (const id of rises) clearTimeout(id); rises.clear(); riseGeneration++; };
  // Flights run only while the war room animates. The moment it cannot (closed,
  // still, reduced motion, no renderer) every waiting row is shown, chips are
  // removed, and nothing queued flies later.
  function settleFlights() { cancelRises(); for (const chip of [...chips]) dropChip(chip); for (const key of [...pending.keys()]) reveal(key); }
  // Turning on reduced motion mid-flight settles at once, not at the next update.
  try { matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => { if (!animating()) settleFlights(); }); } catch { /* no media queries here */ }

  // ── 3D ────────────────────────────────────────────────────────────────
  function ensureScene() {
    if (gpu || loading || failed || !opened) return;
    loading = true;
    import('./warRoomScene3D.js').then(({ createWarRoomScene }) => {
      if (!root.isConnected) return;
      gpu = createWarRoomScene($('.war-gl'), { onProject: project, onSelectRegion: id => showDetail({ type: 'region', id }),
        // A tap anywhere on the space that hits no region or spider leaves the detail.
        onEmptyTap: () => { if (!detail) return; onInteract?.(); detail = null; gpu?.focusRegion(null); onRegionChange?.(null); render(scene, ctx); },
        onHook: hook, onRelease: release, onInteract: () => { onInteract?.(); syncZoom(); }, onViewChange: syncViews,
        onFailure: () => fail(t('三维渲染已暂停，仍可查看执行记录。')) });
      gpu.setStill(!!ctx.still); gpu.setOpen(opened); gpu.update(scene);
      // A region restored before the renderer existed (first open, a remembered
      // view) is focused now; restore() could not reach the camera then.
      if (detail?.type === 'region') gpu.focusRegion(detail.id);
      syncViews(gpu.view); syncZoom();
    }).catch(() => fail(t('此设备暂不支持三维渲染，可继续检查执行记录。'))).finally(() => { loading = false; });
  }
  // Without a renderer (no WebGL, or its context lost) the stage lists the five
  // regions itself: the same buttons and details the captions open, so sources,
  // summaries and results stay reachable. Flights stop at once.
  let fallbackMessage = '';
  function fail(message) {
    failed = true; fallbackMessage = message; root.classList.add('is-fallback'); settleFlights();
    // The renderer is released (a lost context never draws again) and its labels go with it.
    gpu?.dispose(); gpu = null; for (const el of captions.values()) el.remove(); captions.clear();
    renderFallback(); onFailure?.(message);
  }
  function renderFallback() {
    if (!failed) return;
    const html = `<div class="war-fallback"><p>${escapeHtml(fallbackMessage)}</p><ul class="war-regions" aria-label="${escapeHtml(t('五个区域'))}">${regionRows(regionSummary(scene))}</ul></div>`;
    const host = $('.war-gl'); if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
  }
  function syncViews(view = gpu?.view) {
    if (!view) return;
    for (const button of root.querySelectorAll('[data-war-view]')) button.setAttribute('aria-checked', String(!view.region && button.dataset.warView === view.mode));
    stage.dataset.view = view.region ? `region:${view.region}` : view.mode;
  }
  function syncZoom() { const value = $('.war-zoom-value'); if (value && gpu) value.textContent = `${Math.round(gpu.view.zoom * 100)}%`; }

  // ── Captions: regions, core and spiders, placed nearest first; one that
  // would cover another, a spider or a chip moves to the nearest free slot.
  function caption(id, className) {
    let el = captions.get(id);
    if (!el) { el = document.createElement('button'); el.type = 'button'; el.className = `war-caption ${className}`; captionsLayer.append(el); captions.set(id, el); }
    return el;
  }
  // How far a region's label sits from its centre along (dx, dy): the edge of
  // the ellipse its projected outline spans on that side, else the nominal radius.
  function reach(r, dx, dy) {
    if (!r.rect) return r.radius * .92;
    const ax = Math.max(1, dx >= 0 ? r.rect.x1 - r.x : r.x - r.rect.x0), ay = Math.max(1, dy >= 0 ? r.rect.y1 - r.y : r.y - r.rect.y0);
    return .92 / Math.hypot(dx / ax, dy / ay);
  }
  function project(labels, { width, height }) {
    const sr = stage.getBoundingClientRect(), placed = [hint, zoomBox].map(el => { const r = el.getBoundingClientRect(); return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height }; });
    for (const a of labels.actors) placed.push({ x: a.body.x - a.radius, y: a.body.y - a.radius * .8, w: 2 * a.radius, h: 1.6 * a.radius, owner: a.id });
    for (const chip of chips) if (chip.mode === 'hook' || chip.mode === 'lift') placed.push({ x: chip.x - sr.left, y: chip.y - sr.top, w: chip.w * chip.s, h: chip.h * chip.s, owner: chip.actorId });
    const center = labels.core.center;
    const items = [
      ...labels.regions.map(r => {
        const row = summary.get(r.id), busy = working.has(r.id);
        let dx = r.x - center.x, dy = r.y - center.y; const len = Math.hypot(dx, dy); if (len < 1) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
        const count = r.id === 'search' && row?.sources ? t('{calls} 次调用 · {sources} 条来源', { calls: row.calls, sources: row.sources }) : row?.calls ? t('{count} 次调用', { count: row.calls }) : row?.records ? t('{count} 条记录', { count: row.records }) : t('待命');
        return { id: r.id, cls: 'is-region', attrs: { 'data-war-region': r.id }, p: r, out: { dx, dy, r: reach(r, dx, dy) }, html: `<strong>${escapeHtml(regionName(r.id))}</strong><small>${escapeHtml(busy ? t('工作中') + ' · ' + count : count)}</small>`, active: busy, far: r.far, width, height };
      }),
      { id: 'core', cls: 'is-core', attrs: { 'data-war-trace': 'calls' }, p: labels.core, html: `<strong>${escapeHtml(ctx.leadName ? t('{name} · 主 Agent', { name: ctx.leadName }) : t('主 Agent'))}</strong><small>${escapeHtml(t('路由与评估'))}${gateOpen ? ' · ' + escapeHtml(t('闸门已开')) : ''}</small>` },
      ...labels.actors.filter(a => !a.holding).map(a => ({ id: a.id, cls: 'is-actor', attrs: { 'data-war-follow': a.id }, p: a, html: `<strong>${escapeHtml(actorLabel(a.id))}</strong>`, owner: a.id })),
    ].sort((a, b) => a.p.depth - b.p.depth);
    const seen = new Set();
    for (const item of items) {
      const el = caption(item.id, item.cls); seen.add(item.id);
      if (el.dataset.html !== item.html) { el.innerHTML = item.html; el.dataset.html = item.html; }
      for (const [key, value] of Object.entries(item.attrs)) if (el.getAttribute(key) !== value) el.setAttribute(key, value);
      el.dataset.active = String(!!item.active); el.dataset.far = String(!!item.far);
      const w = el.offsetWidth, h = el.offsetHeight; let cx = item.p.x, cy = item.p.y;
      if (item.out) { const { dx, dy, r } = item.out, d = r + Math.abs(dx) * w / 2 + Math.abs(dy) * h / 2 + 6; cx += dx * d; cy += dy * d; }
      let x = cx - w / 2, y = cy - h / 2;
      if (item.out) { x = Math.min(Math.max(x, 8), width - w - 8); y = Math.min(Math.max(y, 8), height - h - 8); }
      el.dataset.pinned = String(!!item.out && Math.hypot(x - (cx - w / 2), y - (cy - h / 2)) > 2);
      for (const step of [0, 1, -1, 2, -2]) { const ty = y + step * (h + 4); if (item.out && (ty < 4 || ty > height - h - 4)) continue; if (!placed.some(o => o.owner !== item.owner && x < o.x + o.w + 6 && o.x < x + w + 6 && ty < o.y + o.h + 3 && o.y < ty + h + 3)) { y = ty; break; } }
      placed.push({ x, y, w, h }); el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`; el.style.visibility = item.p.visible ? 'visible' : 'hidden';
    }
    for (const [id, el] of captions) if (!seen.has(id)) el.style.visibility = 'hidden';
    stepChips();
  }
  const actorLabel = id => id === 'lead' ? ctx.leadName || t('主 Agent') : memberNames.get(id) || t('内部成员');

  // ── Chips ─────────────────────────────────────────────────────────────
  const smooth = (a, b, x) => { const v = Math.min(1, Math.max(0, (x - a) / (b - a))); return v * v * (3 - 2 * v); };
  const inOut = v => v < .5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
  function makeChip(label, text, kind) {
    const el = document.createElement('div'); el.className = 'war-chip'; el.dataset.kind = kind; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<b>${escapeHtml(label)}</b><span>${escapeHtml(text)}</span>`; root.append(el);
    const chip = { el, mode: '', t: 0, x: -999, y: -999, s: .35, o: 0, w: el.offsetWidth, h: el.offsetHeight, last: performance.now() }; chips.push(chip); return chip;
  }
  function hook({ actorId, operationId }) {
    const op = (scene?.operations || []).find(row => row.id === operationId); if (!op || !opened) return;
    const chip = operationChip(op), el = makeChip(verbName(chip.verb), chip.text, chip.failed ? 'failed' : op.module);
    Object.assign(el, { mode: 'hook', actorId, target: () => landing(`[data-row-key="${attrValue('op:' + operationId)}"]`), rowKey: 'op:' + operationId });
  }
  function release({ actorId, operationId, lost }) {
    const chip = chips.find(c => c.actorId === actorId && c.rowKey === 'op:' + operationId);
    if (!chip || lost) { if (chip) dropChip(chip); reveal('op:' + operationId); return; }
    chip.mode = 'lift'; chip.t = 0; chip.y0 = chip.y;
  }
  function landing(selector) {
    const row = band.querySelector(selector), seenBox = band.getBoundingClientRect();
    if (row) {
      const r = row.getBoundingClientRect(), body = row.closest('.war-body')?.getBoundingClientRect() || r;
      if (r.top >= body.top - 1 && r.bottom <= body.bottom + 1 && r.left >= seenBox.left - 1 && r.right <= seenBox.right + 1) return { x: r.left + 4, y: r.top + r.height / 2, s: Math.min(1, Math.max(.62, (r.height - 3) / 20)) };
      const cell = row.closest('.war-cell')?.querySelector('h3')?.getBoundingClientRect();
      if (cell && cell.left >= seenBox.left - 1 && cell.right <= seenBox.right + 1) return { x: cell.left, y: cell.top + cell.height / 2, s: .85 };
    }
    return { x: seenBox.left + 8, y: seenBox.top + 20, s: .7 };
  }
  function dropChip(chip) { chip.el.remove(); chips.splice(chips.indexOf(chip), 1); }
  function stepChips() {
    const now = performance.now();
    for (const chip of [...chips]) {
      const dt = Math.min(.05, (now - chip.last) / 1000); chip.last = now; chip.t += dt;
      if (chip.mode === 'hook') {
        const p = gpu?.clawPoint(chip.actorId); if (!p) { dropChip(chip); reveal(chip.rowKey); continue; }
        const k = smooth(0, .2, chip.t); chip.x = p.x - chip.w * .5; chip.y = p.y - chip.h - 5; chip.s = .35 + .65 * k; chip.o = k;
      } else if (chip.mode === 'rise') {
        const p = gpu?.corePoint() || { x: innerWidth / 2, y: innerHeight / 3 }, k = smooth(0, .3, chip.t);
        chip.x = p.x + chip.dx - chip.w * .5; chip.y = p.y + chip.dy - chip.h * .5 - 16 * Math.min(1, chip.t / .5); chip.s = .4 + .6 * k; chip.o = k;
        if (chip.t >= .55) { chip.mode = 'lift'; chip.t = 0; chip.y0 = chip.y; }
      } else if (chip.mode === 'lift') {
        chip.y = chip.y0 - 12 * Math.min(1, chip.t / .16); chip.s += (1 - chip.s) * .5; chip.o = 1;
        if (chip.t >= .16) { chip.mode = 'fly'; chip.t = 0; chip.x0 = chip.x; chip.y1 = chip.y; chip.s0 = chip.s; }
      } else if (chip.mode === 'fly') {
        const goal = chip.target(), endX = goal.x, endY = goal.y - chip.h * goal.s / 2;
        chip.length ??= Math.min(1.15, Math.max(.8, .7 + Math.hypot(endX - chip.x0, endY - chip.y1) / 2400));
        const u = inOut(Math.min(1, chip.t / chip.length)), cx = chip.x0 + (endX - chip.x0) * .2, cy = Math.min(chip.y1, endY) - 70;
        chip.x = (1 - u) ** 2 * chip.x0 + 2 * (1 - u) * u * cx + u * u * endX; chip.y = (1 - u) ** 2 * chip.y1 + 2 * (1 - u) * u * cy + u * u * endY; chip.s = chip.s0 + (goal.s - chip.s0) * u;
        if (chip.t >= chip.length) { chip.mode = 'land'; chip.t = 0; reveal(chip.rowKey); }
      } else if (chip.mode === 'land') {
        const goal = chip.target(); chip.x = goal.x; chip.y = goal.y - chip.h * goal.s / 2; chip.s = goal.s; chip.o = 1 - smooth(0, .2, chip.t);
        if (chip.t >= .22) { dropChip(chip); continue; }
      }
      chip.el.style.transform = `translate(${chip.x.toFixed(1)}px,${chip.y.toFixed(1)}px) scale(${chip.s.toFixed(3)})`; chip.el.style.opacity = chip.o.toFixed(3);
    }
    // A row whose chip never came (the spider was gone, the run moved on) shows anyway.
    for (const [key, since] of pending) if (now - since > 7000) reveal(key);
  }
  function reveal(key) {
    if (!pending.delete(key)) return;
    const row = band.querySelector(`[data-row-key="${attrValue(key)}"]`);
    if (row) { row.dataset.pending = 'false'; row.removeAttribute('aria-hidden'); row.dataset.fresh = 'true'; setTimeout(() => { if (row.dataset.fresh === 'true') row.dataset.fresh = 'false'; }, 1200); }
    const cell = row?.closest('.war-cell'); if (cell) { cell.dataset.pulse = 'false'; void cell.offsetWidth; cell.dataset.pulse = 'true'; }
  }
  const animating = () => opened && !ctx.still && !reduced() && !failed;
  // What changed since the last render: finished calls wait for their chip;
  // candidates the lead newly admitted (or promoted) rise from the core.
  function noteChanges(next) {
    const sameRun = next?.runId === scene?.runId, live = animating() && sameRun;
    const actors = sceneActors(next), spiderOps = new Set(actors.filter(actor => actor.kind === 'member').flatMap(actor => actor.operations));
    const leadOps = new Set(actors.find(actor => actor.kind === 'lead')?.operations || []), fromCore = [];
    for (const op of next?.operations || []) {
      const before = statuses.get(op.id), terminal = TERMINAL.includes(op.status), finished = live && terminal && before && !TERMINAL.includes(before);
      if (finished && spiderOps.has(op.id)) pending.set('op:' + op.id, performance.now());
      // The lead works from the core: its finished call rises from there to its row.
      else if (finished && leadOps.has(op.id)) fromCore.push(op);
      statuses.set(op.id, op.status);
    }
    const snapshot = sceneEvaluation(next).snapshot, previous = shownSnapshot.get(next?.runId);
    if (next?.runId) shownSnapshot.set(next.runId, snapshot);
    fromCore.forEach((op, i) => { const chip = operationChip(op); rise(next.runId, 'op:' + op.id, verbName(chip.verb), chip.text, chip.failed ? 'failed' : chip.verb, i, 120 + i * 260); });
    if (!sameRun || !live || previous === undefined || !snapshot) return;
    evaluationChanges(previous, snapshot).forEach((change, i) => rise(next.runId, 'cand:' + change.key, `${tierName(change.tier)} ${change.total}`, change.name, change.tier, i, 450 + i * 320));
  }
  // A chip rising from the core to its row, on a timer bound to this run and this showing (see cancelRises).
  function rise(runId, key, label, text, kind, i, delay) {
    pending.set(key, performance.now());
    const generation = riseGeneration;
    const id = setTimeout(() => {
      rises.delete(id);
      if (generation !== riseGeneration || scene?.runId !== runId) return;
      if (!animating()) { reveal(key); return; }
      const chip = makeChip(label, text, kind);
      Object.assign(chip, { mode: 'rise', dx: (i % 3 - 1) * 190, dy: -30 - (i % 2) * 30, rowKey: key, target: () => landing(`[data-row-key="${attrValue(key)}"]`) });
    }, delay);
    rises.add(id);
  }

  // ── Band ──────────────────────────────────────────────────────────────
  function cell(id, wide = false) {
    let c = cells.get(id);
    if (!c) {
      const el = document.createElement('article'); el.className = 'war-cell'; el.dataset.cell = id; if (wide) el.dataset.wide = 'true';
      el.innerHTML = `<header><h3></h3><span class="war-meta"></span></header><div class="war-body"></div>`;
      c = { el, title: el.querySelector('h3'), meta: el.querySelector('.war-meta'), body: el.querySelector('.war-body'), html: null, list: null, rows: new Map() }; cells.set(id, c);
    }
    return c;
  }
  const head = (c, title, meta = '') => { if (c.title.textContent !== title) c.title.textContent = title; if (c.meta.innerHTML !== meta) { c.meta.innerHTML = meta; c.meta.title = c.meta.textContent; } };
  const fill = (c, html) => { if (c.html === html) return; const top = c.body.scrollTop; c.body.innerHTML = html; c.html = html; c.list = null; c.rows.clear(); c.body.scrollTop = top; };
  function layout() {
    const board = sceneHasBoard(scene), wanted = detail ? ['log', 'detail'] : board ? ['log', 'dispatch', 'gate', 'heat', 'coverage', 'contract'] : ['log', 'regions', 'resources'];
    const key = `${detail ? 'detail' : board ? 'board' : 'plain'}`;
    cell('log').el.dataset.wide = String(key === 'plain');
    if (key === mode && wanted.every(id => cells.get(id)?.el.parentNode === band)) return;
    mode = key; band.dataset.mode = key; band.replaceChildren(...wanted.map(id => cell(id).el));
  }
  function renderLog() {
    const c = cell('log'), rows = sceneLog(scene);
    head(c, t('执行日志'), `${trace('calls', escapeHtml(t('{count} 次工具调用', { count: (scene?.operations || []).length })))}`);
    if (!rows.length) { fill(c, empty(t('任务发生时，每一步都会记在这里'))); return; }
    if (!c.list) { c.body.innerHTML = '<ol class="war-log"></ol>'; c.html = null; c.list = c.body.firstChild; c.rows.clear(); }
    const keys = new Set(); let prev = null;
    for (const row of rows) {
      const key = row.verb === 'handoff' || row.verb === 'dispatch' ? `${row.verb}:${row.id}` : ['search', 'read', 'lookup', 'compute', 'write', 'call'].includes(row.verb) ? `op:${row.id}` : `${row.verb}:${row.id}`;
      keys.add(key);
      const actor = row.actor?.role === 'lead' ? (ctx.leadName || t('主 Agent')) : `${roleName(row.actor?.role)}${row.actor?.index ? ' #' + row.actor.index : ''}`;
      const text = row.verb === 'evaluate' && row.summary ? t('发现 {found} · 合格 {qualified} · 主推 {primary}', { found: row.summary.discovered ?? 0, qualified: row.summary.verified ?? 0, primary: row.summary.recommended ?? 0 }) : row.verb === 'dispatch' && row.target ? `→ ${roleName(row.target.role)} #${row.target.index} · ${row.detail}` : row.verb === 'deliver' && row.outcome ? (scene.completion?.summary ? runtimeCompletionText(scene.completion) : statusText(row.status)) : row.detail;
      const html = `<button type="button" data-war-record="${escapeHtml(row.id === 'scene:finish' ? '' : row.id)}"><time>${clock(row.offsetMs)}</time><b>${escapeHtml(row.id === 'scene:finish' ? endName(deliveryStatus(scene)) : verbName(row.verb))}</b><span>${dot(row.actor?.role, row.actor?.role === 'lead' ? '' : undefined)}${escapeHtml(actor)}</span><em>${escapeHtml(String(text || '').slice(0, 200))}</em></button>`;
      let li = c.rows.get(key);
      if (!li) {
        li = document.createElement('li'); li.dataset.rowKey = key; li.dataset.verb = row.verb; li.innerHTML = html; li.dataset.html = html;
        const scrolled = c.body.scrollTop > 2;
        if (prev) prev.after(li); else c.list.prepend(li);
        if (!prev && scrolled) c.body.scrollTop += li.offsetHeight; else if (pending.has(key) && animating()) li.dataset.arriving = 'true';
        c.rows.set(key, li);
      } else if (li.dataset.html !== html) { li.innerHTML = html; li.dataset.html = html; }
      const wait = pending.has(key) ? 'true' : 'false'; if (li.dataset.pending !== wait) { li.dataset.pending = wait; if (wait === 'true') li.setAttribute('aria-hidden', 'true'); else li.removeAttribute('aria-hidden'); }
      li.dataset.status = row.status || '';
      prev = li;
    }
    for (const [key, li] of c.rows) if (!keys.has(key)) { li.remove(); c.rows.delete(key); }
  }
  function renderDispatch() {
    const c = cell('dispatch'), members = sceneMembers(scene);
    head(c, t('分派'), escapeHtml(t('{count} 次 · {running} 进行中', { count: members.length, running: members.filter(m => m.running).length })));
    fill(c, members.length ? `<ol class="war-dispatch">${members.map(m => `<li data-running="${m.running}"><div class="war-dispatch-head">${dot(m.role)}${escapeHtml(roleName(m.role))} #${m.index}<small>${escapeHtml(m.running ? t('进行中') : statusText(m.status))}</small></div><p>${escapeHtml(m.running ? m.task : m.report || m.task)}</p><div class="war-ticks">${(scene.operations || []).filter(op => m.operations.includes(op.id)).map(op => `<i data-status="${escapeHtml(op.status)}"></i>`).join('')}${trace(`member:${m.index}`, escapeHtml(m.rounds ? t('{count} 次调用 · 上限 {rounds} 轮', { count: m.calls, rounds: m.rounds }) : t('{count} 次调用', { count: m.calls })))}</div></li>`).join('')}</ol>` : empty(t('主 Agent 还没有分派成员')));
  }
  function renderGate(snapshot) {
    const c = cell('gate'), gate = deliveryGate(snapshot);
    head(c, t('交付闸门'), gate ? escapeHtml(t('四项都满足才核验')) : '');
    if (!gate) { fill(c, empty(t('建立任务合同后出现'))); return; }
    const arc = i => { const a0 = Math.PI * (1.25 - i * .5) - .08, a1 = Math.PI * (1.25 - (i + 1) * .5) + .08; const p = a => [48 + 36 * Math.cos(a), 48 - 36 * Math.sin(a)].map(v => v.toFixed(1)).join(' '); return `M${p(a0)} A36 36 0 0 1 ${p(a1)}`; };
    const names = { count: t('数量'), primary: t('主推'), coverage: t('覆盖'), gaps: t('缺口') };
    const status = deliveryStatus(scene, snapshot), state = deliveryText(status, gate.nextBatch);
    fill(c, `<div class="war-gate" data-open="${gate.open}"><svg viewBox="0 0 96 96" role="img" aria-label="${escapeHtml(t('满足 {met} / 4 项', { met: gate.met }))}">${gate.rows.map((r, i) => `<path class="war-arc" data-met="${r.met}" d="${arc(i)}"/>`).join('')}<text x="48" y="54" text-anchor="middle">${gate.met}/4</text></svg><ul>${gate.rows.map(r => `<li data-met="${r.met}"><span>${escapeHtml(names[r.key])}</span>${trace(`gate:${r.key}`, `${escapeHtml(r.value)}${r.met ? ' ✓' : ''}`)}</li>`).join('')}</ul></div><p class="war-gate-state" data-state="${escapeHtml(status)}">${escapeHtml(state)}</p>`);
  }
  function renderHeat(snapshot) {
    const c = cell('heat');
    head(c, t('证据热力'), snapshot ? escapeHtml(t('候选 × 必填字段')) : '');
    if (!snapshot) { fill(c, empty(sceneEvaluation(scene).updates ? t('这条记录没有结构化评估数据') : t('还没有候选'))); return; }
    const fields = (snapshot.contract?.requiredFields || []).slice(0, 6), all = snapshot.candidates || [];
    const qualified = all.filter(r => ['primary', 'alternative', 'eligible'].includes(r.tier)), count = key => traceList(scene, key, { snapshot });
    const top = qualified.length ? Math.max(...qualified.map(r => r.total)) : null, everyone = count('candidates:all');
    const rows = all.map(r => { const key = 'cand:' + r.key; return `<tr data-row-key="${escapeHtml(key)}" data-tier="${escapeHtml(r.tier)}" data-pending="${pending.has(key)}"><th><button type="button" data-war-trace="${escapeHtml('candidate:' + r.key)}" title="${escapeHtml(`${r.name} · ${r.total} · ${tierName(r.tier)}${r.excludeReason ? ' · ' + r.excludeReason : ''}`)}">${escapeHtml(r.name)}</button></th>${fields.map(f => `<td data-s="${escapeHtml(r.fields?.[f] || 'missing')}"></td>`).join('')}</tr>`; }).join('');
    fill(c, `<table class="war-heat"><thead><tr><th></th>${fields.map(f => `<th><button type="button" data-war-trace="${escapeHtml('field:' + f)}" title="${escapeHtml(fieldName(f))}">${escapeHtml(fieldName(f))}</button></th>`).join('')}</tr></thead><tbody>${rows || `<tr><th>${escapeHtml(t('等待主 Agent 评估…'))}</th>${fields.map(() => '<td></td>').join('')}</tr>`}</tbody></table>
      ${everyone.omitted ? `<p class="war-omitted">${escapeHtml(t('表中列出 {listed} 条，另有 {count} 条未随快照记录', { listed: all.length, count: everyone.omitted }))}</p>` : ''}
      <div class="war-ledger">${trace('candidates:all', `${escapeHtml(t('发现'))}<b>${everyone.count}</b>`)}${trace('candidates:qualified', `${escapeHtml(t('合格'))}<b>${count('candidates:qualified').count}</b>`)}${trace('candidates:excluded', `${escapeHtml(t('排除'))}<b>${count('candidates:excluded').count}</b>`)}${trace('candidates:top', `${escapeHtml(t('最高'))}<b>${top ?? '—'}</b>`)}</div>`);
  }
  function renderCoverage(snapshot) {
    const c = cell('coverage');
    head(c, t('合同覆盖'), snapshot?.contract ? escapeHtml(t('未排除候选中已核实的占比')) : '');
    if (!snapshot?.contract) { fill(c, empty(t('建立任务合同后出现'))); return; }
    const fields = (snapshot.contract.requiredFields || []).slice(0, 8), share = f => fieldCoverage(snapshot, f).share, n = Math.max(3, fields.length);
    const scope = fields.length ? fieldCoverage(snapshot, fields[0]) : null;
    const pt = (i, k) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [70 + Math.cos(a) * 34 * k, 46 + Math.sin(a) * 34 * k]; };
    const poly = k => fields.map((_, i) => pt(i, k).map(v => v.toFixed(1)).join(',')).join(' ');
    const svg = fields.length >= 3 ? `<svg class="war-radar" viewBox="0 0 140 92" aria-hidden="true"><polygon class="grid" points="${poly(1)}"/><polygon class="grid" points="${poly(.5)}"/><polygon class="value" points="${fields.map((f, i) => pt(i, Math.max(.05, share(f))).map(v => v.toFixed(1)).join(',')).join(' ')}"/></svg>` : '';
    const outside = scope?.outside ? `<p class="war-omitted">${escapeHtml(t('按快照所带的 {count} 个未排除候选计算，另有 {outside} 个候选未随快照记录', { count: scope.total, outside: scope.outside }))}</p>` : '';
    fill(c, `${svg}${outside}<div class="war-fields">${fields.map(f => trace(`field:${f}`, `${escapeHtml(fieldName(f))} <b>${Math.round(share(f) * 100)}%</b>`)).join('')}</div><div class="war-tags">${(snapshot.contract.coverage || []).map(row => `<button type="button" data-war-trace="gate:coverage" data-on="${row.covered}">${escapeHtml(row.tag)}${row.covered ? ' ✓' : ''}</button>`).join('')}</div>`);
  }
  function renderContract(snapshot) {
    const c = cell('contract'), k = snapshot?.contract, stageId = sceneStageRail(scene).find(r => r.key === 'contract')?.stageId;
    head(c, t('任务合同'), k ? escapeHtml(t('用户原话为准，不能下调')) : '');
    if (!k) { fill(c, empty(t('这项任务没有建立合同（单一事实 / 计算 / 操作不需要）'))); return; }
    const target = k.explicit?.value ? `${k.explicit.value} ${k.unit || ''} · “${k.explicit.quote || ''}”` : `${k.target?.minimum ?? '?'}–${k.target?.maximum ?? '?'} ${k.unit || ''}`;
    const lines = [[t('版本'), `r${k.revision} · ${k.category || ''} · ${k.mode || ''}`], [t('目标'), target], ...(k.constraints || []).slice(0, 4).map(row => [t('硬条件'), `${fieldName(row.field)} ${row.op} ${row.value}${row.quote ? ` · “${row.quote}”` : ''}`]), [t('必填'), (k.requiredFields || []).map(fieldName).join(' · ')], [t('覆盖'), (k.coverage || []).map(row => row.tag).join('  ')]];
    fill(c, `<pre class="war-contract">${lines.map(([a, b]) => `<span><b>${escapeHtml(a)}</b>${escapeHtml(b)}</span>`).join('')}</pre>${stageId ? `<button type="button" class="war-link" data-war-record="${escapeHtml(stageId)}">${escapeHtml(t('查看评估记录'))}</button>` : ''}`);
  }
  // One row per region: its button (opens the region's details) and its count (opens its records).
  function regionRows(summary) {
    return summary.map(r => `<li data-status="${escapeHtml(r.status)}"><button type="button" data-war-region="${r.id}">${dot('', r.id)}${escapeHtml(regionName(r.id))}</button>${trace(`region:${r.id}`, escapeHtml(r.calls ? t('{count} 次调用', { count: r.calls }) : r.records ? t('{count} 条记录', { count: r.records }) : t('无调用记录')))}</li>`).join('');
  }
  function renderRegions() {
    const c = cell('regions'), summary = regionSummary(scene);
    head(c, t('区域与来源'), escapeHtml(t('每次调用只算在一个区域')));
    fill(c, `<ul class="war-regions">${regionRows(summary)}</ul>${(scene?.sources || []).length ? `<p class="war-sources">${trace('sources', escapeHtml(t('{count} 条来源', { count: scene.sources.length })))}</p>` : ''}`);
  }
  function renderResources() {
    const c = cell('resources'), res = sceneResources(scene, { now: Date.now() });
    head(c, t('资源账本'), '');
    fill(c, `<dl class="war-resources"><div><dt>${escapeHtml(t('工具调用'))}</dt><dd>${trace('calls', num(res.toolCalls))}</dd></div><div><dt>${escapeHtml(t('输入 token'))}</dt><dd>${trace('tokens', tokenCount(res))}</dd></div><div><dt>${escapeHtml(t('用时'))}</dt><dd>${trace('time', `<span data-war-elapsed>${clock(res.elapsedMs)}</span>`)}</dd></div></dl>`);
  }
  // Details: a record (its execution detail), a trace (the records behind a
  // number) or a region (its calls, plus sources, results or summaries).
  function renderDetail() {
    const c = cell('detail'), back = `<button type="button" class="war-back" data-war-back>${escapeHtml(t('返回作战台'))}</button>`;
    if (detail.type === 'record') { head(c, t('执行详情'), back); fill(c, recordDetail?.(detail.id) || empty(t('这条记录已不在当前任务里'))); return; }
    const list = traceList(scene, detail.type === 'region' ? `region:${detail.id}` : detail.key);
    const title = detail.type === 'region' ? regionName(detail.id) : traceTitle(list);
    const count = list.kind === 'tokens' ? t('{count} 次模型请求 · 共 {tokens} token', { count: list.count, tokens: num(list.total) }) : list.kind === 'time' ? t('用时 {time}', { time: clock(list.elapsedMs) }) : t('{count} 条记录', { count: list.count });
    head(c, title, `<span class="war-count">${escapeHtml(count)}</span>${back}`);
    const omitted = list.omitted ? `<p class="war-omitted">${escapeHtml(t('另有 {count} 条未随快照记录，数量取自评估器的总数', { count: list.omitted }))}</p>` : '';
    const field = list.kind === 'field' ? `<p class="war-omitted">${escapeHtml(t('已核实 {verified} / {count}', { verified: list.verified, count: list.count }))}${list.outside ? ' · ' + escapeHtml(t('另有 {count} 个候选未随快照记录，不在此统计内', { count: list.outside })) : ''}</p>` : '';
    fill(c, `${detail.type === 'region' ? regionExtra?.(detail.id) || '' : traceExtra?.(detail.key) || ''}${field}${list.rows.length ? `<ol class="war-trace">${list.rows.map(traceRow).join('')}</ol>` : list.omitted ? '' : empty(t('没有对应的记录'))}${omitted}`);
  }
  function traceTitle(list) {
    if (list.kind === 'calls') return t('全部工具调用');
    if (list.kind === 'sources') return t('检索来源');
    if (list.kind === 'tokens') return t('模型输入 token');
    if (list.kind === 'time') return t('用时');
    if (list.kind === 'member') { const m = sceneMembers(scene).find(row => String(row.index) === list.arg); return m ? `${roleName(m.role)} #${m.index}` : t('内部成员'); }
    if (list.kind === 'candidates') return ({ all: t('全部候选'), qualified: t('合格候选'), excluded: t('排除的候选'), top: t('最高分候选') })[list.arg] || t('全部候选');
    if (list.kind === 'gate') return `${t('交付闸门')} · ${({ count: t('数量'), primary: t('主推'), coverage: t('覆盖'), gaps: t('缺口') })[list.arg] || ''}`;
    if (list.kind === 'field') return `${t('必填字段')} · ${fieldName(list.arg)}`;
    if (list.kind === 'candidate') return list.rows[0]?.name || t('候选');
    if (list.kind === 'checkpoint') return t('软检查点');
    return t('记录');
  }
  function traceRow(row) {
    if (row.kind === 'operation' || row.kind === 'stage') {
      const who = row.actor ? (row.actor.kind === 'lead' ? ctx.leadName || t('主 Agent') : `${roleName(row.actor.role)} #${row.actor.index}`) : '';
      return `<li data-status="${escapeHtml(row.status)}"><button type="button" data-war-record="${escapeHtml(row.id)}"><time>${clock(offset(scene, row.at))}</time><b>${escapeHtml(row.kind === 'operation' ? verbName(row.verb) : row.name)}</b><span>${dot('', row.module)}${escapeHtml(regionName(row.module))}${who ? ' · ' + escapeHtml(who) : ''}${row.kind === 'stage' && row.tokens ? ' · ' + escapeHtml(t('{tokens} token', { tokens: num(row.tokens) })) : ''}</span><em>${escapeHtml(row.text)}</em><small>${escapeHtml(statusText(row.status))}</small></button></li>`;
    }
    if (row.kind === 'source') return `<li><a href="${escapeHtml(row.url)}" data-external-url="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer"><b>${escapeHtml(row.title || new URL(row.url).hostname)}</b><span>${escapeHtml(new URL(row.url).hostname)}</span><em>${escapeHtml(row.reading)}</em><small>${escapeHtml(row.cited ? t('已被最终引用') : t('未被最终引用'))}</small></a></li>`;
    if (row.kind === 'candidate') return `<li data-tier="${escapeHtml(row.tier)}"><div><b>${escapeHtml(row.name)}</b><span>${escapeHtml(tierName(row.tier))} · ${escapeHtml(t('排序分 {score}，不是概率', { score: row.total }))}</span>${row.reason ? `<em>${escapeHtml(row.reason)}</em>` : ''}<small>${Object.entries(row.fields).map(([f, s]) => `${escapeHtml(fieldName(f))} ${s === 'verified' ? '✓' : s === 'failed' ? '✗' : '·'}`).join('  ')}</small></div></li>`;
    if (row.kind === 'coverage') return `<li><div><b>${escapeHtml(row.tag)}</b><span>${escapeHtml(row.covered ? t('已覆盖') : t('未覆盖'))}</span></div></li>`;
    if (row.kind === 'gap') return `<li><div><b>${escapeHtml(row.text)}</b></div></li>`;
    if (row.kind === 'moment') return `<li><div><b>${escapeHtml({ start: t('开始'), 'first-call': t('第一次调用'), 'last-call': t('最后一次调用返回'), finish: t('结束') }[row.label])}</b><span>${clock(row.offsetMs)}</span></div></li>`;
    if (row.kind === 'policy') return `<li><div><b>${escapeHtml({ milliseconds: t('软检查点时间'), calls: t('软检查点调用次数'), memberCalls: t('单个成员调用上限') }[row.id])}</b><span>${escapeHtml(row.id === 'milliseconds' ? clock(row.value) : num(row.value))}</span></div></li>`;
    return '';
  }
  function renderTop() {
    const rail = sceneStageRail(scene), current = rail.find(row => row.current), latest = sceneLog(scene, { limit: 1 })[0];
    const now = !scene ? t('等待任务') : sceneFinished(scene) ? (scene.completion?.summary ? runtimeCompletionText(scene.completion) : statusText(scene.status)) : latest ? [latest.actor?.role && latest.actor.role !== 'lead' ? roleName(latest.actor.role) : ctx.leadName || t('主 Agent'), current && verbName(latest.verb) === phaseName(current.key) ? '' : verbName(latest.verb), latest.detail].filter(Boolean).join(' · ') : t('等待第一条执行记录');
    const html = `<em>${String(Math.max(1, rail.findIndex(row => row.current) + 1)).padStart(2, '0')}</em>${escapeHtml(current ? phaseName(current.key) : '')}${current ? ' · ' : ''}${escapeHtml(String(now).slice(0, 160))}`;
    const el = $('.war-now'); if (el.innerHTML !== html) el.innerHTML = html;
    const railHtml = rail.map((row, i) => `<li data-phase="${row.key}" data-current="${row.current && !sceneFinished(scene)}" data-status="${escapeHtml(row.status)}"><button type="button"${row.stageId ? ` data-war-record="${escapeHtml(row.stageId)}"` : ' disabled'}><b>${String(i + 1).padStart(2, '0')}</b>${escapeHtml(row.key === 'deliver' ? (sceneFinished(scene) ? endName(deliveryStatus(scene)) : t('停止')) : phaseName(row.key))}${row.count > 1 && row.key !== 'contract' ? ` ×${row.count}` : ''}</button></li>`).join('');
    const r = $('.war-rail'); if (r.innerHTML !== railHtml) r.innerHTML = railHtml;
    const history = (ctx.history?.length > 1 ? `<select aria-label="${escapeHtml(t('选择历史任务'))}" data-execution-history>${ctx.history.map(row => `<option value="${escapeHtml(row.runId)}"${row.runId === scene?.runId ? ' selected' : ''}>${escapeHtml(row.label)}</option>`).join('')}</select>` : '')
      + (ctx.older ? `<button type="button" class="war-older" data-execution-action="older-scenes">${escapeHtml(t('更早的任务'))}</button>` : '');
    const h = $('.war-history'); if (h.innerHTML !== history) h.innerHTML = history;
  }
  function renderStatus() {
    const snapshot = sceneEvaluation(scene).snapshot, res = sceneResources(scene, { now: Date.now(), snapshot }), point = res.checkpoint;
    const html = `<span class="war-note">${escapeHtml(ctx.note || '')}</span>${trace('calls', escapeHtml(t('工具调用 {count}', { count: res.toolCalls })))}${trace('tokens', escapeHtml(t('输入 {tokens} token', { tokens: tokenCount(res) })))}${trace('time', `${escapeHtml(t('用时'))} <span data-war-elapsed>${clock(res.elapsedMs)}</span>`)}${point ? trace('checkpoint', escapeHtml(t('软检查点 {time} / {calls} 次', { time: clock(point.milliseconds), calls: point.calls }))) : ''}`;
    const el = $('.war-status'); if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }
  function tick() { const res = sceneResources(scene, { now: Date.now() }); for (const el of root.querySelectorAll('[data-war-elapsed]')) el.textContent = clock(res.elapsedMs); }
  function render(next, context = {}) {
    noteChanges(next);
    // A new run starts on the band, unless its remembered view was just restored.
    if (next?.runId !== scene?.runId) { if (keepDetail !== (next?.runId ?? null)) detail = null; keepDetail = null; cancelRises(); pending.clear(); for (const chip of [...chips]) dropChip(chip); }
    scene = next; ctx = context;
    if (!animating() && (rises.size || chips.length || pending.size)) settleFlights();
    summary = new Map(regionSummary(scene).map(row => [row.id, row])); working = new Set((scene?.operations || []).filter(op => op.status === 'running').map(op => op.module));
    gateOpen = !!deliveryGate(sceneEvaluation(scene).snapshot)?.open; memberNames = new Map(sceneMembers(scene).map(m => [`member:${m.index}`, `${roleName(m.role)} #${m.index}`]));
    root.dataset.run = scene?.runId || ''; root.dataset.board = String(sceneHasBoard(scene));
    renderTop(); layout(); renderLog();
    if (detail) renderDetail();
    else if (sceneHasBoard(scene)) { const snapshot = sceneEvaluation(scene).snapshot; renderDispatch(); renderGate(snapshot); renderHeat(snapshot); renderCoverage(snapshot); renderContract(snapshot); }
    else { renderRegions(); renderResources(); }
    renderStatus(); renderFallback();
    gpu?.setStill(!!ctx.still); gpu?.update(scene);
  }
  function showDetail(next) {
    detail = next; if (next?.type === 'region') gpu?.focusRegion(next.id);
    onRegionChange?.(next?.type === 'region' ? next.id : null);
    layout(); render(scene, ctx);
    cells.get('detail')?.body.scrollTo?.(0, 0);
  }

  // ── Input ─────────────────────────────────────────────────────────────
  root.addEventListener('click', event => {
    const target = event.target.closest('[data-war-trace],[data-war-record],[data-war-region],[data-war-view],[data-war-follow],[data-war-zoom],[data-war-back],[data-war-close]');
    if (!target || !root.contains(target)) return;
    onInteract?.();
    if (target.dataset.warTrace) showDetail({ type: 'trace', key: target.dataset.warTrace });
    else if (target.dataset.warRecord !== undefined) { if (target.dataset.warRecord) showDetail({ type: 'record', id: target.dataset.warRecord }); }
    else if (target.dataset.warRegion) showDetail({ type: 'region', id: target.dataset.warRegion });
    else if (target.dataset.warView) { gpu?.setView(target.dataset.warView, { followId: target.dataset.warView === 'follow' ? sceneActors(scene).find(a => a.out)?.id || null : null }); if (detail?.type === 'region') { detail = null; render(scene, ctx); } }
    else if (target.dataset.warFollow) gpu?.setView('follow', { followId: target.dataset.warFollow });
    else if (target.dataset.warZoom) { gpu?.zoomBy(target.dataset.warZoom === 'in' ? 1.2 : 1 / 1.2); syncZoom(); }
    else if (target.hasAttribute('data-war-back')) { detail = null; gpu?.focusRegion(null); onRegionChange?.(null); render(scene, ctx); }
    else if (target.hasAttribute('data-war-close')) onClose?.();
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (detail) { detail = null; gpu?.focusRegion(null); onRegionChange?.(null); render(scene, ctx); } else onClose?.(); return; }
    if (!event.target.closest?.('.war-stage') || !gpu) return;
    const step = Math.PI / 12, keys = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, -step * .6], ArrowDown: [0, step * .6] };
    if (keys[event.key]) { event.preventDefault(); const view = gpu.view; if (view.mode === 'global') gpu.setView('free'); gpu.rotateBy?.(...keys[event.key]); onInteract?.(); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); gpu.zoomBy(1.2); syncZoom(); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); gpu.zoomBy(1 / 1.2); syncZoom(); }
    else if (event.key === '0') { event.preventDefault(); gpu.setView('global'); syncZoom(); }
  });
  let ticker = 0;
  return {
    root, render,
    get opened() { return opened; },
    showRecord(id) { showDetail({ type: 'record', id }); },
    showRegion(id) { if (EXECUTION_MODULES.some(m => m.id === id)) showDetail({ type: 'region', id }); },
    back() { detail = null; gpu?.focusRegion(null); render(scene, ctx); },
    /** A run's remembered view: the region whose details were open, or none. */
    restore(region, runId = null) { detail = EXECUTION_MODULES.some(m => m.id === region) ? { type: 'region', id: region } : null; keepDetail = runId; gpu?.focusRegion(detail?.id || null); },
    setOpen(value, { focus = false } = {}) {
      if (opened === value) return;
      opened = value; root.hidden = !value; document.documentElement.dataset.warRoom = String(value);
      clearInterval(ticker); if (value) ticker = setInterval(tick, 1000);
      if (value) { ensureScene(); render(scene, ctx); if (focus) setTimeout(() => { if (opened && !root.contains(document.activeElement)) stage.focus({ preventScroll: true }); }, 0); }
      else settleFlights();
      gpu?.setOpen(value);
    },
    dispose() { clearInterval(ticker); cancelRises(); gpu?.dispose(); gpu = null; for (const chip of [...chips]) dropChip(chip); root.remove(); },
  };
}
