// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderCapabilityChoices} from './capabilityChoices.js';
import {buildAgentProfilePatch} from './agentProfilePatch.js';
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
test('allowlist choices preserve unavailable IDs, escape labels and support multiple/empty selections',()=>{
 const html=renderCapabilityChoices('cap_mcpServers','MCP 服务白名单',['gone','one'],[{id:'one',name:'<unsafe>'},{id:'two',name:'Two'}],esc);
 assert.match(html,/value="gone" checked/);assert.match(html,/当前不可用/);assert.match(html,/&lt;unsafe>/);assert.doesNotMatch(html,/<unsafe>/);
 const form={elements:{namedItem:()=>null}},fd=new FormData();fd.set('capabilityVersion','1');fd.set('cap_mcpServers__choices','1');fd.append('cap_mcpServers','gone');fd.append('cap_mcpServers','two');fd.set('delegateTargets__choices','1');fd.append('delegateTargets','research');fd.append('delegateTargets','reviewer');
 let patch=buildAgentProfilePatch(form,fd);assert.deepEqual(patch.capabilities.mcpServers,['gone','two']);assert.deepEqual(patch.collaboration.delegateTargets,['research','reviewer']);
 fd.delete('cap_mcpServers');fd.delete('delegateTargets');patch=buildAgentProfilePatch(form,fd);assert.deepEqual(patch.capabilities.mcpServers,[]);assert.deepEqual(patch.collaboration.delegateTargets,[]);
});
// Settings audit 2026-11-10: a skill or connector ticked for the Agent is only offered
// while it is also switched on for the whole app; the list did not say when it was not.
test('a choice switched off for the whole app is marked, and an unavailable one keeps its own mark',()=>{
 const html=renderCapabilityChoices('cap_skills','技能白名单',['off','gone'],[{id:'on',name:'On'},{id:'off',name:'Off',switchedOff:true},{id:'idle',name:'Idle',switchedOff:false}],esc);
 const label=id=>html.match(new RegExp(`<label[^>]*><input[^>]*value="${id}"[^>]*>[\\s\\S]*?</label>`))[0];
 assert.match(label('off'),/全局未启用/);assert.match(label('off'),/title="在技能或连接器页面启用后，这里的勾选才生效"/);
 assert.doesNotMatch(label('on'),/chip/);assert.doesNotMatch(label('idle'),/chip/);
 assert.match(label('gone'),/当前不可用/);assert.doesNotMatch(label('gone'),/全局未启用/);
});
