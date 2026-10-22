import { LANGUAGES, setLanguage, t, ui } from './i18n.js';
import { EditSession, renderEditActions, paintEditActions } from './settingsEdit.js';
import { renderAgentAvatar, readAgentAvatar } from './agentAvatar.js';
import { normalizeLocalPreferences } from '/shared/localPreferences.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sections=[['profile','个人资料'],['general','通用与外观'],['voice','语音'],['data','数据管理'],['about','关于']];
let tab='profile', draft=null, busy=false, notice='', error='', nativeState=null, nativeLoading=false, cache=null, pendingImport=null;
let deps;
const edits = new Map();
const edit = () => { if(!edits.has(tab)) edits.set(tab,new EditSession()); return edits.get(tab); };
const editableTabs = new Set(['profile','general','voice']);
let exportReady=false;
const bridge=()=>window.webkit?.messageHandlers?.meloVoice;
const requests=new Map();
export function nativeSettings(action,payload={}) {
  if(!bridge())return Promise.reject(new Error(t("此功能需要在 Melo 桌面应用中使用。")));
  return new Promise((resolve,reject)=>{
    const requestID=crypto.randomUUID();
    const timer=setTimeout(()=>{requests.delete(requestID);reject(new Error(t("桌面操作未响应，请重试。")));},['savePortableArchive','saveImage'].includes(action)?300000:15000);
    requests.set(requestID,{resolve,reject,timer});bridge().postMessage({action,requestID,...payload});
  });
}
export function shouldSendOnEnter(event,preferences) {
  return event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!event.altKey && (preferences?.sendShortcut!=='command-enter'||event.metaKey===true||event.ctrlKey===true);
}
export function applyLocalAppearance(data,uiState) {
  const p=normalizeLocalPreferences(data.settings?.localPreferences);
  setLanguage(p.interfaceLanguage);
  uiState.neuralStill=p.motion==='reduced'||matchMedia('(prefers-reduced-motion: reduce)').matches;
  uiState.voiceLanguage=p.voiceLanguage;
  document.documentElement.dataset.meloTextSize=p.textSize;
  document.documentElement.dataset.meloReduced=String(uiState.neuralStill);
}
export function notifyLocalCompletion() {
  // Notification contains no message text and is sent only after a successful turn.
  bridge()?.postMessage({action:'notifyReplyComplete'});
}
const select=(key,label,choices,value)=>ui`<label class="local-setting-row"><span>${t(label)}</span><select class="config-select" data-local-pref="${key}" ${busy?'disabled':''}>${choices.map(([id,name])=>ui`<option value="${id}" ${value===id?'selected':''}>${t(name)}</option>`).join('')}</select></label>`;
// Real state from the native shell: the pet's runtime record, not the saved preference.
const petStatus=device=>!device?t("读取状态中…"):device.desktopPetAvailable===false?t("当前安装未包含桌面宠物"):device.desktopPetRunning?t("运行中"):t("未运行");
const toggle=(key,label,value,note='')=>ui`<label class="local-setting-row"><span>${t(label)}${note?ui`<small>${note}</small>`:''}</span><input type="checkbox" data-local-pref="${key}" ${busy?'disabled':''} ${value?'checked':''}></label>`;
export function renderLocalSettings(data) {
  const p=normalizeLocalPreferences(draft?.prefs || data.settings?.localPreferences), profile=draft?.profile||data.profile, device=draft?.native||nativeState;
  if(bridge()&&!nativeState&&!nativeLoading){nativeLoading=true;queueMicrotask(()=>nativeSettings('getLocalSettings').then(value=>{nativeState=value;deps.render();}).catch(e=>{error=e.message;deps.render();}));}
  let body='', navigation='';
  if(tab==='profile')body=ui`<form data-local-form="profile"><div class="local-profile-edit">${renderAgentAvatar(profile,esc,88)}<div><button type="button" class="small-button" data-action="settings-avatar-pick">更换头像</button><input type="file" accept="image/png,image/jpeg,image/webp" data-local-avatar hidden><button type="button" class="small-button" data-action="settings-avatar-remove">恢复默认头像</button><p>图片会居中裁剪；仅保存在此设备。</p></div></div><label class="local-name">昵称<input name="localName" class="config-input" value="${esc(profile.name)}" maxlength="80" required autocomplete="nickname" ${busy?'disabled':''}></label><p>这是你的个人资料，与你创建的Agent各自独立。目前无需注册或登录。</p></form>`;
  if(tab==='general')body=ui`${select('textSize',t("聊天字号"),[['small',t("小")],['standard',t("标准")],['large',t("大")],['larger',t("更大")]],p.textSize)}${select('motion',t("界面动效"),[['system',t("跟随系统")],['reduced',t("减少动态效果")]],p.motion)}${toggle('autoCollapse',t("任务完成后自动收起任务空间"),p.autoCollapse)}${select('sendShortcut',t("发送消息"),[['enter',t("Enter 发送 · Shift+Enter 换行")],['command-enter',t("⌘ / Ctrl+Enter 发送 · Enter 换行")]],p.sendShortcut)}${toggle('restoreSession',t("重新打开时恢复上次页面"),p.restoreSession)}${select('interfaceLanguage',t('界面语言'),LANGUAGES.map(l=>[l.id,l.name]),p.interfaceLanguage)}<p>${t('仅改变界面文字，聊天内容与模型回复语言不受影响。')}</p>${bridge()?ui`<div class="local-setting-row"><span>登录电脑时启动 Melo</span><select class="config-select" data-local-native="launchAtLogin" ${device?'':'disabled'}><option value="false" ${!device?.launchAtLogin?'selected':''}>关闭</option><option value="true" ${device?.launchAtLogin?'selected':''}>开启</option></select></div><div class="local-setting-row"><span>关闭窗口时</span><select class="config-select" data-local-native="closeBehavior"><option value="quit" ${device?.closeBehavior!=='background'?'selected':''}>退出 Melo</option><option value="background" ${device?.closeBehavior==='background'?'selected':''}>保持后台运行</option></select></div><label class="local-setting-row"><span>后台回复完成通知<small>${esc(device?.notificationStatus||t("读取系统权限中…"))}</small></span><input type="checkbox" data-local-native="notifications" ${device?.notifications?'checked':''}></label><div class="local-setting-row"><span>桌面宠物<small>${esc(petStatus(device))}</small></span><select class="config-select" data-local-native="desktopPet" ${device?.desktopPetAvailable?'':'disabled'}><option value="false" ${!device?.desktopPet?'selected':''}>关闭</option><option value="true" ${device?.desktopPet?'selected':''}>开启</option></select></div>`:ui`<p>开机启动、关闭窗口、系统通知和桌面宠物可在桌面应用中设置。</p>`}<p class="local-shortcuts">⌘ / Ctrl + , 打开设置　·　⌘ / Ctrl + K 搜索命令<br>当前界面保留 Melo 的深色神经网络主题。</p>`;
  if(tab==='voice')body=ui`${select('voiceLanguage',t("语音输入语言"),[['zh-CN',t("中文")],['en-US','English'],['system',t("系统语言")]],p.voiceLanguage)}<p>点击输入区麦克风开始识别；麦克风与语音识别授权由系统管理。</p><label class="local-setting-row"><span>自动朗读回复</span><input type="checkbox" data-local-autospeak ${(draft?.autoSpeak ?? deps.uiState.ttsAutoPlay)?'checked':''}></label>`;
  if(tab==='voice')navigation=ui`<div class="local-actions"><button class="small-button" data-action="settings-voice-options">打开音色与朗读设置</button><button class="small-button" data-action="select-customize-item" data-section="connectors" data-id="openai-compatible">语音服务与密钥配置</button>${bridge()?ui`<button class="small-button" data-action="settings-microphone">打开麦克风权限</button>`:''}</div>`;
  if(tab==='general' && device?.loginNeedsApproval)navigation=ui`<p>需要在 macOS 登录项中允许 Melo。<button class="small-button" data-action="settings-login-items">打开系统登录项</button></p>`;
  if(tab==='data')body=ui`<div class="local-setting-row"><span>本机工作区<small>不需要 Melo 账号</small></span><span>${data.chats?.length||0} 段对话 · ${data.customize?.agents?.length||0} 个Agent</span></div><h3>导出与导入</h3><p>导出普通对话、Agent、项目、共享资料和可迁移的来源记录。原始附件、完整执行账本、模型密钥和设备权限不包含在此文件中；这不是整机备份。</p><div class="local-actions"><button class="small-button" data-action="settings-export" ${busy?'disabled':''}>导出可迁移资料</button><button class="small-button" data-action="settings-import-pick" ${busy?'disabled':''}>导入资料文件</button><input type="file" accept=".json,application/json" data-local-import hidden></div>${pendingImport?ui`<div class="local-import-preview"><p>将合并 ${pendingImport.summary.chats} 段对话、${pendingImport.summary.messages} 条消息及 ${pendingImport.summary.records} 项上下文记录。已有内容保留；冲突进入原有冲突选择入口。</p><button class="small-button is-primary" data-action="settings-import-confirm" ${busy?'disabled':''}>确认合并</button><button class="small-button" data-action="settings-import-cancel">取消</button></div>`:''}${exportReady?ui`<p><a href="/api/settings/export?download=1" download="Melo-workspace.json">保存资料文件</a> · 浏览器没有弹出下载时，可点击这里。</p>`:''}<h3>临时解析缓存</h3><p>${cache?`${cache.files} 个缓存文件 · ${(cache.bytes/1024/1024).toFixed(1)} MB`:t("可清理自动生成的网页和媒体解析缓存。")} 聊天、头像、附件原件、模型连接和记忆保留。</p><button class="small-button" data-action="settings-cache-clear" ${busy?'disabled':''}>清理解析缓存</button><h3>跨设备同步</h3>${data.syncPendingPersonas?.length ? ui`<p role="status">部分 Agent 人设或关联配置尚未同步：旧版协议无法无损表示。全文已保留在本机，其他聊天继续同步。</p><ul>${data.syncPendingPersonas.map(row=>`<li>${esc(row.name || row.id)}</li>`).join('')}</ul>` : ''}<p>当前没有 Melo 云账号。已有私人同步仍按原配置运行；不会因更换头像自动上传资料。</p><button class="small-button" data-action="settings-conflicts">查看同步冲突</button>`;
  if(tab==='about')body=ui`<div class="local-about"><span class="neural-brand-mark">✳</span><h2>Melo</h2><p>你的个人 AI 工作空间</p><p>${nativeState?`桌面版本 ${esc(nativeState.version)} · 构建 ${esc(nativeState.build)}`:t("本地网页工作区")}</p></div><p>当前为本地测试版本，通过安装新版本更新。在线更新服务尚未配置。</p><button class="small-button" data-action="settings-diagnostics">复制基础诊断信息</button><p>诊断仅包含应用版本、浏览器版本和记录数量，不包含聊天正文与密钥。</p><h3>本次更新</h3><p>本地个人资料、头像与常用偏好；可迁移资料导入导出；设备权限入口。</p>`;
  if(editableTabs.has(tab)) body=renderEditActions(edit(),{disabled:busy})+ui`<fieldset ${!edit().editing||busy?'disabled':''}>${body}</fieldset>`;
  return ui`<section class="local-settings"><header><span class="eyebrow">YOUR WORKSPACE</span><h1>系统设置</h1><p>让 Melo 更适合你的使用习惯。</p></header><nav class="local-settings-tabs" aria-label="设置分类">${sections.map(([id,label])=>ui`<button class="small-button ${tab===id?'is-primary':''}" data-action="settings-tab" data-tab="${id}" aria-pressed="${tab===id}">${t(label)}</button>`).join('')}</nav><div class="local-settings-card" aria-busy="${busy}"><h2>${t(sections.find(x=>x[0]===tab)?.[1])}</h2>${error?ui`<p role="alert" class="local-error">${esc(error)}</p>`:''}${notice?ui`<p role="status" class="local-notice">${esc(t(notice))}</p>`:''}${body}${navigation}</div><div class="local-settings-links"><button class="small-button" data-action="open-view" data-view="model">模型连接与用量</button><button class="small-button" data-action="open-customize-section" data-section="advanced">工具与任务</button><button class="small-button" data-action="open-customize-section" data-section="safety">安全与权限</button></div></section>`;
}
export function installLocalSettings(options) {
  deps=options;
  window.addEventListener('melo-local-settings',event=>{const {requestID,error:failure,...value}=event.detail||{};const pending=requests.get(requestID);if(!pending)return;clearTimeout(pending.timer);requests.delete(requestID);failure?pending.reject(new Error(failure)):pending.resolve(value);});
  // The native shell raises this when the desktop pet quits on its own: re-read the device state so the switch shows the truth.
  window.addEventListener('melo-local-settings-changed',()=>{if(!bridge())return;nativeSettings('getLocalSettings').then(value=>{nativeState=value;if(draft?.native){draft.native.desktopPet=value.desktopPet;draft.native.desktopPetRunning=value.desktopPetRunning;}deps.render();}).catch(()=>{});});
  const paintStatus=()=>{const bar=document.querySelector('.local-settings .settings-edit-toolbar');paintEditActions(bar,edit(),{disabled:busy});};
  const perform=async fn=>{busy=true;notice=error='';deps.render();try {await fn();}catch(e){error=e.message;}finally{busy=false;deps.render();}};
  const save=async()=>{
    const session=edit(); if(busy||!session.start())return;
    const currentTab=tab, value=structuredClone(draft); busy=true;notice=error='';deps.render();
    const steps=[];
    const add=(label,run)=>steps.push({label,run});
    session.appliedLabels ||= [];
    try {
      if(currentTab==='profile') {
        add(t("个人资料"),async()=>deps.applyBootstrap(await deps.api('/api/settings/local',{method:'POST',body:{name:value.profile.name,avatarData:value.profile.avatarData||''}})));
      } else {
        const current=normalizeLocalPreferences(deps.uiState.bootstrap.settings?.localPreferences);
        const keys=currentTab==='voice'?['voiceLanguage']:['interfaceLanguage','textSize','motion','autoCollapse','sendShortcut','restoreSession'];
        const preferences=Object.fromEntries(keys.filter(k=>value.prefs[k]!==current[k]).map(k=>[k,value.prefs[k]]));
        if(Object.keys(preferences).length)add(currentTab==='voice'?t("语音输入语言"):'界面与操作偏好',async()=>deps.applyBootstrap(await deps.api('/api/settings/local',{method:'POST',body:{preferences}})));
        const labels={launchAtLogin:'开机启动',closeBehavior:'关闭窗口行为',notifications:'系统通知',desktopPet:'桌面宠物'};
        if(currentTab==='general'&&nativeState) for(const key of Object.keys(labels)) {
          if(value.native[key]!==nativeState[key])add(labels[key],async()=>{nativeState=await nativeSettings('setLocalSettings',{key,value:value.native[key]});});
        }
        if(currentTab==='voice' && value.autoSpeak!==!!deps.uiState.ttsAutoPlay) add('自动朗读',async()=>{
          localStorage.setItem('melo-tts-autoplay',value.autoSpeak?'1':'0');deps.uiState.ttsAutoPlay=value.autoSpeak;if(!value.autoSpeak)deps.stopSpeech();
        });
      }
      session.appliedLabels=session.appliedLabels.filter(label=>!steps.some(step=>step.label===label));
      for(const step of steps) { await step.run(); if(!session.appliedLabels.includes(step.label))session.appliedLabels.push(step.label); }
      session.saved();draft=null;notice="修改已保存在本机。";session.appliedLabels=[];
    }catch(e){
      const pending=steps.filter(step=>!session.appliedLabels.includes(step.label)).map(step=>step.label).join('、');
      session.failed(e);
      error=session.appliedLabels.length ? t('已保存：{applied}。尚未完成：{pending}。重试只保存剩余修改；放弃只丢弃未保存部分。',{applied:session.appliedLabels.join('、'),pending}) : t("未完成保存，修改内容已保留。请重试。");
    }
    finally{busy=false;deps.render();}
  };
  document.addEventListener('input',event=>{
    if(event.target.name!=='localName')return;
    if(!edit().editing)return;
    draft.profile.name=event.target.value;edit().change();paintStatus();
  });
  document.addEventListener('submit',event=>{
    if(!event.target.matches('[data-local-form]'))return;event.preventDefault();event.stopImmediatePropagation();save();
  },true);
  document.addEventListener('change',event=>{
    const el=event.target;
    if(!el.matches('[data-local-pref],[data-local-avatar],[data-local-import],[data-local-native],[data-local-autospeak]'))return;
    event.stopImmediatePropagation();
    if(el.hasAttribute('data-local-import')) {
      perform(async()=>{const file=el.files[0];if(!file)return;if(file.size>16*1024*1024)throw new Error(t("资料文件超过 16 MB。"));const archive=JSON.parse(await file.text());const summary=await deps.api('/api/settings/import-preview',{method:'POST',body:archive});pendingImport={archive,summary};});return;
    }
    if(busy||!edit().editing)return;
    if(el.hasAttribute('data-local-avatar')) {
      perform(async()=>{const file=el.files[0];if(!file)return;draft.profile.avatarData=await readAgentAvatar(file);edit().change();notice="头像仅预览，保存后生效。";});return;
    }
    if(el.hasAttribute('data-local-autospeak'))draft.autoSpeak=el.checked;
    else if(el.dataset.localNative)draft.native[el.dataset.localNative]=el.type==='checkbox'?el.checked:el.value==='true'?true:el.value==='false'?false:el.value;
    else draft.prefs[el.dataset.localPref]=el.type==='checkbox'?el.checked:el.value;
    const label=el.dataset.localPref?(tab==='voice'?t("语音输入语言"):'界面与操作偏好'):el.dataset.localNative?({launchAtLogin:'开机启动',closeBehavior:'关闭窗口行为',notifications:'系统通知',desktopPet:'桌面宠物'}[el.dataset.localNative]):'自动朗读';
    edit().appliedLabels=(edit().appliedLabels||[]).filter(item=>item!==label);
    edit().change();paintStatus();
  },true);
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-action^="settings-"]');if(!el)return;event.preventDefault();event.stopImmediatePropagation();const action=el.dataset.action;
    if(busy)return;
    if(action==='settings-edit') {edit().begin();edit().appliedLabels=[];draft={profile:{...deps.uiState.bootstrap.profile},prefs:normalizeLocalPreferences(deps.uiState.bootstrap.settings?.localPreferences),native:{...nativeState},autoSpeak:!!deps.uiState.ttsAutoPlay};notice=error='';deps.render();return;}
    if(action==='settings-cancel') {const applied=edit().appliedLabels||[];edit().cancel();draft=null;document.querySelector('.local-settings fieldset')?.remove();notice=applied.length?t('已放弃未保存部分。已保存的{applied}仍然生效。',{applied:applied.join('、')}):t("已取消修改。");edit().appliedLabels=[];error='';deps.render();return;}
    if(action==='settings-save'){save();return;}
    if(action==='settings-avatar-pick'){if(edit().editing)document.querySelector('[data-local-avatar]')?.click();return;}
    if(action==='settings-import-pick'){document.querySelector('[data-local-import]')?.click();return;}
    if(action==='settings-tab') {if(edit().dirty){notice="请先保存或取消当前修改，再切换分类。";deps.render();return;}edit().cancel();draft=null;tab=el.dataset.tab;notice=error='';deps.render();return;}
    if(action==='settings-open'){deps.patchSettings({activeView:'settings'});return;}
    if(action==='settings-avatar-remove'){if(!edit().editing)return;draft.profile.avatarData='';edit().change();notice="头像仅预览，保存后生效。";deps.render();return;}
    if(action==='settings-import-cancel'){pendingImport=null;deps.render();return;}
    if(action==='settings-voice-options'){deps.openVoice();return;}
    perform(async()=>{
      if(action==='settings-export') {const archive=await deps.api('/api/settings/export');await downloadArchive(archive);exportReady=!bridge();notice=bridge()?t("资料文件已保存。"):t("已请求浏览器下载，可在下载列表中查看。");}
      if(action==='settings-import-confirm'&&pendingImport){await deps.api('/api/settings/import',{method:'POST',body:pendingImport.archive});pendingImport=null;await deps.reload();notice="资料已合并，现有模型连接和设备权限保留。";}
      if(action==='settings-cache-clear'){const result=await deps.api('/api/settings/cache/clear',{method:'POST',body:{}});cache=await deps.api('/api/settings/cache');notice=t('已清理 {count} 个解析缓存。',{count:result.removed});}
      if(action==='settings-conflicts'){const panel=document.querySelector('.sync-conflicts');if(panel){panel.open=true;panel.scrollIntoView({block:'nearest'});}else notice="当前没有同步冲突。";}
      if(action==='settings-login-items')await nativeSettings('openLoginItems');
      if(action==='settings-microphone')await nativeSettings('openMicrophoneSettings');
      if(action==='settings-diagnostics'){await navigator.clipboard.writeText(JSON.stringify({app:'Melo',version:nativeState?.version||'web',build:nativeState?.build||'',userAgent:navigator.userAgent,chats:deps.uiState.bootstrap.chats?.length||0,roles:deps.uiState.bootstrap.customize?.agents?.length||0},null,2));notice="基础诊断信息已复制，可粘贴给反馈接收人。";}
    });
  },true);
}
async function downloadArchive(value){
  const text=JSON.stringify(value,null,2),name=`Melo-资料-${new Date().toISOString().slice(0,10)}.json`;
  if(bridge()){const result=await nativeSettings('savePortableArchive',{text,name});if(result.cancelled)throw new Error(t("已取消导出。"));return;}
  const a=document.createElement('a');a.href='/api/settings/export?download=1';a.download=name;document.body.append(a);a.click();a.remove();
}
