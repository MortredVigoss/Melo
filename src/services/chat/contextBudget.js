import { estimateTextTokens, estimateMessageTokens, estimateMessagesTokens, truncateToTokens } from '../../memory/tokenEstimate.js';

export function resolveContextBudget(env = process.env) {
  const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) && Number(value) >= min
    ? Math.min(max, Math.floor(Number(value))) : fallback;
  const totalTokens = bounded(env.MELO_CONTEXT_BUDGET_TOKENS, 60000, 4096, 200000);
  const outputReserve = Math.min(totalTokens / 3, bounded(env.MELO_OUTPUT_RESERVE_TOKENS, 8000, 512, 32000));
  return { totalTokens, outputReserve: Math.floor(outputReserve) };
}

export function renderPromptSections(sections) {
  return sections.map(section => section.text).filter(Boolean).join('\n\n');
}

function requiredIndices(messages) {
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && !messages[index]?.isToolResult) { latestUser = index; break; }
  }
  const indices = new Set(latestUser >= 0 ? [latestUser] : []);
  // Keep the newest tool-call/result pair together, including error evidence.
  const last = messages.length - 1;
  if (messages[last]?.isToolResult) {
    indices.add(last);
    if (messages[last - 1]?.role === 'assistant') indices.add(last - 1);
  }
  return indices;
}

function overflow() {
  const error = new Error('The current message, attachments and required instructions exceed the context budget. Split the message or reduce attachments; the current input was not silently truncated.');
  error.code = 'CONTEXT_BUDGET_EXCEEDED';
  return error;
}

export function fitRequestContext({ sections = [], messages = [], totalTokens = 60000, outputReserve = 8000 }) {
  const inputLimit = Math.floor(totalTokens - outputReserve);
  const seen = new Set();
  const diagnostics = { totalTokens, outputReserve, droppedSections: [], truncatedSections: [], duplicateSections: [] };
  const unique = sections.filter(section => {
    if (!section.text?.trim()) return false;
    const key = section.text.trim();
    if (seen.has(key)) { diagnostics.duplicateSections.push(section.id); return false; }
    seen.add(key);
    return true;
  });
  const selected = new Map(unique.filter(section => section.required).map(section => [section.id, section]));
  const indices = requiredIndices(messages);
  const messageCosts = messages.map(estimateMessageTokens);
  let selectedRawCost = [...indices].reduce((sum, index) => sum + messageCosts[index], 0);
  const selectedMessages = () => [...indices].sort((a, b) => a - b).map(index => messages[index]);
  const promptCost = () => Math.ceil(estimateTextTokens(renderPromptSections([...selected.values()])) * 4 / 3) + 32;
  const remaining = inputLimit - promptCost() - Math.ceil(selectedRawCost * 4 / 3);
  if (remaining < 0) throw overflow();

  // Bound recall independently, leaving at least half the remaining room for recent turns.
  let recallBudget = Math.min(16000, Math.floor(remaining / 2));
  const optional = unique.filter(section => !section.required).sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const section of optional) {
    const allowance = Math.min(recallBudget, Math.floor((section.maxTokens || 5000) * 4 / 3));
    const text = truncateToTokens(section.text, Math.max(0, Math.floor((allowance - 8) * 3 / 4)));
    if (!text) { diagnostics.droppedSections.push(section.id); continue; }
    if (text !== section.text) diagnostics.truncatedSections.push(section.id);
    selected.set(section.id, { ...section, text });
    const cost = Math.ceil(estimateTextTokens(text) * 4 / 3) + 8;
    recallBudget -= cost;
  }
  const finalPromptCost = promptCost();

  // Add newest history first, keeping tool pairs and ordinary user/assistant turns intact.
  for (let end = messages.length - 1; end >= 0;) {
    if (indices.has(end)) { end -= 1; continue; }
    let start = end;
    if (messages[end]?.isToolResult && messages[end - 1]?.role === 'assistant') start = end - 1;
    else if (messages[end]?.role === 'assistant' && messages[end - 1]?.role === 'user' && !messages[end - 1]?.isToolResult) start = end - 1;
    const additions = [];
    for (let index = start; index <= end; index += 1) if (!indices.has(index)) additions.push(index);
    const addedRawCost = additions.reduce((sum, index) => sum + messageCosts[index], 0);
    if (finalPromptCost + Math.ceil((selectedRawCost + addedRawCost) * 4 / 3) <= inputLimit) {
      additions.forEach(index => indices.add(index));
      selectedRawCost += addedRawCost;
    } else {
      break; // Preserve a contiguous recent history instead of filling gaps with old scraps.
    }
    end = start - 1;
  }
  const keptSections = unique.filter(section => selected.has(section.id)).map(section => selected.get(section.id));
  const systemPrompt = renderPromptSections(keptSections);
  const keptMessages = selectedMessages();
  diagnostics.inputTokens = Math.ceil(estimateTextTokens(systemPrompt) * 4 / 3) + 32 + estimateMessagesTokens(keptMessages);
  diagnostics.droppedMessages = messages.length - keptMessages.length;
  diagnostics.sections = keptSections.map(section => ({ id: section.id, estimatedTokens: estimateTextTokens(section.text) }));
  if (diagnostics.inputTokens > inputLimit) throw overflow();
  return { systemPrompt, messages: keptMessages, sections: keptSections, diagnostics };
}
