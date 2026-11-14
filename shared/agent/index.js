import { taskEvaluationOperation } from './taskEvaluation.js';
import { calculateNumber } from './arithmetic.js';
import { internalRouting } from './internalRouting.js';
import { deliveryOperation } from './limitDelivery.js';
import { getRequestNetworkPolicy, requestAllowsTool } from './retrieval/requestPolicy.js';
import { publicLookupRequest } from './retrieval/publicLookupIntent.js';
import { intentOperation } from './retrieval/intentRouter.js';
import { multilingualImageAction } from './imageLanguage.js';
import { localeOperation } from './locale.js';
import { modelCapabilityOperation } from './modelCapabilities.js';
import { PROVIDER_DEFAULTS } from './providerDefaults.js';
import { runTaskReplay } from './taskReplay.js';
import { CORE_VERSION, startTurn, advanceTurn, turnStopReply } from './turn.js';
import { planRequest, actionEvidence, resolvedRequestGoal } from './search.js';
import { toolCatalog, validateCommonTool, normalizeRuntimeConfig, normalizeSearchResponse, normalizeFetchedPage, searchRequest } from './tools.js';
import { connectionIdentity, hostedCapability, hostedSearchReceipt, hostedSearchProof } from './hostedSearch.js';
import { executionScene, executionContext, publicReasoning } from './execution.js';
import { sessionEvents } from '../../src/shared/sessionEvents.js';
import { parseReplyDocument, replyPresentation } from '../../src/shared/replyDocument.js';
import { topicDividers } from '../../src/shared/conversationTopics.js';
import { budgetOperation } from './policyBridge.js';
import { repeatOperation } from './repeatGuard.js';
import { completionResult, completionObservation, teamCompletion } from './completion.js';
import { AGENT_LOOP_CONTRACT } from './loopContract.js';
import { resolveLoopLimits } from './loopLimits.js';
import { goalOperation } from './goal.js';
import { toolEffect } from './toolEffects.js';
import { PHONE_POLICY } from './phonePolicy.js';
import { organizerCommand, ORGANIZER_TOOLS } from './organizer.js';
import { workflowCatalog, prepareWorkflowCall } from './workflows.js';
import { traceOperation, tracedStart, tracedAdvance } from './trace.js';
import { contextCost, contextPlan, contextWirePlan, historyPage } from './context.js';

