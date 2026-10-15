// Isolated legacy authority for pre-scope unit fixtures. Production entry points
// must resolve real Agent state; the fail-closed tests import them directly.
import {createRequestContext} from '../runtime/requestContext.js';
import {currentRequestContext,runWithRequestContext} from '../runtime/requestScope.js';
import {executeTool as rawExecuteTool,executeToolCalls as rawExecuteToolCalls} from '../tools/executor.js';
import {runSubAgent as rawSubAgent} from '../agents/subAgent.js';
import {runSkill as rawSkill} from '../agents/skillExecutor.js';
import {runAgentTeam as rawTeam} from '../agents/team.js';
import {runConfiguredMember as rawMember} from '../agents/delegate.js';
export function withLegacyAgentFixture(work,explicit) {
 const context=explicit || currentRequestContext() || createRequestContext();
 if(context.capabilityScope || context.turnBinding?.capabilityScope)return runWithRequestContext(context,work);
 const turnBinding=context.turnBinding || {role:'main',project:null,taskId:null};
 return runWithRequestContext(Object.freeze({...context,turnBinding,capabilityScope:Object.freeze({agentId:turnBinding.role,legacy:true,capabilities:null,source:'legacy-unit-fixture'})}),work);
}
export const executeTool=(tool,args,options={})=>withLegacyAgentFixture(()=>rawExecuteTool(tool,args,options),options.requestContext);
export const executeToolCalls=(calls,options={})=>withLegacyAgentFixture(()=>rawExecuteToolCalls(calls,options),options.requestContext);
export const runSubAgent=options=>withLegacyAgentFixture(()=>rawSubAgent(options));
export const runSkill=options=>withLegacyAgentFixture(()=>rawSkill(options));
export const runAgentTeam=options=>withLegacyAgentFixture(()=>rawTeam(options));
export const runConfiguredMember=options=>withLegacyAgentFixture(()=>rawMember(options));
