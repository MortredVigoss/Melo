import { AGENT_LOOP_CONTRACT } from './loopContract.js';
import { resolveReplyLocale } from './locale.js';
import { runtimeMessage } from './runtimeMessages.js';
import { planRequest } from './search.js';
import { toolEffect } from './toolEffects.js';
import { startGoal, goalSnapshot } from './goal.js';

// Observable completion, separate from transport success and tool ok. Hosts
// supply actual receipts; model-authored claims are never verification inputs.
const words = value => String(value || '').toLowerCase().replace(/https?:\/\/\S+/gu, ' ');
const stopWords = new Set('the and for from with that this please find search research read about tell give show compare current latest into then sources source what which where how summarize me my a an in of to is are on can you could would should recommendations recommend'.split(' '));
const stopHan = new Set(['帮我', '请帮', '推荐', '搜索', '查找', '查询', '一下', '来源', '资料', '网页', '详细', '整理', '对比', '然后', '导航', '现在']);
function terms(value) {
  const text = words(value);
  const latin = (text.match(/[a-z0-9]{2,}/gu) || []).filter(word => !stopWords.has(word));
  const han = (text.match(/[\u3400-\u9fff]+/gu) || []).flatMap(word => [...word].slice(0, -1).map((_, i) => word.slice(i, i + 2))).filter(word => !stopHan.has(word));
  return [...new Set([...latin, ...han])].slice(0, 40);
}
function url(value) {
  const text = String(value || '').trim();
  return /^https?:\/\/[^\s/@]+(?:[/?#][^\s]*)?$/iu.test(text) && text.length <= 4000 ? text : '';
}
function relevant(source, goal) {
  const keys = terms(goal), content = words(source.text);
  // This is a conservative provenance gate, not a factual or semantic judge.
  // The query echoed by a tool and its URL/title are deliberately excluded.
  const matched = keys.filter(key => content.includes(key));
  return keys.length > 0 && matched.length / keys.length >= 0.5;
}

export function completionReceipt({ goal = '', kind = 'answer', reply = '', citations = [], observations = [], terminalReason = '', verifiedActions = [], task } = {}) {
  const rows = Array.isArray(observations) ? observations.slice(0, AGENT_LOOP_CONTRACT.guardLimits.completionObservations) : [];
  const performed = rows.filter(row => row?.ok === true && row.executed === true);
  const base = { version: 1, kind, outcome: 'blocked', goalState: 'unverified', reason: '', evidenceIds: [], completedSteps: new Set(performed.map(row => String(row.id).split(':source:')[0])).size, ...(task ? { task } : {}) };
  if (terminalReason === 'LIMIT_DELIVERED' && String(reply).trim()) {
    const evidenceIds = [...new Set((task?.requirements || []).flatMap(row => row.evidenceIds || []))];
    const supported = task?.decision === 'complete' && evidenceIds.length > 0 && evidenceIds.every(id => performed.some(row => row.id === id));
    const selfContained = task?.decision === 'deliver' && !performed.length;
    return { ...base, outcome: task?.deliveryCheck === 'unverified' ? 'unverified' : supported || selfContained ? 'completed' : 'partial',
      goalState: supported ? 'supported' : 'unverified', reason: 'LIMIT_DELIVERED', limitReason: task?.limitReason || 'ROUND_LIMIT', evidenceIds };
  }
  if (terminalReason === 'CANCELLED') return { ...base, outcome: 'cancelled', reason: terminalReason };
  if (/BUDGET|DEADLINE|ROUND_LIMIT|TOKEN_LIMIT/u.test(terminalReason)) return { ...base, outcome: 'budget_exhausted', reason: terminalReason };
  if (terminalReason) return { ...base, outcome: performed.length ? 'partial' : 'blocked', reason: terminalReason };
  if (!String(reply).trim()) return { ...base, outcome: performed.length ? 'partial' : 'blocked', reason: 'NO_FINAL_ANSWER' };
  if (task?.decision && task.decision !== 'deliver') {
    const evidenceIds = [...new Set((task.requirements || []).flatMap(row => row.evidenceIds || []))];
    const supported = task.decision === 'complete' && evidenceIds.length && evidenceIds.every(id => performed.some(row => row.id === id));
    return { ...base, outcome: supported ? 'completed' : task.decision === 'needs_user' ? 'needs_user' : performed.length ? 'partial' : 'blocked', goalState: supported ? 'supported' : 'unverified', reason: supported ? 'GOAL_DELIVERY_SUPPORTED' : task.reason || 'GOAL_COVERAGE_MISSING', evidenceIds };
  }
  if (task?.decision === 'deliver' && kind === 'research' && !performed.length) return { ...base, outcome: 'completed', goalState: 'unverified', reason: 'ANSWERED_WITHOUT_SOURCES' };
  if (kind === 'answer') return { ...base, outcome: 'completed', goalState: 'not_applicable', reason: 'ANSWER_DELIVERED' };
  const needsResearch = kind === 'research' || kind === 'research-action';
  const needsAction = kind === 'action' || kind === 'research-action';
  if (!needsResearch && !needsAction) return { ...base, outcome: performed.length ? 'partial' : 'blocked', reason: 'COMPLETION_CONTRACT_UNKNOWN' };
  let sources = [];
  if (needsResearch) {
    const links = value => (String(value).match(/https?:\/\/[^\s<>"）)]+/gu) || []).map(value => value.replace(/[.,，。;；]+$/u, ''));
    const requested = links(goal);
    const cited = new Set([...links(reply), ...(Array.isArray(citations) ? citations : []).map(row => url(typeof row === 'string' ? row : row?.url || row?.sourceUrl || row?.src)).filter(Boolean)]);
    sources = rows.filter(row => row?.ok === true && row.executed === true && row.type === 'source' && typeof row.id === 'string' && row.id.length > 0 && url(row.url) &&
      ['extracted', 'partial'].includes(row.reading) && String(row.text || '').trim().length >= 40 && (!requested.length || requested.includes(row.url)) && (requested.includes(row.url) || relevant(row, goal) || cited.has(row.url)));
    if (!sources.length) return { ...base, outcome: performed.length ? 'partial' : 'blocked', reason: 'RELEVANT_READ_SOURCE_MISSING' };
  }
  let actions = [];
  if (needsAction) {
    // Only the device adapter's independently checked visible-facts receipt is
    // supported initially. Arbitrary MCP/tool metadata cannot certify a goal.
    actions = (Array.isArray(verifiedActions) ? verifiedActions : []).filter(row => row?.type === 'device-visible-facts' &&
      row.checked === true && row.goal === goal && typeof row.evidenceId === 'string' && row.evidenceId.length > 0);
    if (!actions.length) return { ...base, outcome: performed.length || sources.length ? 'partial' : 'blocked', reason: 'GOAL_TERMINAL_EVIDENCE_MISSING', evidenceIds: sources.map(row => row.id).filter(Boolean) };
  }
  return { ...base, outcome: 'completed', goalState: needsAction ? 'verified' : 'supported', reason: needsAction ? 'VERIFIED_TERMINAL_STATE' : 'RELEVANT_SOURCES_READ',
    evidenceIds: [...new Set([...sources.map(row => row.id), ...actions.map(row => row.evidenceId)].filter(id => typeof id === 'string' && id.length <= 256))] };
}

// Tool-specific adapters pass actual bodies, never a formatted search answer
// (which may contain an echoed query). These bounded rows are ephemeral; only
// the final receipt and evidence IDs may be persisted.
export function completionObservation({ id, name, ok, executed, output = '', data = {}, sources = [], arguments: args = {}, declaration = {} } = {}) {
  const effect = toolEffect(name, args, declaration);
  const rows = [{ id: String(id || '').slice(0, 256), name, type: 'tool', effect, ok: ok === true, executed: executed === true, output: String(output || data.text || '').slice(0, 4000) }];
  if (ok !== true || executed !== true) return rows;
  let page = data;
  if (name === 'open_url') {
    try { page = JSON.parse(output); } catch { page = {}; }
  }
  const reads = ['fetch_url', 'open_url'].includes(name)
    ? [{ url: page.url || page.finalUrl, text: page.text, reading: page.truncated ? 'partial' : 'extracted' }]
    : name === 'web_search' ? sources : [];
  for (const [index, source] of reads.slice(0, 16).entries()) {
    if (!url(source.url)) continue;
    rows.push({ id: `${rows[0].id}:source:${index}`, type: 'source', ok: true, executed: true,
      url: source.url, text: String(source.text || source.content || '').slice(0, 16000), reading: source.reading || 'extracted' });
  }
  return rows;
}

export function completionKind({ goal = '', plan, observations = [] } = {}) {
  const names = ['web_search', 'fetch_url', 'phone_use'];
  const intent = plan || planRequest({ text: goal, capabilities: { executors: names, grants: names }, config: {} });
  const research = !!intent.research || /search|fetch-url|social-link/u.test(intent.route || '') || /SEARCH|FETCH/u.test(intent.reason || '') ||
    observations.some(row => row.type === 'source' || ['web_search', 'fetch_url', 'open_url'].includes(row.name));
  const action = intent.route === 'phone' || intent.research?.navigate === true || intent.reason === 'PHONE_UNAVAILABLE' ||
    observations.some(row => row.type === 'tool' && row.executed !== false && !['read', 'compute'].includes(row.effect || toolEffect(row.name))) ||
    /(?:创建|修改|删除|保存|写入|移动).{0,20}(?:文件|目录)|(?:发送|发出).{0,16}(?:邮件|消息)|\b(?:create|edit|delete|save|move|write)\b.{0,30}\b(?:file|directory|folder)\b|\bsend\b.{0,20}\b(?:email|message)\b/iu.test(goal);
  return research ? (action ? 'research-action' : 'research') : action ? 'action' : 'answer';
}

export function completionResult(input = {}) {
  const receipt = completionReceipt({ ...input, kind: input.kind || completionKind(input) });
  return { ...receipt, summary: completionSummary(receipt, input.goal, input.locale) };
}

// Host-owned receipts, not the lead's prose, determine team delivery. Only
// each member's final attempt counts; earlier attempts remain in history.
export function teamCompletion({ locale, goal = '', reply = '', members = [], accepted = true, cancelled = false, budgetExceeded = false } = {}) {
  const latest = [...new Map(members.map(row => [row.id, row])).values()];
  const delivered = latest.length > 0 && accepted && latest.every(row => row.ok && row.status === 'completed' && row.completion?.outcome === 'completed');
  const outcome = cancelled ? 'cancelled' : budgetExceeded ? 'budget_exhausted' : delivered && reply.trim() ? 'completed' : 'partial';
  const requirements = latest.map(row => ({ text: String(row.id).slice(0, 200), status: row.ok && row.status === 'completed' && row.completion?.outcome === 'completed' ? 'met' : 'missing', evidenceIds: row.completion?.evidenceIds || [] }));
  return { version: 1, kind: 'answer', outcome, goalState: outcome === 'completed' ? 'supported' : 'unverified', reason: outcome === 'completed' ? 'TEAM_DELIVERIES_SUMMARIZED' : 'TEAM_DELIVERY_INCOMPLETE', evidenceIds: [...new Set(requirements.flatMap(row => row.evidenceIds))], completedSteps: requirements.filter(row => row.status === 'met').length,
    task: { ...goalSnapshot(startGoal(goal)), decision: outcome === 'completed' ? 'complete' : 'partial', requirements },
    summary: runtimeMessage(outcome === 'completed' ? 'teamDone' : 'teamPartial', locale || resolveReplyLocale({text:goal})) };
}

export function completionSummary(receipt, text = '', locale) {
  const language = locale || resolveReplyLocale({ text });
  const message = key => runtimeMessage(key, language);
  const label = receipt?.outcome === 'unverified' ? message('deliveryUnverified') : message(['completed','partial','blocked','needs_user','cancelled','budget_exhausted','unverified'].includes(receipt?.outcome) ? receipt.outcome : 'unknown');
  if (receipt?.reason === 'LIMIT_DELIVERED') return label + ' · ' + message(receipt.limitReason === 'ROUND_LIMIT' ? 'deliveryRounds' : 'deliveryBudget');
  if (receipt?.goalState === 'not_applicable') return message('delivered');
  if (receipt?.reason === 'ANSWERED_WITHOUT_SOURCES') return message('unsourced');
  if (receipt?.reason === 'GOAL_CHECK_BUDGET') return message('checkBudget');
  if (['GOAL_CHECK_TRUNCATED','GOAL_CHECK_CONTEXT'].includes(receipt?.reason)) return message('checkScope');
  if (['GOAL_CHECK_UNAVAILABLE','GOAL_CHECK_INVALID','GOAL_EVIDENCE_INVALID'].includes(receipt?.reason)) return message('checkUnavailable');
  if (receipt?.reason === 'GOAL_DELIVERY_SUPPORTED') return message('supported');
  if (receipt?.task?.explanation) return label + ' · ' + receipt.task.explanation.slice(0,240);
  if (receipt?.goalState === 'supported') return message('sourcesRead');
  return label + ' · ' + message(receipt?.goalState === 'verified' ? 'verified' : 'unverified');
}
