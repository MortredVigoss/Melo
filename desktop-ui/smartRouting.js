import { escapeHtml } from './html.js';
import { t, ui } from './i18n.js';
import { EditSession, renderEditActions, paintEditActions } from './settingsEdit.js';
import { modelLabel } from './modelPresentation.js';
const session = new EditSession();
let draft = null, busy = false, message = '', conflict = false, dragged = null;
const escape = value => escapeHtml(value ?? '');
const defaults = { revision:0, defaultMode:'fixed', preference:'balanced', allowCrossConnection:false, allowEscalation:true, tiers:{ light:[], standard:[], strong:[] }, candidates:[] };
const valueOf = config => config.smartRouting || defaults;
const copy = saved => JSON.parse(JSON.stringify({ ...defaults, ...saved }));
const same = (a,b) => a.connectionId === b.connectionId && a.model === b.model;
export function editSmartRouting(target) {
  const root = target.closest?.('[data-smart-routing]');
  if (!root || !target.name || !session.editing || busy) return false;
  if (['defaultMode','preference'].includes(target.name)) draft[target.name] = target.value;
  else if (['allowCrossConnection','allowEscalation'].includes(target.name)) draft[target.name] = target.checked;
  else if (target.name === 'candidate') {
    const candidate = draft.candidates[Number(target.dataset.index)], tier = target.dataset.tier;
    if (!candidate || !draft.tiers[tier]) return false;
    const entries = draft.tiers[tier].filter(a => !same(a,candidate));
    if (target.checked) entries.push({ connectionId:candidate.connectionId, model:candidate.model, vision:candidate.capabilities?.vision === true });
    draft.tiers[tier] = entries;
  } else if (target.name === 'vision') {
    const candidate = draft.candidates[Number(target.dataset.index)];
    for (const entries of Object.values(draft.tiers)) for (const a of entries) if (same(a,candidate)) a.vision = target.checked;
  } else return false;
  session.change(); message = '';
  paintEditActions(root.querySelector('.settings-edit-toolbar'), session, {prefix:'smart-routing',saveDisabled:conflict});
  return true;
}
export function smartRoutingDrag(event, render) {
  const root = event.target.closest?.('[data-smart-routing]');
  if (!root || !session.editing || busy) return;
  if (event.type === 'dragstart') dragged = Number(event.target.closest('[data-candidate]')?.dataset.candidate);
  if (event.type === 'dragover' && event.target.closest('[data-tier]')) event.preventDefault();
  if (event.type === 'drop') {
    const tier = event.target.closest('[data-tier]')?.dataset.tier, c = draft.candidates[dragged];
    if (!tier || !c) return;
    event.preventDefault(); if (!draft.tiers[tier].some(a=>same(a,c))) draft.tiers[tier].push({connectionId:c.connectionId,model:c.model,vision:c.capabilities?.vision===true});
    session.change(); dragged = null; render();
  }
}
export function renderSmartRouting(config) {
  const saved = valueOf(config);
  if (!session.editing && !busy) draft = copy(saved);
  const disabled = !session.editing || busy ? 'disabled' : '';
  const candidates = draft.candidates || [];
  const selected = [...new Set(Object.values(draft.tiers).flat().map(c=>JSON.stringify([c.connectionId,c.model])))];
  return ui`<section class="surface-card smart-routing-settings" data-smart-routing data-neural-key="smart-routing-${session.revision}">
    <h2 class="pane-title">智能模式</h2><p class="page-kicker">固定模型与智能（自动）均可选择。模型档位由你指定，价格与延迟仅作参考。</p>
    ${renderEditActions(session,{prefix:'smart-routing',disabled:busy,saveDisabled:conflict})}
    ${conflict?ui`<button type="button" data-action="smart-routing-rebase">载入最新版本并保留我的选择</button>`:''}
    <div class="config-form"><label class="label">默认模式<select name="defaultMode" ${disabled}><option value="fixed" ${draft.defaultMode==='fixed'?'selected':''}>固定模型</option><option value="smart" ${draft.defaultMode==='smart'?'selected':''}>智能（自动）</option></select></label>
    <label class="label">选择偏好<select name="preference" ${disabled}>${[['cost','节省成本'],['balanced','均衡'],['quality','质量优先']].map(([v,n])=>`<option value="${v}" ${draft.preference===v?'selected':''}>${escape(t(n))}</option>`).join('')}</select></label></div>
    <p class="list-row-meta">Agent 已指定固定模型时，智能模式沿用该模型。只配置一个可用模型时等同固定模型，不额外请求判断。</p>
    <label class="list-row-meta"><input type="checkbox" name="allowCrossConnection" ${draft.allowCrossConnection?'checked':''} ${disabled}> 允许智能模式向其他已保存连接发送内容</label>
    <label class="list-row-meta"><input type="checkbox" name="allowEscalation" ${draft.allowEscalation?'checked':''} ${disabled}> 允许本轮任务最多升档一次</label>
    <p class="list-row-meta">默认只使用本对话连接。判断最多等待 3 秒，会计入用量；固定选择和明确的简单任务不请求判断。</p>
    ${selected.length===1?ui`<p class="chip">当前配置等同固定模型</p>`:''}
    <p class="list-row-meta">勾选或拖动模型到档位；同档按列表顺序尝试。图片理解需要已通过测试或手动确认支持。</p>
    <div class="smart-routing-tiers">${[['light','轻'],['standard','标准'],['strong','强']].map(([tier,label])=>ui`<fieldset data-tier="${tier}"><legend>${t(label)}</legend>${[...candidates].sort((a,b)=>(draft.tiers[tier].findIndex(x=>same(x,a))+1 || 9999)-(draft.tiers[tier].findIndex(x=>same(x,b))+1 || 9999)).map(c=>{
      const i=candidates.indexOf(c), rank=draft.tiers[tier].findIndex(a=>same(a,c));
      const chosen=draft.tiers[tier].find(a=>same(a,c));
      return ui`<div class="smart-routing-candidate" data-candidate="${i}" draggable="${!disabled}"><label><input type="checkbox" name="candidate" data-index="${i}" data-tier="${tier}" ${chosen?'checked':''} ${disabled}> ${escape(modelLabel(c.model))}</label><small>${escape(c.name)} · ${escape(c.model)}${c.latencyMs?` · ${escape(c.latencyMs)} ms`:''}${c.price?` · ${escape(JSON.stringify(c.price))}`:''}</small><label><input type="checkbox" name="vision" data-index="${i}" ${chosen?.vision?'checked':''} ${disabled||!chosen?'disabled':''}> ${t('支持图片理解')}</label>${chosen?ui`<div><button type="button" data-action="smart-routing-move-up" data-tier="${tier}" data-rank="${rank}" ${disabled||rank===0?'disabled':''}>↑</button><span>${rank+1}</span><button type="button" data-action="smart-routing-move-down" data-tier="${tier}" data-rank="${rank}" ${disabled||rank===draft.tiers[tier].length-1?'disabled':''}>↓</button></div>`:''}</div>`;
    }).join('')}</fieldset>`).join('')}</div><p role="status" aria-live="polite">${escape(message)}</p></section>`;
}
export async function handleSmartRouting(action,{config,api,render,refresh,trigger}) {
  if (!action?.startsWith('smart-routing-')) return false;
  if (busy) return true;
  if (action==='smart-routing-edit') { draft=copy(valueOf(config));session.begin();conflict=false;message='';render();return true; }
  if (action.startsWith('smart-routing-move-') && session.editing) {
    const rows=draft.tiers[trigger?.dataset.tier], index=Number(trigger?.dataset.rank), next=index+(action.endsWith('-up')?-1:1);
    if(rows?.[index] && rows[next]) { [rows[index],rows[next]]=[rows[next],rows[index]]; session.change();render(); } return true;
  }
  if (action==='smart-routing-cancel') {session.cancel();draft=null;conflict=false;message=t('已取消修改');render();return true;}
  if (action==='smart-routing-rebase' && conflict) {
    busy=true;render();try {const latest=(await api('/api/bootstrap')).settings.config.smartRouting;config.smartRouting=latest;draft.revision=latest.revision;draft.candidates=latest.candidates;conflict=false;session.begin();session.change();message=t('已保留你的选择，请确认后保存。');} catch {message=t('读取失败，选择仍保留，请重试。');} finally {busy=false;render();}return true;
  }
  if (action!=='smart-routing-save' || conflict || !session.start()) return true;
  const pending=copy(draft);delete pending.candidates;busy=true;message=t('正在保存…');render();
  try {config.smartRouting=await api('/api/settings/smart-routing',{method:'POST',body:pending});session.saved();message=t('已保存');try {await refresh();} catch {message+=' '+t('页面刷新失败，保存结果已保留。');}}
  catch(error){session.failed(error);conflict=/设置已被更新/.test(error.message);message=error.message||t('操作失败，草稿保留');}
  finally {busy=false;render();}return true;
}
