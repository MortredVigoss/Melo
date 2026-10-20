import { CORE_VERSION, startTurn, advanceTurn, turnStopReply } from './turn.js';
import { planRequest, actionEvidence } from './search.js';
import { buildSkills } from './skill/skillService.js';
import { toolCatalog, validateCommonTool, normalizeRuntimeConfig, normalizeSearchResponse, normalizeFetchedPage, searchRequest } from './tools.js';
import { connectionIdentity, hostedCapability, hostedSearchReceipt, hostedSearchProof } from './hostedSearch.js';
import { executionScene, executionContext, publicReasoning } from './execution.js';
import { sessionEvents } from '../../src/shared/sessionEvents.js';
import { parseReplyDocument, inlineSpans, replyPresentation } from '../../src/shared/replyDocument.js';
import { budgetOperation } from './policyBridge.js';
import { repeatOperation } from './repeatGuard.js';
import { completionResult, completionObservation } from './completion.js';
import { contextCost, contextPlan, contextWirePlan, historyPage } from './context.js';

export function evaluate(input) {
  try {
    if (!input || input.version !== CORE_VERSION) throw Object.assign(new Error('Unsupported Core protocol.'), { code: 'PROTOCOL_VERSION' });
    let value;
    switch (input.op) {
      case 'hello': value = { version: CORE_VERSION, runtime: 'melo-local-core', portable: true }; break;
      case 'contextCost': value = contextCost(input.text); break;
      case 'contextPlan': value = contextPlan(input.context); break;
      case 'contextWirePlan': value = contextWirePlan(input.context); break;
      case 'historyPage': value = historyPage(input.page); break;
      case 'budget': value = JSON.parse(JSON.stringify(budgetOperation(input))); break;
      case 'repeat': value = repeatOperation(input); break;
      case 'completion': value = completionResult(input.completion); break;
      case 'completionObservation': value = completionObservation(input.observation); break;
      case 'plan': value = planRequest(input.request); break;
      case 'actionEvidence': value = actionEvidence(input.plan, input.urls); break;
      case 'skills': value = buildSkills(input.enabledIds, input.customSkills); break;
      case 'catalog': value = toolCatalog(input.names); break;
      case 'validateTool': value = validateCommonTool(input.name, input.arguments); break;
      case 'config': value = normalizeRuntimeConfig(input.config); break;
      case 'scene': value = executionScene(input); break;
      case 'executionContext': value = executionContext(input.scenes); break;
      case 'sessionEvents': value = sessionEvents(input.scene); break;
      case 'publicReasoning': value = publicReasoning(input.items); break;
      case 'replyDocument': value = parseReplyDocument(input.text); break;
      case 'replyPresentation': value = replyPresentation(input.text); break;
      case 'inlineSpans': value = inlineSpans(input.text); break;
      case 'searchResult': value = normalizeSearchResponse(input.result, input.observation); break;
      case 'searchRequest': value = searchRequest(input.arguments, input.config); break;
      case 'pageResult': value = normalizeFetchedPage(input.result, input.observation); break;
      case 'connectionIdentity': value = connectionIdentity(input.connection); break;
      case 'hostedCapability': value = hostedCapability(input.proof, input.fingerprint, input.now); break;
      case 'hostedReceipt': value = hostedSearchReceipt(input.response); break;
      case 'hostedProof': value = hostedSearchProof(input); break;
      case 'stopReply': value = turnStopReply(input.reason, input.text); break;
      case 'start': value = startTurn(input.turn); break;
      case 'advance': value = advanceTurn(input.state, input.event, input.now); break;
      default: throw Object.assign(new Error('Unknown Core operation.'), { code: 'UNKNOWN_OPERATION' });
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: { code: error.code || 'CORE_ERROR', message: error.message } };
  }
}

export function evaluateJSON(json) {
  if (typeof json !== 'string' || json.length > 2_000_000) return JSON.stringify({ ok: false, error: { code: 'INPUT_LIMIT', message: 'Core input exceeds its JSON budget.' } });
  try { return JSON.stringify(evaluate(JSON.parse(json))); }
  catch { return JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: 'Core input is not valid JSON.' } }); }
}
