import {t,ui} from './i18n.js';
export function renderCapabilityChoices(name,label,selected,options,escapeHtml) {
 const ids=Array.isArray(selected)?selected:String(selected||'').split(',').filter(Boolean);
 const choices=new Map((options||[]).map(o=>[o.id,o]));
 for(const id of ids) if(!choices.has(id)) choices.set(id,{id,name:id,unavailable:true});
 return ui`<fieldset class="capability-choice-list"><legend>${escapeHtml(t(label))}</legend><input type="hidden" name="${name}__choices" value="1">${[...choices.values()].map(o=>ui`<label class="checkbox-row"><input type="checkbox" data-capability-choice name="${name}" value="${escapeHtml(o.id)}" ${ids.includes(o.id)?'checked':''}>${escapeHtml(o.name || o.id)} ${o.unavailable?ui`<span class="chip">当前不可用</span>`:''}</label>`).join('') || ui`<p>暂无可选项</p>`}</fieldset>`;
}
