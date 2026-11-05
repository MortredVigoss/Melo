// Task-space board (plan C, 2026-11-05): the stage rail, the current-action
// card, the view switch and the six board cards under the 3D space. Every
// figure comes from src/shared/executionBoard.js projections of the recorded
// scene; empty cards say so instead of animating placeholders.
import { escapeHtml, t, ui, runtimeCompletionText } from './i18n.js';
import { sceneMembers, sceneStageRail, sceneEvaluation, sceneLog, sceneResources, MEMBER_ROLE_MODULE } from '/shared/executionBoard.js';
import { sceneFinished } from '/shared/executionScene.js';

const roleName = role => ({ research: t('检索成员'), lookup: t('资料读取成员'), calculate: t('计算成员'), execute: t('执行成员'), lead: t('主 Agent') })[role] || t('内部成员');
const verbName = verb => ({ dispatch: t('分派'), handoff: t('交接'), search: t('检索'), read: t('读取'), lookup: t('查询'), compute: t('计算'), write: t('写入'), call: t('调用'),
  approval: t('审批'), evaluate: t('评估'), review: t('核验'), stop: t('停止'), deliver: t('交付') })[verb] || verb;
const phaseName = key => ({ contract: t('合同'), dispatch: t('分派'), approval: t('审批'), evaluate: t('评估'), review: t('核验'), deliver: t('交付') })[key] || key;
const statusText = status => ({ running: t('进行中'), waiting: t('等待'), queued: t('排队'), completed: t('完成'), failed: t('未通过'), cancelled: t('已取消'), interrupted: t('已中断') })[status] || status || '';
const tierName = tier => ({ primary: t('主推'), alternative: t('备选'), eligible: t('合格'), pending: t('待补'), excluded: t('排除') })[tier] || tier;
const stopName = stop => stop === 'ready_for_review' ? t('可进入核验') : t('继续检索');
const roleModule = role => MEMBER_ROLE_MODULE[role] || '';
// Contract field IDs are code; the board shows their meaning.
export const fieldName = field => ({ name: t('名称'), startsAt: t('时间'), place: t('地点'), participation: t('参与方式'), model: t('型号'), region: t('地区'), price: t('价格'), currency: t('币种'), availability: t('在售') })[field] || String(field).slice(0, 8);
const num = value => new Intl.NumberFormat().format(Number(value) || 0);
export const clock = ms => { if (!Number.isFinite(ms)) return '--:--'; const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const tokens = value => value >= 10000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : num(value);
const dot = role => ui`<i class="execution-role-dot" data-role="${escapeHtml(role || 'lead')}" data-module="${escapeHtml(roleModule(role))}"></i>`;

export function renderViewSwitch(mode, { locked = false } = {}) {
  const item = (id, label, hint) => ui`<button type="button" role="radio" aria-checked="${mode === id}" data-execution-action="view" data-view="${id}" title="${escapeHtml(hint)}"${locked && id !== 'global' ? ' data-locked="true"' : ''}>${escapeHtml(label)}</button>`;
  return ui`<div class="execution-view" role="radiogroup" aria-label="${escapeHtml(t('视角'))}">${item('global', t('全局'), t('看到全部模块与星核；缓慢环绕，拖动可接管'))}${item('follow', t('跟随'), t('镜头跟随正在工作的成员；拖动改变角度，滚轮缩放'))}${item('free', t('自由'), t('拖动旋转，方向键每次 15°，滚轮缩放'))}</div>`;
}

export function renderStageRail(scene) {
  const rail = sceneStageRail(scene);
  if (!rail.length) return '';
  return ui`<ol class="execution-rail" aria-label="${escapeHtml(t('已发生的阶段'))}">${rail.map((row, i) => ui`<li data-phase="${row.key}" data-status="${escapeHtml(row.status)}" data-current="${row.current}"><button type="button"${row.stageId ? ui` data-execution-action="inspect" data-operation="${escapeHtml(row.stageId)}"` : ' disabled'} title="${escapeHtml(statusText(row.status))}"><b>${String(i + 1).padStart(2, '0')}</b>${escapeHtml(phaseName(row.key))}${row.key === 'contract' && row.revision ? ` r${escapeHtml(row.revision)}` : row.count > 1 ? ` ×${row.count}` : ''}</button></li>`).join('')}</ol>`;
}

// What is happening now, who does it, and (in follow view) whom to follow.
export function renderNowCard(scene, { leadName = '', mode = 'global', followId = 'lead' } = {}) {
  if (!scene) return '';
  const members = sceneMembers(scene), running = members.filter(member => member.running);
  const rail = sceneStageRail(scene), current = rail.find(row => row.current);
  const latest = sceneLog(scene, { limit: 1 })[0];
  const actor = latest?.actor?.role && latest.actor.role !== 'lead' ? latest.actor : null;
  const title = current ? phaseName(current.key) : sceneFinished(scene) ? t('交付') : t('执行');
  const lead = leadName ? t('{name} · 主 Agent', { name: leadName }) : t('主 Agent');
  const line = sceneFinished(scene) ? (scene.completion?.summary ? runtimeCompletionText(scene.completion) : statusText(scene.status)) : latest ? `${actor ? roleName(actor.role) : lead} · ${verbName(latest.verb)}${latest.detail ? ' · ' + latest.detail : ''}` : t('等待第一条执行记录');
  const chips = mode === 'follow' ? [{ id: 'lead', role: 'lead', label: lead }, ...running.map(member => ({ id: 'member:' + member.index, role: member.role, label: `${roleName(member.role)} #${member.index}` }))] : [];
  return ui`<section class="execution-now" aria-live="polite"><p><b>${String(Math.max(1, rail.findIndex(row => row.current) + 1)).padStart(2, '0')}</b> ${escapeHtml(title)}${current && !sceneFinished(scene) ? ` · ${escapeHtml(statusText(current.status))}` : ''}</p>
    <span>${actor ? dot(actor.role) : dot('lead')}${escapeHtml(String(line).slice(0, 140))}</span>
    ${running.length ? ui`<small>${escapeHtml(t('{count} 个成员工作中', { count: running.length }))}</small>` : ''}
    ${chips.length > 1 ? ui`<div class="execution-follow" role="radiogroup" aria-label="${escapeHtml(t('跟随对象'))}">${chips.map(chip => ui`<button type="button" role="radio" aria-checked="${followId === chip.id}" data-execution-action="follow" data-follow="${escapeHtml(chip.id)}">${dot(chip.role)}${escapeHtml(chip.label)}</button>`).join('')}</div>` : ''}</section>`;
}

// Labels projected into the 3D space for the core and each running member.
export function renderActorLabels(scene, { leadName = '' } = {}) {
  const evaluation = sceneEvaluation(scene), review = (scene?.pipeline || []).filter(stage => /^goal-check:/.test(stage.id)).at(-1);
  const inspect = review?.id || evaluation.stageId;
  const core = ui`<button class="execution-label execution-core" data-node-id="core" type="button"${inspect ? ui` data-execution-action="inspect" data-operation="${escapeHtml(inspect)}"` : ''}><strong>${escapeHtml(leadName || t('主 Agent'))}</strong><small>${escapeHtml(t('路由与评估'))}${evaluation.updates ? ' · ' + escapeHtml(t('评估 {count} 次', { count: evaluation.updates })) : ''}</small></button>`;
  const members = sceneMembers(scene).filter(member => member.running).slice(0, 3).map(member => ui`<button class="execution-label execution-actor" data-node-id="member:${member.index}" type="button" data-execution-action="inspect" data-operation="${escapeHtml(member.id)}">${dot(member.role)}<span>${escapeHtml(roleName(member.role))}</span><small>${escapeHtml(member.activeOperation ? t('{count} 次调用', { count: member.calls }) : t('思考中'))}</small></button>`);
  return core + members.join('');
}

function card(id, title, meta, body, extra = '') {
  return ui`<article class="execution-board-card" data-card="${id}"${extra}><header><h3>${escapeHtml(title)}</h3>${meta ? ui`<span>${meta}</span>` : ''}</header>${body}</article>`;
}
const empty = text => ui`<p class="execution-board-empty">${escapeHtml(text)}</p>`;

function logCard(scene) {
  const rows = sceneLog(scene, { limit: 40 });
  return card('log', t('执行日志'), escapeHtml(t('{count} 条', { count: rows.length })), rows.length ? ui`<ol class="execution-log">${rows.map(row => ui`<li data-verb="${row.verb}" data-status="${escapeHtml(row.status || '')}"><button type="button"${row.id && !row.id.startsWith('scene:') ? ui` data-execution-action="inspect" data-operation="${escapeHtml(row.id)}"` : ''}><time>${clock(row.offsetMs)}</time><b>${escapeHtml(verbName(row.verb))}</b><span>${dot(row.actor?.role)}${escapeHtml(row.actor?.role === 'lead' ? t('主 Agent') : roleName(row.actor?.role))}${row.target ? ' → ' + escapeHtml(roleName(row.target.role)) : ''}</span><em>${escapeHtml(row.summary ? t('发现 {discovered} · 核实 {verified} · 主推 {recommended}', row.summary) : row.outcome ? statusText(row.status) : String(row.detail || '').slice(0, 120))}</em></button></li>`).join('')}</ol>` : empty(t('还没有执行记录')));
}

function dispatchCard(scene) {
  const members = sceneMembers(scene), running = members.filter(member => member.running).length;
  return card('dispatch', t('分派'), escapeHtml(t('{count} 次分派 · {running} 进行中', { count: members.length, running })), members.length ? ui`<ol class="execution-dispatch">${members.map(member => {
    const ops = (scene.operations || []).filter(op => member.operations.includes(op.id));
    return ui`<li data-status="${escapeHtml(member.status)}"><button type="button" data-execution-action="inspect" data-operation="${escapeHtml(member.id)}"><span class="execution-dispatch-head">${dot(member.role)}<strong>${escapeHtml(roleName(member.role))} #${member.index}</strong><small>${escapeHtml(statusText(member.status))}</small></span>
      <span class="execution-dispatch-task">${escapeHtml(member.task || member.report || '')}</span>
      <span class="execution-ticks" aria-label="${escapeHtml(t('{count} 次调用', { count: member.calls }))}">${ops.slice(0, 16).map(op => ui`<i data-status="${escapeHtml(op.status)}"></i>`).join('')}<small>${escapeHtml(t('{count} 次调用', { count: member.calls }))}${member.rounds ? ' · ' + escapeHtml(t('上限 {rounds} 轮', { rounds: member.rounds })) : ''}${member.approval ? ' · ' + escapeHtml(member.approval.status === 'completed' ? t('已获任务级授权') : t('授权未通过')) : ''}</small></span></button></li>`; }).join('')}</ol>` : empty(t('这次没有分派成员，由主 Agent 直接完成')));
}

function radar(fields, values) {
  const n = fields.length, cx = 70, cy = 58, r = 42;
  const point = (i, k) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k]; };
  const ring = k => fields.map((_, i) => point(i, k).map(v => v.toFixed(1)).join(',')).join(' ');
  return ui`<svg class="execution-radar" viewBox="0 0 140 116" role="img" aria-label="${escapeHtml(fields.map((field, i) => `${field} ${Math.round(values[i] * 100)}%`).join(', '))}">
    ${[1, .5].map(k => ui`<polygon class="grid" points="${ring(k)}"/>`).join('')}${fields.map((_, i) => { const [x, y] = point(i, 1); return ui`<line class="grid" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join('')}
    <polygon class="value" points="${fields.map((_, i) => point(i, Math.max(.04, values[i])).map(v => v.toFixed(1)).join(',')).join(' ')}"/>
    ${fields.map((field, i) => { const [x, y] = point(i, 1.22); return ui`<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${x < cx - 4 ? 'end' : x > cx + 4 ? 'start' : 'middle'}">${escapeHtml(String(field).slice(0, 12))}</text>`; }).join('')}</svg>`;
}
function contractCard(view) {
  const s = view.snapshot, c = s?.contract;
  if (!c) return card('coverage', t('合同覆盖'), '', empty(view.updates ? t('评估了 {count} 次 · 详情在结束后显示', { count: view.updates }) : t('这项任务没有建立合同（单一事实 / 计算 / 操作不需要）')));
  const rows = s.candidates.filter(row => row.tier !== 'excluded');
  const values = c.requiredFields.map(field => rows.length ? rows.filter(row => row.fields[field] === 'verified').length / rows.length : 0);
  const failedHard = s.candidates.filter(row => c.constraints.some(rule => row.fields[rule.field] === 'failed')).length;
  const target = c.explicit ? t('明确 {count} 个', { count: c.explicit.value }) : `${c.target.minimum}–${c.target.maximum}`;
  const labels = c.requiredFields.map(fieldName);
  const shape = c.requiredFields.length >= 3 ? radar(labels, values) : ui`<ul class="execution-field-bars">${c.requiredFields.map((field, i) => ui`<li><span>${escapeHtml(fieldName(field))}</span><b>${Math.round(values[i] * 100)}%</b></li>`).join('')}</ul>`;
  return card('coverage', t('合同覆盖'), escapeHtml(t('字段已核实占比')), ui`${shape}<dl class="execution-coverage">
    <div><dt>${escapeHtml(t('硬条件'))}</dt><dd>${escapeHtml(c.constraints.length ? t('{count} 条 · {failed} 个候选不满足', { count: c.constraints.length, failed: failedHard }) : t('无'))}</dd></div>
    <div><dt>${escapeHtml(t('目标'))}</dt><dd>${escapeHtml(t('已核实 {verified} / {target}', { verified: s.summary?.verified ?? 0, target }))}</dd></div>
    <div><dt>${escapeHtml(t('覆盖'))}</dt><dd>${c.coverage.length ? c.coverage.map(row => ui`<b data-covered="${row.covered}">${escapeHtml(row.tag)}${row.covered ? ' ✓' : ''}</b>`).join('') : escapeHtml(t('未指定'))}</dd></div></dl>`);
}

function heatCard(view) {
  const s = view.snapshot;
  if (!s?.contract) return card('heat', t('证据热力'), '', empty(t('还没有候选账本')));
  const fields = s.contract.requiredFields, rows = s.candidates.slice(0, 10);
  const counts = { discovered: s.summary?.discovered ?? 0, read: s.summary?.read ?? 0, verified: s.summary?.verified ?? 0,
    excluded: s.candidates.filter(row => row.tier === 'excluded').length, conflicts: s.candidates.filter(row => row.conflicts).length };
  return card('heat', t('证据热力'), escapeHtml(t('候选 × 必填字段')), ui`<div class="execution-heat"><table aria-label="${escapeHtml(t('候选字段证据'))}"><thead><tr><th></th>${fields.map(field => ui`<th title="${escapeHtml(field)}">${escapeHtml(fieldName(field))}</th>`).join('')}</tr></thead><tbody>${rows.map(row => ui`<tr data-tier="${row.tier}"${row.conflicts ? ' data-conflict="true"' : ''}><th title="${escapeHtml(`${row.name} · ${tierName(row.tier)}${row.excludeReason ? ' · ' + row.excludeReason : ''}`)}">${escapeHtml(row.name)}</th>${fields.map(field => ui`<td data-state="${escapeHtml(row.fields[field] || 'missing')}" title="${escapeHtml(`${fieldName(field)}: ${({ verified: t('已核实'), failed: t('不满足'), missing: t('缺失') })[row.fields[field]] || t('缺失')}`)}"></td>`).join('')}</tr>`).join('')}</tbody></table>
    <dl class="execution-ledger"><div class="execution-ledger-total"><dt>${escapeHtml(t('发现'))}</dt><dd>${num(counts.discovered)}</dd></div><div><dt>${escapeHtml(t('已读'))}</dt><dd>${num(counts.read)}</dd></div><div><dt>${escapeHtml(t('合格'))}</dt><dd>${num(counts.verified)}</dd></div><div><dt>${escapeHtml(t('排除'))}</dt><dd>${num(counts.excluded)}</dd></div><div><dt>${escapeHtml(t('冲突'))}</dt><dd>${num(counts.conflicts)}</dd></div></dl></div>
    ${s.summary?.omitted ? ui`<small class="execution-board-note">${escapeHtml(t('另有 {count} 个候选未显示', { count: s.summary.omitted }))}</small>` : ''}`);
}

function scoreCard(view, scene) {
  const s = view.snapshot;
  if (!s?.contract) return card('score', t('评估分'), '', empty(t('还没有评分')));
  const qualified = s.candidates.filter(row => ['primary', 'alternative', 'eligible'].includes(row.tier));
  const top = qualified.length ? qualified.reduce((best, row) => row.total > best.total ? row : best) : null;
  const p = s.policy, value = top ? top.total : 0;
  const zone = !top ? 'none' : top.tier === 'primary' ? 'primary' : top.total >= p.alternativeScore ? 'alternative' : 'low';
  const arc = (from, to) => { const a0 = Math.PI * (1 - from / 100), a1 = Math.PI * (1 - to / 100), x0 = 60 + 46 * Math.cos(a0), y0 = 62 - 46 * Math.sin(a0), x1 = 60 + 46 * Math.cos(a1), y1 = 62 - 46 * Math.sin(a1); return `M${x0.toFixed(1)} ${y0.toFixed(1)} A46 46 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
  const tick = score => { const a = Math.PI * (1 - score / 100); return ui`<line class="tick" x1="${(60 + 40 * Math.cos(a)).toFixed(1)}" y1="${(62 - 40 * Math.sin(a)).toFixed(1)}" x2="${(60 + 53 * Math.cos(a)).toFixed(1)}" y2="${(62 - 53 * Math.sin(a)).toFixed(1)}"/>`; };
  const series = view.series.filter(row => row.top !== null);
  const spark = series.length > 1 ? ui`<polyline class="spark" points="${series.map((row, i) => `${(8 + i * 104 / (series.length - 1)).toFixed(1)},${(14 - row.top / 100 * 12).toFixed(1)}`).join(' ')}"/>` : '';
  const state = sceneFinished(scene) ? scene.status === 'completed' ? t('已交付') : statusText(scene.status) : s.summary?.stop === 'ready_for_review' ? stopName('ready_for_review') : t('{state} · 下一批 {count}', { state: stopName('continue'), count: s.summary?.nextBatch ?? 0 });
  return card('score', t('评估分'), escapeHtml(t('满分 {max}', { max: p.maxScore })), ui`<svg class="execution-gauge" data-zone="${zone}" viewBox="0 0 120 78" role="img" aria-label="${escapeHtml(top ? t('最高合格候选 {name} {score} 分', { name: top.name, score: top.total }) : t('尚无合格候选'))}">
    ${spark}<path class="track" d="${arc(0, 100)}"/>${top ? ui`<path class="fill" d="${arc(0, Math.max(1, value))}"/>` : ''}${tick(p.alternativeScore)}${tick(p.primaryScore)}
    <text class="value" x="60" y="60" text-anchor="middle">${top ? value : '—'}</text></svg>
    <ul class="execution-score-legend"><li data-on="${!!top && top.total >= p.primaryScore && top.evidence >= p.evidenceScore}">${escapeHtml(t('主推线 {score}', { score: p.primaryScore }))}</li><li>${escapeHtml(t('备选线 {score}', { score: p.alternativeScore }))}</li><li data-on="${!!top && top.evidence >= p.evidenceScore}">${escapeHtml(t('证据分 ≥{score}', { score: p.evidenceScore }))}</li></ul>
    <p class="execution-score-state">${escapeHtml(state)} · ${escapeHtml(t('主推 {primary} · 备选 {alternatives}', { primary: s.summary?.recommended ?? 0, alternatives: s.summary?.alternatives ?? 0 }))}</p>
    <small class="execution-board-note">${escapeHtml(t('排序分，不是概率；硬条件不满足时分数无效'))}</small>`);
}

