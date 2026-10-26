// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from './i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { modelLabel, modelPanelPosition, conversationAgents, conversationAgent, conversationConnectionReady, renderModelPicker, renderModelReceipt, connectionModelOptions, renderDefaultModelSettings } from './modelPresentation.js';

test('conversation role resolution ignores editor scope and follows existing or draft project',()=>{
 const global=[{id:'main',name:'Global',model:'global-model'}],project=[{id:'main',name:'Project',model:'project-model'}];
 const data={activeChat:{agentId:'main',projectId:'p'},customize:{agents:global},conversationProfiles:{global,projects:{p:project}}};
 assert.equal(conversationAgent(data).model,'project-model');
 assert.equal(conversationAgent(data,{overview:true,newProjectId:null}).model,'global-model');
 assert.equal(conversationAgent(data,{overview:true,newProjectId:'p'}).model,'project-model');
});

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dom = html => new JSDOM(html).window.document;

test('system and connection model choices reuse the active catalog without leaking it to another API provider', () => {
  const config = {authMode:'codex', model:'gpt-6.1-sol', modelCatalogs:{codex:['gpt-6.1-sol','gpt-6-astra']}, availableModels:['gpt-6-astra','custom-model']};
  assert.deepEqual(connectionModelOptions(config),['gpt-6.1-sol','gpt-6-astra','custom-model']);
  const document=dom(renderDefaultModelSettings(config,escape));
  assert.equal(document.querySelector('select').value,'gpt-6.1-sol');
  assert.match(document.querySelector('select').textContent,/Astra 6/);
  const api={authMode:'api-key',baseUrl:'https://a.invalid',model:'a-model',availableModels:['a-2'],modelCatalogs:{'api-key':['a-3']},llmConnections:{activeId:'a'}};
  assert.deepEqual(connectionModelOptions(api,{id:'b',authMode:'api-key',baseUrl:'https://b.invalid',model:'b-model',models:['b-2']}),['b-2','b-model']);
  assert.deepEqual(connectionModelOptions({...api,modelCatalogs:{codex:config.modelCatalogs.codex}},{id:'chatgpt',authMode:'codex',model:'gpt-6.1-sol'}),['gpt-6.1-sol','gpt-6-astra']);
});

test('model names are concise without substituting custom IDs', () => {
  assert.equal(modelLabel('gpt-6.1-sol'), 'Sol 6.1');
  assert.equal(modelLabel('gpt-6-astra'), 'Astra 6');
  assert.equal(modelLabel('local/my-model:v2'), 'local/my-model:v2');
});

test('model popup stays inside narrow and short windows at either screen edge', () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 700, height: 320 }]) {
    const panel = { width: Math.min(320, viewport.width - 32), height: Math.min(460, viewport.height - 40) };
    for (const anchor of [{ top: 10, bottom: 40, right: 110 }, { top: viewport.height - 50, bottom: viewport.height - 15, right: viewport.width - 12 }]) {
      const position = modelPanelPosition(anchor, panel, viewport);
      assert.ok(position.left >= 16 && position.left + panel.width <= viewport.width - 16);
      assert.ok(position.top >= 16 && position.top + panel.height <= viewport.height - 16);
    }
  }
});

test('chat agent comes from the conversation, not the settings editor selection', () => {
  const data = { activeChat: { agentId: 'builder' }, settings: { selectedAgentId: 'research' }, customize: { agents: [{ id: 'main' }, { id: 'builder' }, { id: 'research' }] } };
  assert.equal(conversationAgent(data).id, 'builder');
  assert.equal(conversationAgent(data, { overview: true, newAgentId: 'research' }).id, 'research');
});

test('picker retains custom model IDs, indicates default and role override, and escapes markup', () => {
  const custom = 'local/<img src=x onerror=alert(1)>';
  const document = dom(renderModelPicker({ config: { model: custom, authMode: 'local' }, models: ['gpt-6.1-sol', custom], agent: { name: 'Builder', model: 'gpt-6-astra' }, open: true }, escape));
  assert.equal(document.querySelector('[aria-pressed=true]').dataset.model, '');
  assert.match(document.querySelector('.model-picker-trigger').textContent, /Astra 6/);
  assert.ok([...document.querySelectorAll('[data-model]')].some(el=>el.dataset.model===custom));
  assert.match(document.querySelector('.model-picker-trigger').textContent, /默认/);
  assert.match(document.querySelector('.model-picker-context').textContent, /Builder 单独指定了 Astra 6/);
  assert.equal(document.querySelectorAll('img').length, 0);
});

