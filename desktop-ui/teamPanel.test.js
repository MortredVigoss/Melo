import test from 'node:test';
import assert from 'node:assert/strict';
import {renderTeamPanel, teamLeadState, collectTeamPlan} from './teamPanel.js';
import {buildAgentProfilePatch} from './agentProfilePatch.js';
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const agents=[{id:'main',name:'Main'},{id:'research',name:'调研员'},{id:'reviewer',name:'<Rev>'},{id:'other',name:'Other'}];
const lead=(delegate,canDelegate,targets)=>({id:'main',name:'Main',capabilities:{delegate},collaboration:{canDelegate,delegateTargets:targets}});

test('panel explains why a team is unavailable instead of offering a run button',()=>{
 for(const [l,reason,text] of [[lead(false,true,['research']),'delegate-off',/未开启委派/],[lead(true,false,['research']),'delegate-off',/未开启委派/],[lead(true,true,[]),'no-targets',/还没有可协作的 Agent/],[lead(true,true,['gone']),'no-targets',/还没有可协作的 Agent/]]){
  assert.equal(teamLeadState(l,agents).reason,reason);
  const html=renderTeamPanel({scope:'chat',lead:l,agents,escapeHtml:esc});
  assert.match(html,text);assert.doesNotMatch(html,/run-chat-team/);assert.match(html,/data-action="select-agent-profile" data-agent-id="main"/);
 }
});

test('panel offers only the lead\'s delegation targets, by name, escaped, preselecting a saved plan',()=>{
 const html=renderTeamPanel({scope:'task',target:'t1',lead:lead(true,true,['reviewer','research']),agents,plan:{templateId:'review-loop',members:['research']},escapeHtml:esc});
 assert.deepEqual([...html.matchAll(/name="team-member" value="([^"]+)"/g)].map(m=>m[1]),['reviewer','research']);
 assert.doesNotMatch(html,/value="other"/);assert.match(html,/&lt;Rev>/);assert.doesNotMatch(html,/<Rev>/);
 assert.match(html,/value="research" checked/);assert.doesNotMatch(html,/value="reviewer" checked/);
 assert.match(html,/value="review-loop" selected/);assert.match(html,/data-action="run-task-team" data-task-id="t1"/);
});

test('collected plan keeps list order and rejects empty or wrongly sized review loops',()=>{
 const panel=(checked,template)=>({querySelectorAll:()=>checked.map(([value,c])=>({value,checked:c})),querySelector:()=>({value:template})});
 assert.deepEqual(collectTeamPlan(panel([['b',true],['a',false],['c',true]],'parallel-research')).plan,{templateId:'parallel-research',members:['b','c']});
 assert.match(collectTeamPlan(panel([['a',false]],'research-build-review')).error,/至少勾选一位/);
 assert.match(collectTeamPlan(panel([['a',true]],'review-loop')).error,/正好勾选两位/);
});

test('the one delegation switch writes both stored flags',()=>{
 const form={elements:{namedItem:()=>null}};
 for(const on of [true,false]){const fd=new FormData();fd.set('capabilityVersion','1');if(on)fd.set('cap_delegate','on');fd.set('canDelegate',on?'':'on');
  const patch=buildAgentProfilePatch(form,fd);assert.equal(patch.capabilities.delegate,on);assert.equal(patch.collaboration.canDelegate,on);}
});