export function evaluate(input) {
  try {
    if (!input || input.version !== CORE_VERSION) throw Object.assign(new Error('Unsupported Core protocol.'), { code: 'PROTOCOL_VERSION' });
    let value;
    switch (input.op) {
      case 'taskReplay': value = runTaskReplay(input.dataset); break;
      case 'requestPolicy': value = getRequestNetworkPolicy(resolvedRequestGoal(input.text, input.messages)); break;
      case 'requestToolAllowed': value = requestAllowsTool(input.tool, getRequestNetworkPolicy(resolvedRequestGoal(input.text, input.messages))); break;
      case 'lookupIntent': value = publicLookupRequest(resolvedRequestGoal(input.text, input.messages), input.messages); break;
      case 'intent': value = intentOperation(input); break;
      case 'organizerNames': value = ORGANIZER_TOOLS.map(tool => tool.name); break;
      case 'organizer': value = organizerCommand(input.command); break;
      case 'trace': value = traceOperation(input); break;
      case 'tracedStart': value = tracedStart(input.turn); break;
      case 'tracedAdvance': value = tracedAdvance(input.state, input.event, input.now); break;
      case 'hello': value = { version: CORE_VERSION, runtime: 'melo-local-core', portable: true }; break;
      case 'contextCost': value = contextCost(input.text); break;
      case 'contextPlan': value = contextPlan(input.context); break;
      case 'contextWirePlan': value = contextWirePlan(input.context); break;
      case 'historyPage': value = historyPage(input.page); break;
      case 'loopLimits': value = resolveLoopLimits(input.limits); break;
      case 'budget': value = JSON.parse(JSON.stringify(budgetOperation(input))); break;
      case 'repeat': value = repeatOperation(input); break;
      case 'completion': value = completionResult(input.completion); break;
      case 'teamCompletion': value = teamCompletion(input.team); break;
      case 'imageLanguage': value = multilingualImageAction(input.text, input.hasInputImage); break;
      case 'locale': value = localeOperation(input); break;
      case 'providerDefaults': value = PROVIDER_DEFAULTS; break;
      case 'modelCapabilities': value = modelCapabilityOperation(input); break;
      case 'loopPolicy': value = AGENT_LOOP_CONTRACT.loop; break;
      case 'delivery': value = deliveryOperation(input); break;
      case 'goal': value = goalOperation(input); break;
      case 'toolEffect': value = toolEffect(input.name, input.arguments, input.declaration); break;
      case 'phonePolicy': value = PHONE_POLICY; break;
      case 'completionObservation': value = completionObservation(input.observation); break;
      case 'calculate': value = calculateNumber(input.arguments); break;
      case 'taskEvaluation': value = taskEvaluationOperation(input); break;
      case 'internalRouting': value = internalRouting(input); break;
      case 'plan': value = planRequest(input.request); break;
      case 'actionEvidence': value = actionEvidence(input.plan, input.urls); break;
      case 'workflowCatalog': value = workflowCatalog(input.catalog); break;
      case 'workflowCall': value = prepareWorkflowCall(input.call); break;
      case 'catalog': value = toolCatalog(input.names); break;
      case 'validateTool': value = validateCommonTool(input.name, input.arguments); break;
      case 'config': value = normalizeRuntimeConfig(input.config); break;
      case 'scene': value = executionScene(input); break;
      case 'executionContext': value = executionContext(input.scenes); break;
      case 'sessionEvents': value = sessionEvents(input.scene); break;
      case 'publicReasoning': value = publicReasoning(input.items); break;
      case 'replyDocument': value = parseReplyDocument(input.text); break;
      case 'topicDividers': value = topicDividers(input.messages); break;
      case 'replyPresentation': value = replyPresentation(input.text); break;
      case 'searchResult': value = normalizeSearchResponse(input.result, input.observation); break;
      case 'searchRequest': value = searchRequest(input.arguments, input.config); break;
      case 'pageResult': value = normalizeFetchedPage(input.result, input.observation); break;
      case 'connectionIdentity': value = connectionIdentity(input.connection); break;
      case 'hostedCapability': value = hostedCapability(input.proof, input.fingerprint, input.now); break;
      case 'hostedReceipt': value = hostedSearchReceipt(input.response); break;
      case 'hostedProof': value = hostedSearchProof(input); break;
      case 'stopReply': value = turnStopReply(input.reason, input.text, input.locale); break;
      case 'start': value = startTurn(input.turn); break;
      case 'advance': value = advanceTurn(input.state, input.event, input.now); break;
      default: throw Object.assign(new Error('Unknown Core operation.'), { code: 'UNKNOWN_OPERATION' });
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: { code: error.code || 'CORE_ERROR', message: error.message } };
  }
}

// A cut inside an emoji leaves half a surrogate pair in a string. JSON.stringify writes it as an escape that
// the iPhone's JSON parser rejects, and the result of the whole operation was lost with it: an answer that
// had been written could fail at its check. With the u flag the class matches only unpaired halves.
const HALF_PAIR = /[\uD800-\uDFFF]/u, HALF_PAIRS = /[\uD800-\uDFFF]/gu;
const wellFormed = (key, value) => typeof value === 'string' && HALF_PAIR.test(value) ? value.replace(HALF_PAIRS, '\uFFFD') : value;
export function evaluateJSON(json) {
  if (typeof json !== 'string' || json.length > 2_000_000) return JSON.stringify({ ok: false, error: { code: 'INPUT_LIMIT', message: 'Core input exceeds its JSON budget.' } });
  try { return JSON.stringify(evaluate(JSON.parse(json)), wellFormed); }
  catch { return JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: 'Core input is not valid JSON.' } }); }
}
