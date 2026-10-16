import {t,ui} from './i18n.js';

// Keep unsaved management input outside the polling-rendered application root.
export function managementDialog({title,fields=[],submitLabel='保存',submit}) {
 const dialog=document.createElement('dialog');dialog.className='chat-file-dialog management-dialog';
 const form=document.createElement('form'),heading=document.createElement('h2');heading.textContent=t(title);form.append(heading);
 for(const field of fields) {
  const label=document.createElement('label');label.className='label';label.textContent=t(field.label);
  const input=document.createElement(field.options?'select':field.type==='textarea'?'textarea':'input');input.className=field.type==='textarea'?'textarea':'config-input';input.name=field.name;
  if(field.options) for(const option of field.options){const el=document.createElement('option');el.value=option.id;el.textContent=option.name || option.id;input.append(el);}
  else if(field.type!=='textarea')input.type=field.type || 'text';
  if(field.type==='file')input.accept='.md,text/markdown,text/plain';else if(field.value!==undefined || !field.options) input.value=field.value || '';
  input.required=Boolean(field.required);label.append(input);form.append(label);
 }
 const error=document.createElement('p');error.setAttribute('role','alert');
 const output=document.createElement('pre');output.className='management-output';output.setAttribute('role','status');
 const actions=document.createElement('div');actions.className='inline-actions';
 const run=document.createElement('button');run.className='small-button is-primary';run.textContent=t(submitLabel);run.type='submit';
 const close=document.createElement('button');close.className='small-button';close.type='button';close.textContent=t('关闭');close.onclick=()=>{dialog.close();dialog.remove();};
 actions.append(run,close);form.append(error,output,actions);dialog.append(form);document.body.append(dialog);dialog.showModal();
 dialog.addEventListener('cancel',()=>dialog.remove());
 form.addEventListener('submit',async event=>{event.preventDefault();event.stopPropagation();run.disabled=true;error.textContent='';try {const result=await submit(Object.fromEntries(new FormData(form)),form);if(result?.close){dialog.close();dialog.remove();}else output.textContent=typeof result==='string'?result:JSON.stringify(result,null,2);}catch(err){error.textContent=err.message;}finally{run.disabled=false;}});
 return dialog;
}
export function renderSkillManagement(selected,escapeHtml) {
 return ui`<div class="inline-actions"><button class="small-button" data-action="manage-import-skill">导入技能</button><button class="small-button" data-action="manage-reload-skills">从磁盘重新加载</button><button class="small-button" data-action="manage-scan-skills">重新扫描建议</button>${selected?.source==='custom'?ui`<button class="small-button" data-action="manage-promote-skill" data-skill-id="${escapeHtml(selected.id)}">写入磁盘</button>`:''}</div>`;
}
export function renderConnectorManagement(connector,escapeHtml) {
 return ui`<div class="inline-actions"><button class="small-button" data-action="manage-edit-connector" data-connector-id="${escapeHtml(connector.id)}">编辑连接器</button><button class="small-button" data-action="manage-remove-connector" data-connector-id="${escapeHtml(connector.id)}">删除连接器</button>${[['resource','读取资源'],['prompt','预览提示词'],['invoke','调用工具']].map(([action,label])=>ui`<button class="small-button" data-action="manage-${action}-connector" data-connector-id="${escapeHtml(connector.id)}">${t(label)}</button>`).join('')}</div>`;
}
export async function handleManagementAction(action,trigger,{api,data,applyBootstrap,refresh}) {
 if(!action.startsWith('manage-'))return false;
 const post=(path,body)=>api(path,{method:'POST',body});
 const save=async(path,body)=>{const result=await post(path,body);applyBootstrap(result);return {close:true};};
 if(action==='manage-new-connector' || action==='manage-edit-connector') {
  const connector=(data.customize?.connectors || data.connectors || []).find(c=>c.id===trigger.dataset.connectorId),config=connector?.config || {};
  managementDialog({title:connector?'编辑连接器':'新增连接器',fields:[
   {name:'name',label:'名称',value:connector?.name,required:true},{name:'endpoint',label:'服务地址',value:config.endpoint,required:true,type:'url'},
   {name:'description',label:'说明',value:connector?.description},{name:'prompt',label:'上下文提示词',type:'textarea',value:connector?.prompt},{name:'authToken',label:'访问令牌（留空保留原值）',type:'password'},
   ...[['healthPath','健康检查路径'],['manifestPath','服务清单路径'],['contextPath','上下文路径'],['resourcePath','资源路径'],['promptPath','提示词路径'],['invokePath','工具调用路径']].map(([name,label])=>({name,label,value:config[name]})),
  ],submit:values=>save(connector?'/api/connectors/external/update':'/api/connectors/external',connector?{connectorId:connector.id,patch:values}:values)});
 } else if(action==='manage-remove-connector') {
  const connector=(data.customize?.connectors || data.connectors || []).find(c=>c.id===trigger.dataset.connectorId);
  managementDialog({title:'删除连接器',submitLabel:'确认删除',fields:[{name:'name',label:'名称',value:connector?.name}],submit:()=>save('/api/connectors/external/remove',{connectorId:connector.id})});
 } else if(['manage-resource-connector','manage-prompt-connector','manage-invoke-connector'].includes(action)) {
  const connector=(data.customize?.connectors || data.connectors || []).find(c=>c.id===trigger.dataset.connectorId),kind=action.split('-')[1];
  const key=kind==='invoke'?'tools':kind==='prompt'?'prompts':'resources';
  const options=(connector.config?.manifest?.[key] || []).map(o=>({id:kind==='invoke'?o.name:o.id,name:o.name || o.title || o.id}));
  managementDialog({title:kind==='invoke'?'调用工具':kind==='prompt'?'预览提示词':'读取资源',submitLabel:'执行',fields:[{name:'id',label:'选择条目',options,required:true},...(kind==='invoke'?[{name:'input',label:'工具参数（JSON）',type:'textarea',value:'{}',required:true}]:[])],submit:async values=>{
   if(!options.some(o=>o.id===values.id))throw new Error(t('请先测试连接以读取服务清单。'));
   const body={connectorId:connector.id,projectId:data.activeChat?.projectId || null,[kind==='invoke'?'toolName':kind==='prompt'?'promptId':'resourceId']:values.id};
   if(kind==='invoke')body.input=JSON.parse(values.input);
   const result=await post('/api/connectors/external/'+kind,body);if(result.bootstrap)applyBootstrap(result.bootstrap);return result.toolRun || result;
  }});
 } else if(action==='manage-import-skill') {
  managementDialog({title:'导入技能',submitLabel:'导入',fields:[{name:'file',label:'技能 Markdown 文件',type:'file',required:true}],submit:async(_,form)=>{const file=form.elements.file.files[0];if(file.size>1024*1024)throw new Error(t('文件超过 1 MB。'));return save('/api/skills/import',{markdown:await file.text()});}});
 } else if(action==='manage-promote-skill') {
  managementDialog({title:'写入磁盘',submitLabel:'保存',submit:()=>save('/api/skills/promote-to-disk',{skillId:trigger.dataset.skillId})});
 } else if(action==='manage-reload-skills') {applyBootstrap(await post('/api/skills/reload-disk',{}));
 } else if(action==='manage-scan-skills') {managementDialog({title:'重新扫描建议',submitLabel:'扫描',submit:()=>post('/api/skill-proposals/rescan',{})});
 } else if(action==='manage-reconnect-mcp') {await post('/api/mcp/connect',{name:trigger.dataset.serverName});await refresh();
 } else if(action==='manage-session-permissions') {
  const options=(data.chats || data.recents || []).map(c=>({id:c.id,name:c.title}));
  const dialog=managementDialog({title:'会话工具授权',submitLabel:'查看授权',fields:[{name:'chatId',label:'选择对话',options,value:data.activeChat?.id,required:true}],submit:values=>api('/api/tools/session-permissions?chatId='+encodeURIComponent(values.chatId))});
  const revoke=document.createElement('button');revoke.type='button';revoke.className='small-button';revoke.textContent=t('撤销此对话的临时授权');dialog.querySelector('.inline-actions').prepend(revoke);
  revoke.onclick=async()=>{const chatId=dialog.querySelector('[name=chatId]').value;if(!chatId)return;revoke.disabled=true;try{await post('/api/tools/session-permissions/clear?chatId='+encodeURIComponent(chatId),{});dialog.querySelector('[role=status]').textContent=JSON.stringify(await api('/api/tools/session-permissions?chatId='+encodeURIComponent(chatId)),null,2);}catch(error){dialog.querySelector('[role=alert]').textContent=error.message;}finally{revoke.disabled=false;}};
 } else return false;
 return true;
}