test('missing or malformed receipts never fabricate actual-model evidence', () => {
  for (const value of [undefined, {}, []]) assert.equal(renderModelReceipt({ role: 'assistant', metadata: { modelResponses: value } }, escape), '');
  const text = dom(renderModelReceipt({ id: 'a', role: 'assistant', metadata: { modelResponses: [{ requestedModel: 'gpt-6.1-sol', reportedModel: '' }] } }, escape)).body.textContent;
  assert.match(text, /未提供模型标识/);
  assert.match(text, /未验证/);
  assert.doesNotMatch(text, /返回一致/);
});

test('reply history distinguishes reported, mismatched, multiple and simulated calls', () => {
  const message = { id: 'receipt', role: 'assistant', metadata: { runId: 'run-1', modelResponses: [
    { requestedModel: 'gpt-6.1-sol', reportedModel: 'gpt-6-astra' },
    { requestedModel: 'gpt-6.1-sol', reportedModel: 'gpt-6.1-sol', simulated: true },
  ] } };
  const document = dom(renderModelReceipt(message, escape));
  assert.equal(document.querySelectorAll('.model-receipt-row').length, 2);
  assert.match(document.querySelector('summary').textContent, /模拟回复/);
  assert.match(document.body.textContent, /返回不同模型/);
  assert.match(document.body.textContent, /模拟 · 未验证真实模型/);
  assert.equal(renderModelReceipt({ ...message, role: 'user' }, escape), '');
});

test('conversation model overrides role model while exposing saved connections',()=>{
 const document=dom(renderModelPicker({config:{model:'first',llmConnections:{activeId:'a',profiles:[{id:'b',name:'Other',model:'second'}]}},models:['first'],agent:{name:'Writer',model:'role'},selection:{profileId:'b',model:'second'},open:true},escape));
 assert.match(document.querySelector('.model-picker-trigger').textContent,/second/);
 assert.equal(document.querySelector('[aria-pressed=true]').dataset.profileId,'b');
});

test('a configured per-chat provider can be used when the global default is not connected',()=>{
 const config={hasCredentials:false,codexAuth:{loggedIn:true},llmConnections:{profiles:[{id:'api',authMode:'api-key',hasKey:true},{id:'oauth',authMode:'codex',hasKey:false}]}};
 assert.equal(conversationConnectionReady(config,null),false);
 assert.equal(conversationConnectionReady(config,{profileId:'api'}),true);
 assert.equal(conversationConnectionReady(config,{profileId:'oauth'}),true);
 assert.equal(conversationConnectionReady(config,{profileId:'gone'}),false);
});

test('synced model binds by provider endpoint after this device adds its own connection',()=>{
 const choice={profileId:'unconnected-sync',model:'chosen',portable:{connectionID:'remote',authMode:'api-key',baseURL:'https://provider.invalid/v1',apiProtocol:'anthropic'}};
 assert.equal(conversationConnectionReady({llmConnections:{profiles:[{id:'local',baseUrl:'https://provider.invalid/v1',authMode:'api-key',apiProtocol:'anthropic',hasKey:true}]}},choice),true);
 assert.equal(conversationConnectionReady({llmConnections:{profiles:[{id:'remote',baseUrl:'https://other.invalid/v1',authMode:'api-key',apiProtocol:'anthropic',hasKey:true}]}},choice),false);
});

test('project role overrides retain the default and all custom role choices',()=>{
 const data={activeChat:{projectId:'p',agentId:'custom'},conversationProfiles:{global:[{id:'main',name:'Melo'},{id:'custom',name:'Custom'}],projects:{p:[{id:'custom',name:'Project custom'}]}}};
 assert.deepEqual(conversationAgents(data).map(a=>a.id),['main','custom']);
 assert.equal(conversationAgent(data).name,'Project custom');
 data.conversationProfiles.projects.p=[];
 assert.equal(conversationAgent(data).name,'Custom');
});
