import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LLM_PROVIDERS } from '../src/shared/llmProviders.js';
import { renderLlmConnections, editLlmConnection, handleLlmConnection } from './llmConnections.js';

test('connection UI preserves manual model IDs, keeps secrets provider-local, and activates only on request', async () => {
  const config = { authMode: 'codex', codexAuth: { loggedIn: true }, llmConnections: { providers: LLM_PROVIDERS, activeId: '', profiles: [] } };
  let dom, modelRequests = 0, active = '', nextId = 0, saves=0;
  const render = () => { dom = new JSDOM(renderLlmConnections(config)); };
  const api = async (url, { body }) => {
    if (url.endsWith('/save')) {saves++;
      assert.equal(body.model, 'vendor/model-not-in-catalog');
      assert.equal(body.providerId, 'deepseek');
      const profile = { ...body, hasKey: true, apiKey: undefined, revision: ++nextId };
      config.llmConnections.profiles = [profile]; return config.llmConnections;
    }
    if (url.endsWith('/test')) { modelRequests++; return { ok: true, latencyMs: 12, reportedModel: 'vendor/actual', preview: '4' }; }
    if (url.endsWith('/activate')) { active = body.id; return {}; }
    throw new Error(`Unexpected API ${url}`);
  };
  const hooks = { config, api, render, refresh: async () => {}, openUrl() { throw new Error('No OAuth requested'); }, chatgptLogin() { throw new Error('No login requested'); } };
  render();
  const select = dom.window.document.querySelector('[data-action="llm-select"]'); select.value = 'deepseek'; editLlmConnection(select, config); render();
  assert.equal(dom.window.document.querySelector('[name=model]').matches(':disabled'),true);
  await handleLlmConnection('llm-edit',hooks);
  for (const [name, value] of [['model', 'vendor/model-not-in-catalog'], ['apiKey', 'user-provided-secret']]) {
    const input = dom.window.document.querySelector(`[name="${name}"]`); input.value = value; editLlmConnection(input, config);
  }
  await handleLlmConnection('llm-save', hooks);
  assert.equal(modelRequests, 0); assert.equal(active, '');
  assert.equal(dom.window.document.querySelector('[name="apiKey"]').value, '');
  await handleLlmConnection('llm-test', hooks);
  assert.equal(modelRequests, 1); assert.equal(active, '');
  assert.match(dom.window.document.querySelector('.llm-connection-status').textContent, /vendor\/actual/);
  await handleLlmConnection('llm-activate', hooks); assert.equal(active, 'deepseek');assert.equal(saves,1);assert.equal(dom.window.document.querySelector('[name=model]').matches(':disabled'),true);
  const provider = dom.window.document.querySelector('[data-action="llm-select"]'); provider.value = 'gemini'; editLlmConnection(provider, config); render();
  assert.equal(dom.window.document.querySelector('[name="apiKey"]').value, '');
  assert.equal(dom.window.document.querySelector('[name="model"]').value, '');
  assert.match(dom.window.document.querySelector('[name="baseUrl"]').value, /googleapis/);
});

test('read-only connection refreshes revisions; editing preserves conflicts until explicit reload',async()=>{
 const {renderLlmConnections:markup,editLlmConnection:change,handleLlmConnection:act}=await import('./llmConnections.js?conflict-test');
 const config={authMode:'local',llmConnections:{providers:LLM_PROVIDERS,activeId:'local',profiles:[{id:'local',providerId:'local',baseUrl:'http://localhost:11434/v1',model:'one',revision:1}]}};
 let dom,failRefresh=false;const render=()=>{dom?.window.close();dom=new JSDOM(markup(config));};
 const hooks={config,render,refresh:async()=>{if(failRefresh)throw new Error('offline');},api:async(_url,{body})=>{assert.equal(body.revision,2);throw new Error('连接已发生变化，请刷新后重试。');}};
 render();config.llmConnections.profiles[0]={...config.llmConnections.profiles[0],model:'two',revision:2};render();assert.equal(dom.window.document.querySelector('[name=model]').value,'two');
 await act('llm-edit',hooks);const field=dom.window.document.querySelector('[name=model]');field.value='my draft';change(field,config);
 config.llmConnections.profiles[0]={...config.llmConnections.profiles[0],model:'other editor',revision:3};render();assert.equal(dom.window.document.querySelector('[name=model]').value,'my draft');
 await act('llm-save',hooks);assert.equal(dom.window.document.querySelector('[data-action=llm-save]').disabled,true);assert.ok(dom.window.document.querySelector('[data-action=llm-reload]'));
 failRefresh=true;await act('llm-reload',hooks);assert.equal(dom.window.document.querySelector('[name=model]').value,'my draft');
 failRefresh=false;await act('llm-reload',hooks);assert.equal(dom.window.document.querySelector('[name=model]').value,'other editor');assert.equal(dom.window.document.querySelector('[name=model]').matches(':disabled'),true);dom.window.close();
});
