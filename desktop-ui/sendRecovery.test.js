import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTurnPresentation, receiveTurnPresentation } from './turnPresentation.js';
const source=readFileSync(new URL('./features/chat/controller.js',import.meta.url),'utf8');
const send=source.slice(source.indexOf('async function handleSendMessage('),source.indexOf('\nfunction handleStopSending'));
function fixture(stream) {
  let serial=0;
  const uiState={composer:'hello',composerAttachments:[{id:'audio',kind:'audio'}],composerVoiceTranscript:'spoken text',composerVoiceAttachmentId:'audio',bootstrap:{settings:{selectedChatId:'chat',activeMode:'chat'},chats:[{id:'chat',agentId:'main'}]},pendingToolPermissions:[],activeToolCalls:[]};
  const noop=()=>{};
  const ctx={uiState,crypto:{randomUUID:()=>`request-${++serial}`},AbortController,Date,JSON,createTurnPresentation,receiveTurnPresentation,
    voiceInputActive:()=>false,handleComposerCommand:async()=>false,consumeImageTask:()=>null,createReplyDelivery:()=>({}),cloneBootstrapState:structuredClone,
    resetStreamingAssistant:noop,resetComposerHistoryNavigation:noop,applyOptimisticUserMessage:noop,render:noop,_isTtsActive:()=>false,
    streamApi:stream,receiveExecutionScene:noop,receiveReplyDelivery:()=>({}),_streamTtsPushChunk:noop,_streamTtsOnToolCall:noop,renderStreamingFast:()=>true,
    notifyLocalCompletion:noop,applyBootstrap:noop,loadBootstrap:async()=>{},isAbortError:e=>e.name==='AbortError',restoreImageTask:noop,showError:noop,
    api:async()=>{},_streamTtsReset:noop,activeChat:()=>uiState.bootstrap.chats[0],setTimeout:noop,bgRender:noop};
  vm.createContext(ctx);vm.runInContext(send+'\nthis.send=handleSendMessage;',ctx);return ctx;
}
test('parallel tool permissions stay independently answerable',async()=>{
 let pending;const f=fixture(async(_,{onEvent})=>{for(const requestId of ['one','two','two'])onEvent({event:'tool_permission',payload:{requestId,toolId:'pdf',args:{}}});pending=Array.from(f.uiState.pendingToolPermissions,p=>p.requestId);return {};});
 await f.send();assert.deepEqual(pending,['one','two']);
});
test('disconnect preserves voice transcript and unchanged resend reuses request identity',async()=>{
 const sent=[];const f=fixture(async(_,o)=>{sent.push(o.body);throw Object.assign(new Error('disconnect'),{code:'STREAM_INTERRUPTED'});});
 await f.send();assert.equal(f.uiState.composerVoiceTranscript,'spoken text');assert.equal(f.uiState.composerVoiceAttachmentId,'audio');
 await f.send();assert.equal(sent[0].requestId,sent[1].requestId);assert.deepEqual(sent[0].extractedMedia,sent[1].extractedMedia);
 f.uiState.composer='changed';await f.send();assert.notEqual(sent[2].requestId,sent[1].requestId);
});

test('a new chat created before a disconnect remains the retry target even when refresh also fails',async()=>{
 const sent=[];const f=fixture(async(_,o)=>{sent.push(o.body);throw new Error('network');});
 f.uiState.neuralOverview=true;f.uiState.bootstrap={settings:{selectedChatId:null,activeMode:'chat'},chats:[]};
 f.handleCreateChat=async()=>{f.uiState.bootstrap={settings:{selectedChatId:'created-chat',activeMode:'chat'},chats:[{id:'created-chat',agentId:'main'}]};};
 f.loadBootstrap=async()=>{throw new Error('still offline');};
 await f.send();assert.equal(f.uiState.bootstrap.settings.selectedChatId,'created-chat');await f.send();
 assert.equal(sent[0].chatId,sent[1].chatId);assert.equal(sent[0].requestId,sent[1].requestId);
});

test('completed delivery clears retry identity; a deliberate new message gets a new id',async()=>{
 const sent=[];let failing=true;const f=fixture(async(_,o)=>{sent.push(o.body);if(failing)throw new Error('disconnect');return {};});
 await f.send();failing=false;await f.send();assert.equal(f.uiState.composerRetry,null);
 f.uiState.composer='hello';await f.send();assert.notEqual(sent[1].requestId,sent[2].requestId);
});
