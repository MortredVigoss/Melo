import { setLanguage } from './desktop-ui/i18n.js';
import { renderExecutionPanel, syncExecutionPanel, receiveExecutionScene } from './desktop-ui/executionPanel.js';
import './desktop-ui/executionScene3D.js';
let previewStarted=false;
let snapshot = { chat: {id: '', messages: []}, scenes: [] };
const loadedSceneIDs = new Set();
const compare = (a,b) => a===b ? 0 : a<b ? -1 : 1;
function historyPage(params) {
  const runId=params.get('runId');
  let before;
  if(params.has('before')) {
    before=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(params.get('before').replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));
    if(typeof before?.createdAt!=='string' || typeof before?.runId!=='string') throw new Error('Invalid history cursor');
  }
  const rows=snapshot.scenes.filter(scene=>scene.chatId===snapshot.chat.id && (runId ? scene.runId===runId : !before || scene.startedAt<before.createdAt || (scene.startedAt===before.createdAt && scene.runId<before.runId)))
    .sort((a,b)=>compare(b.startedAt,a.startedAt)||compare(b.runId,a.runId));
  const scenes=rows.slice(0,runId ? 1 : 20), last=scenes.at(-1);
  const cursor=!runId && rows.length>20 ? JSON.stringify({createdAt:last.startedAt,runId:last.runId}) : null;
  const nextCursor=cursor ? btoa(String.fromCharCode(...new TextEncoder().encode(cursor))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') : null;
  return {scenes,nextCursor};
}
// The desktop view's read-only history request resolves from phone storage.
// Nothing in this WebView can call the desktop or make model/tool requests.
window.fetch = async (input,options={}) => {
  const url=new URL(String(input),'https://melo.invalid');
  if (url.origin==='https://melo.invalid' && url.pathname==='/api/chat/scenes') {
    if((options.method || 'GET').toUpperCase()!=='GET') return new Response('{}',{status:405});
    if(url.searchParams.get('chatId')!==snapshot.chat.id) return new Response('{}',{status:404});
    try {
      const page=historyPage(url.searchParams);
      page.scenes.forEach(scene=>loadedSceneIDs.add(scene.runId));
      return new Response(JSON.stringify(page),{status:200,headers:{'Content-Type':'application/json'}});
    } catch { return new Response('{"error":"Invalid history cursor"}',{status:400}); }
  }
  return new Response('{"error":"此操作尚未在手机接入"}', {status:403});
};
const bridge = payload => window.__meloPost ? window.__meloPost(payload) : window.webkit?.messageHandlers?.meloScene?.postMessage(payload);
let renderAcknowledged=false;
function acknowledgeRender(attempt=0) {
  if(renderAcknowledged) return;
  const panel=document.querySelector('#execution-panel'), stage=document.querySelector('.execution-panel-stage');
  const frames=document.querySelector('.execution-webgl')?.dataset.frames;
  const fallback=panel?.classList.contains('is-fallback');
  if(panel && !panel.hidden && stage?.clientHeight>0 && (Number(frames)>0 || fallback)) {
    renderAcknowledged=true;
    bridge({type:'rendered',frames:frames||'0',fallback,modules:document.querySelectorAll('.execution-module').length});
  } else if(attempt<40) setTimeout(()=>acknowledgeRender(attempt+1),200);
}
let restoring=false;
const originalSetItem=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value) {
  originalSetItem.call(this,key,value);
  if(!restoring && key.startsWith('melo-scene-view:')) {
    try { bridge({type:'view',runID:key.slice(16),value:JSON.parse(value)}); } catch {}
  }
};
document.querySelector('#app').innerHTML = renderExecutionPanel();
window.meloReceive = value => {
  setLanguage(value.interfaceLanguage);
  if(snapshot.chat.id!==value.chat.id) loadedSceneIDs.clear();
  snapshot = value;
  restoring=true;
  for(const [id,view] of Object.entries(value.views||{})) { try { localStorage.setItem(`melo-scene-view:${id}`,JSON.stringify(view)); } catch {} }
  restoring=false;
  // This is a full-screen workspace: keep the result visible until the user leaves.
  syncExecutionPanel({chat: value.chat, still: value.still, autoCollapse:false});
  // Reserve a touch-control row outside the reading viewport. On a phone a
  // sticky overlay can cover the last source; clipping must not hide content.
  const panel=document.querySelector('#execution-panel');
  const zoomControls=panel.querySelector('.execution-panel-viewport > .execution-zoom');
  if(zoomControls) panel.insertBefore(zoomControls,panel.querySelector('.execution-panel-footer'));
  historyPage(new URLSearchParams()).scenes.forEach(scene=>loadedSceneIDs.add(scene.runId));
  value.scenes.filter(scene=>scene.chatId===value.chat.id && (loadedSceneIDs.has(scene.runId) || scene.runId===value.runId || ['queued','running','waiting'].includes(scene.status))).forEach(scene=>{ loadedSceneIDs.add(scene.runId); receiveExecutionScene(scene); });
  const latest = value.runId || historyPage(new URLSearchParams()).scenes[0]?.runId;
  if (latest && document.querySelector('#execution-panel').classList.contains('is-collapsed')) {
    const button = document.createElement('button'); button.dataset.executionAction='replay'; button.dataset.run=latest;
    document.body.append(button); button.click(); button.remove();
  } else if (!latest && document.querySelector('#execution-panel').classList.contains('is-collapsed')) {
    document.querySelector('[data-execution-action="toggle"]')?.click();
  }
  acknowledgeRender();
  if (value.preview && !previewStarted) {
    previewStarted=true;
    if(value.preview==='sources') setTimeout(()=>document.querySelector('[data-module="search"]')?.click(),500);
    setTimeout(()=>bridge({type:'testReport',fallback:document.querySelector('#execution-panel').classList.contains('is-fallback'),modules:document.querySelectorAll('.execution-module').length,sources:document.querySelectorAll('.execution-source').length,frames:document.querySelector('.execution-webgl')?.dataset.frames,mode:document.querySelector('.execution-webgl')?.dataset.mode}),1800);
  }
};
document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (link) {
    event.preventDefault(); event.stopImmediatePropagation();
    const url = new URL(link.href);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) bridge({type:'openURL',url:url.href});
  }
  if (event.target.closest('[data-action="toggle-tts-autoplay"]')) bridge({type:'speechSettings'});
}, true);
// iPhone native pinch is localized to the scene, preserving result-list scrolling.
let pinchDistance = 0, pinchZoom = 1;
const distance = touches => Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
document.addEventListener('touchstart', event => {
  if(event.touches.length===2 && event.target.closest('.execution-panel-stage') && !event.target.closest('.execution-inspector')) {
    // A two-finger gesture must cancel the first finger's pending cluster tap,
    // even when the fingers lift before moving far enough to trigger zoom.
    document.querySelector('.execution-webgl canvas')?.dispatchEvent(new window.Event('pointercancel'));
    pinchDistance=distance(event.touches); pinchZoom=Number(document.querySelector('.execution-panel-stage').dataset.zoom)||1;
  }
},{passive:true});
document.addEventListener('touchmove', event => {
  if(event.touches.length!==2 || !pinchDistance) return;
  event.preventDefault();
  const target=pinchZoom*distance(event.touches)/pinchDistance;
  const current=Number(document.querySelector('.execution-panel-stage').dataset.zoom)||1;
  document.querySelector('.execution-panel-stage').dispatchEvent(new WheelEvent('wheel',{deltaY:-Math.log(target/current)/.009,ctrlKey:true,bubbles:true,cancelable:true}));
},{passive:false});
document.addEventListener('touchend',()=>{pinchDistance=0;},{passive:true});
document.addEventListener('touchcancel',()=>{pinchDistance=0;},{passive:true});
window.addEventListener('error',()=>bridge({type:'renderError'}));
window.addEventListener('unhandledrejection',()=>bridge({type:'renderError'}));
bridge({type:'ready'});
