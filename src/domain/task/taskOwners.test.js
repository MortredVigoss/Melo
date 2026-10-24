import test from 'node:test';
import assert from 'node:assert/strict';
import { taskOwner, normalizeTask } from './taskService.js';
import { validateTeamPlan, TEAM_TEMPLATES } from '../../agents/team.js';
import { collectTelegramBotAliases, hasTelegramInvokePrefix } from '../../services/remote/telegramAddressHelpers.js';
import { collectDiscordBotAliases, hasDiscordInvokePrefix } from '../../services/remote/discordParsing.js';
test('custom Agents own tasks; missing Agents are rejected rather than silently replaced',()=>{
 const state={agentProfiles:{winter:{name:'Winter'},auditor:{name:'Auditor'}},settings:{defaultAgentId:'winter'}};
 assert.equal(taskOwner(state,'auditor'),'auditor');assert.equal(taskOwner(state),'winter');
 assert.equal(normalizeTask({owner:'auditor'}).owner,'auditor');
 assert.throws(()=>taskOwner(state,'main'),{code:'TASK_OWNER_MISSING'});
 assert.throws(()=>taskOwner({agentProfiles:{},settings:{}}),{code:'TASK_OWNER_MISSING'});
 assert.equal(normalizeTask({owner:'deleted-agent'}).owner,'deleted-agent');
});
test('templates describe roles and require explicit custom members; ids do not select scheduling modes',()=>{
 assert.ok(TEAM_TEMPLATES.every(t=>!t.members&&t.roleTags.length));
 assert.throws(()=>validateTeamPlan({templateId:'research-build-review'}));
 const custom=validateTeamPlan({templateId:'research-build-review',members:['winter','auditor']});
 assert.deepEqual(custom.members,['winter','auditor']);assert.equal(custom.concurrency,1);
 assert.equal(validateTeamPlan({members:['builder','auditor'],mode:'parallel',concurrency:2}).concurrency,2);
});
test('custom channel aliases do not implicitly address the product name',()=>{
 for(const collect of [collectTelegramBotAliases,collectDiscordBotAliases]) {
  const values=collect({name:'Winter'},{botUsername:'winter_bot',nicknames:'snow'});
  assert.ok(values.includes('winter'));assert.ok(values.includes('snow'));assert.ok(!values.includes('melo'));
  assert.ok(collect({name:'Winter'},{nicknames:'melo'}).includes('melo'));
 }
});

test('product name alone is not an invoke prefix for custom agents',()=>{
 for(const has of [hasTelegramInvokePrefix,hasDiscordInvokePrefix]) {assert.equal(has('melo: hello'),false);assert.equal(has('/ask hello'),true);assert.equal(has('/melo hello'),true);}
});
