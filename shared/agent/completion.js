import { planRequest } from './search.js';

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
  const requested = String(goal).match(/https?:\/\/[^\s<>"）)]+/gu) || [];
  if (requested.length) return requested.some(value => value.replace(/[.,，。;；]+$/u, '') === source.url);
  const keys = terms(goal), content = words(source.text);
  // This is a conservative provenance gate, not a factual or semantic judge.
  // The query echoed by a tool and its URL/title are deliberately excluded.
  const matched = keys.filter(key => content.includes(key));
  return keys.length > 0 && matched.length >= Math.min(2, keys.length) && matched.length / keys.length >= 0.75;
}

export function completionReceipt({ goal = '', kind = 'answer', reply = '', observations = [], terminalReason = '', verifiedActions = [] } = {}) {
  const rows = Array.isArray(observations) ? observations.slice(0, 128) : [];
  const performed = rows.filter(row => row?.ok === true && row.executed === true);
  const base = { version: 1, kind, outcome: 'blocked', goalState: 'unverified', reason: '', evidenceIds: [], completedSteps: new Set(performed.map(row => String(row.id).split(':source:')[0])).size };
  if (terminalReason === 'CANCELLED') return { ...base, outcome: 'cancelled', reason: terminalReason };
  if (/BUDGET|DEADLINE|ROUND_LIMIT|TOKEN_LIMIT/u.test(terminalReason)) return { ...base, outcome: 'budget_exhausted', reason: terminalReason };
  if (terminalReason) return { ...base, outcome: performed.length ? 'partial' : 'blocked', reason: terminalReason };
  if (!String(reply).trim()) return { ...base, outcome: performed.length ? 'partial' : 'blocked', reason: 'NO_FINAL_ANSWER' };
  if (kind === 'answer') return { ...base, outcome: 'completed', goalState: 'not_applicable', reason: 'ANSWER_DELIVERED' };
  const needsResearch = kind === 'research' || kind === 'research-action';
  const needsAction = kind === 'action' || kind === 'research-action';
  if (!needsResearch && !needsAction) return { ...base, outcome: performed.length ? 'partial' : 'blocked', reason: 'COMPLETION_CONTRACT_UNKNOWN' };
  let sources = [];
  if (needsResearch) {
    sources = rows.filter(row => row?.ok === true && row.executed === true && row.type === 'source' && typeof row.id === 'string' && row.id.length > 0 && url(row.url) &&
      ['extracted', 'partial'].includes(row.reading) && String(row.text || '').trim().length >= 40 && relevant(row, goal) && String(reply).includes(row.url));
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
export function completionObservation({ id, name, ok, executed, output = '', data = {}, sources = [] } = {}) {
  const rows = [{ id: String(id || '').slice(0, 256), name, type: 'tool', ok: ok === true, executed: executed === true }];
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
  const readTools = /^(?:file_read|glob|grep|read_history|search_history|web_search|fetch_url|open_url|media_info|knowledge|browser_snapshot|browser_read|browser_screenshot)$/u;
  const action = intent.route === 'phone' || intent.research?.navigate === true || intent.reason === 'PHONE_UNAVAILABLE' ||
    observations.some(row => row.type === 'tool' && row.executed !== false && !readTools.test(row.name || '')) ||
    /(?:创建|修改|删除|保存|写入|移动).{0,20}(?:文件|目录)|(?:发送|发出).{0,16}(?:邮件|消息)|\b(?:create|edit|delete|save|move|write)\b.{0,30}\b(?:file|directory|folder)\b|\bsend\b.{0,20}\b(?:email|message)\b/iu.test(goal);
  return research ? (action ? 'research-action' : 'research') : action ? 'action' : 'answer';
}

export function completionResult(input = {}) {
  const receipt = completionReceipt({ ...input, kind: input.kind || completionKind(input) });
  return { ...receipt, summary: completionSummary(receipt, input.goal) };
}

export function completionSummary(receipt, text = '') {
  const zh = /[\u3400-\u9fff]/u.test(text);
  const labels = zh
    ? { completed: '已完成', partial: '部分完成', blocked: '受阻', cancelled: '已取消', budget_exhausted: '预算已用完' }
    : { completed: 'Completed', partial: 'Partially completed', blocked: 'Blocked', cancelled: 'Cancelled', budget_exhausted: 'Budget exhausted' };
  const label = labels[receipt?.outcome] || (zh ? '完成状态未知' : 'Completion unknown');
  if (receipt?.goalState === 'not_applicable') return zh ? '回答已交付' : 'Answer delivered';
  if (receipt?.goalState === 'supported') return zh ? '已读取相关来源；结论未独立核实' : 'Relevant sources read; conclusions are not independently verified';
  return label + (receipt?.goalState === 'verified' ? (zh ? ' · 已核对目标状态' : ' · Target state verified') : (zh ? ' · 尚无目标完成证据' : ' · Goal completion is unverified'));
}