function specCard(view) {
  const c = view.snapshot?.contract;
  if (!c) return card('spec', t('任务合同'), '', empty(t('这项任务没有建立合同（单一事实 / 计算 / 操作不需要）')));
  const category = ({ events: t('活动'), products: t('商品'), other: t('其他') })[c.category] || c.category;
  const mode = ({ quick: t('快速'), standard: t('标准'), deep: t('深入') })[c.mode] || c.mode;
  const lines = [
    [t('版本'), `r${c.revision} · ${category} · ${mode}`],
    [t('单位'), c.unit],
    [t('目标'), c.explicit ? `${c.explicit.value} · “${c.explicit.quote}”` : `${c.target.minimum}–${c.target.maximum}`],
    [t('必填'), c.requiredFields.join(' · ')],
    ...c.constraints.map(rule => [t('硬条件'), `${rule.field} ${rule.op} ${rule.value}${rule.quote ? ` · “${rule.quote}”` : ''}`]),
    [t('覆盖'), c.coverage.map(row => row.tag + (row.covered ? ' ✓' : '')).join('  ') || t('未指定')],
  ];
  return card('spec', t('任务合同'), escapeHtml(t('用户原话为准，不能下调')), ui`<pre class="execution-contract">${lines.map(([key, value]) => ui`<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join('')}</pre>`);
}

export function renderBoard(scene, { collapsed = false } = {}) {
  const view = sceneEvaluation(scene);
  const header = ui`<header class="execution-board-header"><strong>${escapeHtml(t('作战台'))}</strong><span>${escapeHtml(view.source === 'completion' ? t('评估来自结束回执') : view.source === 'text' ? t('这条记录没有结构化评估数据') : t('全部来自已记录的执行'))}</span><button type="button" data-execution-action="board-toggle" aria-expanded="${!collapsed}">${escapeHtml(collapsed ? t('展开') : t('收起'))}</button></header>`;
  if (collapsed) return header;
  return header + ui`<div class="execution-board-grid">${logCard(scene)}${dispatchCard(scene)}${scoreCard(view, scene)}${heatCard(view)}${contractCard(view)}${specCard(view)}</div>`;
}

export function renderResourceLine(scene, now = Date.now()) {
  const view = sceneEvaluation(scene), r = sceneResources(scene, { now, snapshot: view.snapshot });
  const parts = [t('{count} 次工具调用', { count: r.toolCalls })];
  if (r.inputTokens) parts.push(t('输入 {count} token', { count: tokens(r.inputTokens) }));
  if (r.elapsedMs !== null) parts.push(t('用时 {time}', { time: clock(r.elapsedMs) }));
  if (r.checkpoint) parts.push(t('软检查点 {time} / {calls} 次', { time: clock(r.checkpoint.milliseconds), calls: r.checkpoint.calls }));
  return parts.join(' · ');
}
