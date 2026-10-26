import { t, ui, escapeHtml as esc } from './i18n.js';
import { renderLanguageControl } from './languageControls.js';
import { renderAgentAvatar } from './agentAvatar.js';
import { createRouteSampler } from './neuralSampling.js';
// The navigation tree is explicit: visual links describe real UI hierarchy.
export const neuralGroups = [
 {id:'chat',get name(){return t('对话');},en:'CONVERSATIONS',symbol:'◌',get description(){return t('想法从一段对话开始。');}},
 {id:'projects',get name(){return t('项目');},en:'PROJECTS',symbol:'◇',get description(){return t('把相关的工作与知识，连接在一起。');}},
 {id:'agents',get name(){return t('Agent');},en:'AGENTS',symbol:'✧',get description(){return t('为不同的工作，找到合适的思考方式。');}},
 {id:'knowledge',get name(){return t('知识');},en:'KNOWLEDGE',symbol:'△',get description(){return t('知识由你保存并选用；记忆自动召回；技能提供工作方法。');}},
 {id:'system',get name(){return t('系统');},en:'SYSTEM',symbol:'⬡',get description(){return t('连接模型、工具与本地工作环境。');}},
];
export function groupForSettings(settings={}) {
 if(settings.activeView==='projects')return 'projects';
 if(settings.activeView==='agent')return 'agents';
 if(settings.activeView==='artifacts')return 'knowledge';
 if(['model','settings'].includes(settings.activeView))return 'system';
 if(settings.activeView==='customize') return ['memory','skills'].includes(settings.selectedCustomizeSection)?'knowledge':settings.selectedCustomizeSection==='agents'?'agents':'system';
 return 'chat';
}
export function neuralEntries(data,group) {
 const view=(name,id,description)=>({name,description,selected:data.settings?.activeView===id,action:'open-view',attrs:`data-view="${id}"`});
 const section=(name,id,description)=>({name,description,selected:data.settings?.activeView==='customize'&&data.settings?.selectedCustomizeSection===id,action:'open-customize-section',attrs:`data-section="${id}"`});
 if(group==='chat')return [{name:t("新对话"),description:t("开始新的思考"),selected:data.settings?.activeView==='chat'&&!data.settings?.selectedChatId,action:'new-chat',attrs:''},view(t("所有对话"),'chats',t("浏览完整历史")),view(t("搜索"),'search',t("查找消息、知识与功能")),...(data.chats||[]).slice(0,10).map(c=>({name:c.title,description:c.preview||t("继续对话"),action:'open-chat',attrs:`data-chat-id="${esc(c.id)}"`,id:c.id}))];
 if(group==='projects')return [view(t("项目总览"),'projects',t("创建项目与管理工作区")),...(data.projects||[]).slice(0,12).map(p=>({name:p.name,description:p.summary||t("打开项目"),action:'focus-project',attrs:`data-project-id="${esc(p.id)}"`,id:p.id}))];
 if(group==='agents')return [section(t("Agent管理"),'agents',t("创建、导入与管理Agent")),...(data.customize?.agents||[]).map(a=>({name:a.name,description:a.description||t("配置Agent"),action:'select-agent-profile',attrs:`data-agent-id="${esc(a.id)}"`,id:a.id}))];
 if(group==='knowledge')return [view(t("知识与成果"),'artifacts',t("添加知识、保存成果，在对话中选用")),section(t("记忆"),'memory',t("长期记忆与检索状态")),section(t("技能"),'skills',t("可复用的工作方法"))];
 return [view(t("系统设置"),'settings',t("个人资料、外观、语音与数据")),view(t("模型"),'model',t("模型连接与用量")),section(t("连接器"),'connectors',t("应用与工作区连接")),section(t("工具与任务"),'advanced',t("MCP、后台任务与运行状态")),section(t("安全"),'safety',t("查看文件权限与授权规则"))];
}
function entryButton(entry,index,selectedId) {
 return ui`<button class="neural-branch ${(entry.selected||(entry.id&&entry.id===selectedId))?'is-active':''}" data-neural-key="${esc(entry.action+':'+(entry.id||entry.attrs))}" data-action="${entry.action}" ${entry.attrs}><i></i><span class="neural-branch-text"><strong>${esc(entry.name)}</strong><small>${esc(String(entry.description).slice(0,70))}</small></span><span class="neural-branch-arrow">↗</span></button>`;
}
export function renderNeuralNavigation(data,group,{overview=false,still=false}={}) {
 const selected=neuralGroups.find(g=>g.id===group)||neuralGroups[0];
 const entries=neuralEntries(data,selected.id);
 const selectedId=group==='chat'?data.settings.selectedChatId:group==='projects'?data.settings.selectedProjectId:group==='agents'?data.settings.selectedAgentId:null;
 return ui`<nav class="neural-navigation" aria-label="功能星团">
    <button class="neural-brand" data-action="neural-overview" aria-label="返回星图总览"><span class="neural-brand-mark">✳</span><span>melo<small>NEURAL WORKSPACE</small></span></button>
    <div class="neural-primary">${neuralGroups.map((g,i)=>ui`<button class="neural-cluster ${g.id===group?'is-active':''}" data-neural-key="group-${g.id}" data-action="neural-group" data-group="${g.id}" aria-pressed="${g.id===group}"><span class="neural-orb" aria-hidden="true"><span>${g.symbol}</span></span><span class="neural-cluster-copy"><strong>${g.name}</strong><small>${g.en}</small></span></button>`).join('')}</div>
    <div class="neural-nav-footer">${renderLanguageControl()}<button data-action="neural-motion" aria-pressed="${still}" title="切换持续动效与静态模式">${still?t("◈ 静态模式"):t("◈ 星空流动")}</button><button class="local-profile-trigger" data-action="settings-open" title="个人资料与设置">${renderAgentAvatar(data.profile,esc,28)}<span>${esc(data.profile?.name||t("本机用户"))}</span></button></div>
  </nav>
  <aside class="neural-branches" data-group="${selected.id}" aria-label="${selected.name}功能分支"><div class="neural-branches-heading"><span>0${neuralGroups.indexOf(selected)+1} / ${selected.en}</span><h2 class="pane-title">${selected.name}<small>${entries.length}</small></h2><p>${selected.description}</p></div><div class="neural-branch-list">${entries.map((e,i)=>entryButton(overview?{...e,selected:false}:e,i,overview?null:selectedId)).join('')}</div><span class="neural-branch-caption">选择分支，展开工作内容</span></aside>`;
}
export function renderNeuralOverview(data,group,{composer=''}={}) {
 const selected=neuralGroups.find(g=>g.id===group)||neuralGroups[0];
 return ui`<section class="neural-overview"><div class="neural-home-caption"><span>MELO / YOUR CONNECTED WORKSPACE</span><p>从一个想法，连接整个工作空间。</p></div><div class="neural-module-summary"><small>正在探索</small><h1 class="page-title">${selected.name}</h1><p>${selected.description}</p><span>选择分支，进入工作内容。</span></div><div class="neural-home-composer">${composer}</div><div class="neural-overview-note">${data.chats?.length||0} 段对话 · ${data.projects?.length||0} 个项目 · ${data.customize?.agents?.length||0} 个Agent</div></section>`;
}
let scene=null,pending=false,host=null,wantStill=false;
const boundRoots=new WeakSet(),boundLists=new WeakSet();
function readRoutes() {
 if(!host?.isConnected)return [];
 const root=host.closest('.neural-shell'),origin=host.getBoundingClientRect();
 const center=el=>{const r=el.getBoundingClientRect();return [r.left+r.width/2-origin.left,r.top+r.height/2-origin.top];};
 const selected=root.querySelector('.neural-cluster.is-active');
 if(!selected)return [];
 const hovered=root.querySelector('.neural-cluster:hover'),keyboard=root.querySelector('.neural-cluster:focus-visible');
 const active=neuralGroups.findIndex(g=>g.id===selected.dataset.group);
 const coreHover=Number(root.dataset.coreHover??-1),branchHover=root.querySelector('.neural-branch:hover,.neural-branch:focus-visible');
 const hoverFocus=hovered?neuralGroups.findIndex(g=>g.id===hovered.dataset.group):coreHover>=0?coreHover:branchHover?active:keyboard?neuralGroups.findIndex(g=>g.id===keyboard.dataset.group):-1;
 const focus=hoverFocus>=0?hoverFocus:root.dataset.neuralStage==='overview'?-1:active;
 const orbs=[...root.querySelectorAll('.neural-orb')];
 const ports=orbs.map(center);
 const portRadii=orbs.map(el=>el.getBoundingClientRect().width*.47);
 const core=center(root.querySelector('.neural-core-anchor'));
 const list=root.querySelector('.neural-branch-list'),bounds=list.getBoundingClientRect();
 const branches=root.dataset.neuralStage==='overview'?[]:[...root.querySelectorAll('.neural-branch')].filter(el=>{const r=el.getBoundingClientRect();return r.top>=bounds.top&&r.bottom<=bounds.bottom;});
 const opened=branches.find(el=>el.classList.contains('is-active'));
 const highlighted=branches.find(el=>el.matches(':hover,:focus-visible'))||opened;
 const routes=branches.map(el=>[ports[active],center(el.querySelector('i')),el===highlighted]);
 const panel=root.querySelector('.neural-dashboard-label').getBoundingClientRect();
 const working=root.classList.contains('is-working');
 return {routes,ports,portRadii,core,brainScale:Number(root.style.getPropertyValue('--neural-brain-scale'))||undefined,focus,hoverFocus,active,working,stage:root.dataset.neuralStage,stationaryNavigation:root.dataset.neuralStage!=='overview',busy:root.dataset.neuralBusy==='true',permission:root.dataset.neuralPermission==='true',flight:root.dataset.flight==='true',
   branch:highlighted?.textContent.trim().slice(0,80)||'',
   output:working&&opened?[center(opened.querySelector('i')),[panel.left-origin.left,panel.top+panel.height/2-origin.top]]:null};
}
const routeSampler=createRouteSampler(readRoutes);
function sampledRoutes(){const routes=routeSampler.get();if(host&&host.dataset.routeReads!==String(routeSampler.reads))host.dataset.routeReads=String(routeSampler.reads);return routes;}
function syncRoutes(){routeSampler.invalidate();scene?.setRoutes(sampledRoutes());}
function configureScene(){if(!scene)return;scene.setRouteProvider(sampledRoutes);scene.setDepth(host.closest('.neural-shell').classList.contains('is-working'));}
if (typeof window !== 'undefined') window.addEventListener('resize',syncRoutes);
export function syncNeuralScene(still=false) {
 host=document.querySelector('.neural-cosmos');wantStill=still;
 if(!host){scene?.dispose();scene=null;return;}
 const root=host.closest('.neural-shell'),list=root.querySelector('.neural-branch-list');
 if(list&&!boundLists.has(list)){list.addEventListener('scroll',syncRoutes,{passive:true});boundLists.add(list);}
 if(!boundRoots.has(root)){
   const preview=()=>{
     const focused=root.querySelector('.neural-cluster:hover,.neural-cluster:focus-visible');
     const card=root.querySelector('.neural-preview'),g=neuralGroups.find(g=>g.id===focused?.dataset.group);
     card.hidden=!g||root.dataset.neuralStage!=='overview';
     root.dataset.preview=card.hidden?'false':'true';
     if(!card.hidden){const r=focused.getBoundingClientRect(),o=root.getBoundingClientRect();card.textContent=g.description;card.style.left=`${Math.min(o.width-240,Math.max(12,r.left-o.left-60))}px`;card.style.top=`${Math.min(o.height-130,r.bottom-o.top+8)}px`;}
     syncRoutes();
   };
   for(const event of ['pointerover','pointerout','focusin','focusout'])root.addEventListener(event,preview,{passive:true});
   const clearCore=()=>{if(root.dataset.coreHover!==undefined&&root.dataset.coreHover!=='-1'){root.dataset.coreHover='-1';syncRoutes();}};
   const isControl=target=>target.closest('button,a,input,textarea,select,[role="dialog"],.neural-dashboard,.palette-shell,.tool-permission-shell');
   const previewCore=event=>{
     if(isControl(event.target)){clearCore();return;}
     const group=scene?.pickCore(event.clientX,event.clientY,Number(root.dataset.coreHover??-1))??-1;
     if(String(group)!==root.dataset.coreHover){root.dataset.coreHover=String(group);syncRoutes();}
   };
   for(const event of ['pointermove','pointerover','pointerdown'])root.addEventListener(event,previewCore,{passive:true});
   root.addEventListener('pointerleave',clearCore,{passive:true});
   root.addEventListener('click',event=>{
     if(isControl(event.target))return;
     const group=scene?.pickCore(event.clientX,event.clientY)??-1;
     if(group<0)return;
     clearCore();root.querySelector(`[data-action="neural-group"][data-group="${neuralGroups[group].id}"]`)?.click();
   });
   boundRoots.add(root);
 }
 if(scene){scene.attach(host);scene.setStill(still);configureScene();syncRoutes();return;}
 if(pending)return;
 pending=true;
 import('./neuralScene3D.js').then(async ({createNeuralScene})=>{
   if(!host?.isConnected)return;
   scene=await createNeuralScene(host);scene?.attach(host);scene?.setStill(wantStill);configureScene();syncRoutes();
 }).catch(()=>{host?.classList.add('is-fallback');}).finally(()=>{pending=false;});
}
