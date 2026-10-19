import { AGENT_LOOP_CONTRACT } from '../../runtime/agentLoopContract.js';
const contextDefaults = AGENT_LOOP_CONTRACT.contextBudget;
import { estimateTextTokens, estimateMessageTokens, estimateMessagesTokens, truncateToTokens } from '../../memory/tokenEstimate.js';

// ─── Budget resolution ──────────────────────────────────────────────────────
// One source of truth for "how much history can a single turn carry". Before
// the 2026-10-17 audit three constants disagreed: the sliding window took 60k,
// the compaction trigger waited for 80k, and the request fitter capped the
// whole input (system prompt + tools + history) at 60k − 8k = 52k. History
// between ~52k and 80k was silently dropped by the fitter and never
// summarised (audit P0-2). The window and the trigger are now derived from
// the same total, and the trigger never exceeds the window.
//
// Defaults are per provider family. Cloud models (Codex / API key) get a
// large window because the user asked for longer single conversations and
// those models carry 200k–400k contexts; local models stay small because
// most of them do not. MELO_CONTEXT_BUDGET_TOKENS always wins when set.
const DEFAULT_CLOUD_BUDGET_TOKENS = contextDefaults.cloud;
const DEFAULT_LOCAL_BUDGET_TOKENS = contextDefaults.local;
const MAX_BUDGET_TOKENS = contextDefaults.maximum;
const MIN_BUDGET_TOKENS = contextDefaults.minimum;
// Share of the input limit reserved for history; the rest covers the system
// prompt, tool definitions and recall. Keeping the window below the input
// limit is what prevents the fitter from dropping messages the trigger
// never saw.
const HISTORY_WINDOW_SHARE = 0.75;
// Near-window cap (2026-10-17 design 1D-1). With the 160k cloud budget the
// 75% share allowed ~114k tokens of raw history per turn: expensive even
// when cached, and old topics diluted attention. The ledger cards, topic
// excerpts and read_history now cover the early part of a conversation, so
// raw history is capped at this many tokens and compaction starts earlier.
// MELO_HISTORY_WINDOW_TOKENS overrides the cap (raise it for providers whose
// cache makes long raw history cheap).
const DEFAULT_NEAR_WINDOW_TOKENS = contextDefaults.nearWindow;
// One summarising request carries at most this much history (final-token
// scale); the floor keeps local models compacting a few turns at a time.
const MAX_COMPACT_CHUNK_TOKENS = contextDefaults.chunkMaximum;
const MIN_COMPACT_CHUNK_TOKENS = contextDefaults.chunkMinimum;
// Final-token margin kept between the required prompt and the history window.
const HISTORY_WINDOW_MARGIN = contextDefaults.margin;
// Per-turn recall sections (session facts, excerpts, memory, dynamic context)
// share this much at most; each lower-priority block keeps a floor (audit L3).
const RECALL_BUDGET_TOKENS = 32_000;
const RECALL_SECTION_FLOOR_TOKENS = 1_600;

function defaultBudgetFor(config) {
  const authMode = String(config?.authMode || '').toLowerCase();
  if (authMode === 'local') return DEFAULT_LOCAL_BUDGET_TOKENS;
  return DEFAULT_CLOUD_BUDGET_TOKENS;
}

export function resolveContextBudget(env = process.env, { config = null } = {}) {
  const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) && Number(value) >= min
    ? Math.min(max, Math.floor(Number(value))) : fallback;
  const totalTokens = bounded(env.MELO_CONTEXT_BUDGET_TOKENS, defaultBudgetFor(config), MIN_BUDGET_TOKENS, MAX_BUDGET_TOKENS);
  const outputReserve = Math.floor(Math.min(totalTokens / 3, bounded(env.MELO_OUTPUT_RESERVE_TOKENS, 8000, 512, 32000)));
  const inputLimit = totalTokens - outputReserve;
  const nearWindowCap = bounded(env.MELO_HISTORY_WINDOW_TOKENS, DEFAULT_NEAR_WINDOW_TOKENS, 2048, MAX_BUDGET_TOKENS);
  const windowTokens = Math.max(2048, Math.min(nearWindowCap, Math.floor(inputLimit * HISTORY_WINDOW_SHARE)));
  return {
    totalTokens,
    outputReserve,
    inputLimit,
    // History the sliding window may carry (final-token scale, see contextWindow.js).
    windowTokens,
    // Compact as soon as pending history would no longer fit the window.
    compactTriggerTokens: windowTokens,
    // Largest chunk one summarising request may carry (audit L4): about half
    // the input limit so the transcript plus the card prompt fits the same
    // model, never above the 45k the cloud summariser was tuned for.
    compactChunkTokens: Math.min(MAX_COMPACT_CHUNK_TOKENS, Math.max(MIN_COMPACT_CHUNK_TOKENS, Math.floor(inputLimit / 2))),
  };
}

// Tokens the request needs before any history: the required prompt sections
// (instructions, project settings, selected materials) plus the tool
// definitions, on the same padded scale fitRequestContext uses.
export function requiredPromptTokens({ sections = [], toolDefinitions = [] } = {}) {
  const required = sections.filter(section => section?.required && section.text?.trim());
  const toolTokens = toolDefinitions.length ? Math.ceil(estimateTextTokens(JSON.stringify(toolDefinitions)) * 4 / 3) : 0;
  return Math.ceil(estimateTextTokens(renderPromptSections(required)) * 4 / 3) + 32 + toolTokens;
}

// The history window this request can actually carry (audit L4): the nominal
// window, or less when the required prompt and tools leave less room in the
// input limit. Local models with a 16k input and ~7.5k of required prompt
// used to get a 12k window the fitter then cut back, dropping history the
// compaction trigger had not seen.
export function effectiveHistoryWindow(budget, requiredTokens, { margin = HISTORY_WINDOW_MARGIN } = {}) {
  const inputLimit = Number(budget?.inputLimit) || 0;
  const windowTokens = Number(budget?.windowTokens) || 0;
  const room = inputLimit - (Number(requiredTokens) || 0) - margin;
  return Math.max(1024, Math.min(windowTokens, room));
}

export function renderPromptSections(sections) {
  return sections.map(section => section.text).filter(Boolean).join('\n\n');
}

function latestUserIndex(messages) {
  // Supplements typed while a turn runs are user-role messages appended after
  // the original request; the turn context stays attached to the original
  // request so the cached prefix does not shift mid-turn.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && !messages[index]?.isToolResult && !messages[index]?.isSupplement) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && !messages[index]?.isToolResult) return index;
  }
  return -1;
}

function requiredIndices(messages) {
  const latestUser = latestUserIndex(messages);
  const indices = new Set(latestUser >= 0 ? [latestUser] : []);
  if (latestUser >= 0 && messages.slice(latestUser).some(message => message.responseItems || message.functionCallOutputs || message.toolCalls || message.toolResults)) {
    // A native tool continuation (Responses items, or the protocol-neutral
    // toolCalls/toolResults IR used for Anthropic and chat-completions) is one
    // indivisible chain from the current user input through every
    // call/output/reasoning item. Fail closed if too large.
    for (let index = latestUser; index < messages.length; index += 1) indices.add(index);
  }
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

export const TURN_CONTEXT_HEADER = '[Turn context: instructions and reference data for this reply only. The user\'s own message follows after "[User message]".]';
export const TURN_CONTEXT_USER_MARKER = '[User message]';

// Render the per-turn block into the current user message. Returns a new
// message object; the original (and its WeakMap source id) is left alone.
// Callers attach this immediately before the provider request — the prepared
// message list itself stays clean so image/vision pipelines and debugging
// views keep seeing the user's actual words.
export function attachTurnContext(message, turnContext) {
  if (!turnContext || !message) return message;
  if (message.turnContextAttached) return message;
  const block = `${TURN_CONTEXT_HEADER}\n\n${turnContext}\n\n${TURN_CONTEXT_USER_MARKER}`;
  const content = message.content;
  if (Array.isArray(content)) {
    return { ...message, content: [{ type: 'text', text: block }, ...content], turnContextAttached: true };
  }
  const text = typeof content === 'string' ? content : String(content ?? '');
  return { ...message, content: `${block}\n${text}`, turnContextAttached: true };
}

// Attach the per-turn block to the latest (non-supplement) user message.
export function attachTurnContextToMessages(messages = [], turnContext = '') {
  if (!turnContext) return messages;
  const target = latestUserIndex(messages);
  if (target < 0) return messages;
  return messages.map((message, index) => index === target ? attachTurnContext(message, turnContext) : message);
}

export function fitRequestContext({ sections = [], messages = [], totalTokens = 60000, outputReserve = 8000, toolDefinitions = [], turnContextPlacement = 'system' }) {
  const inputLimit = Math.floor(totalTokens - outputReserve);
  const seen = new Set();
  const toolTokens = toolDefinitions.length ? Math.ceil(estimateTextTokens(JSON.stringify(toolDefinitions)) * 4 / 3) : 0;
  const diagnostics = { totalTokens, outputReserve, toolTokens, droppedSections: [], truncatedSections: [], duplicateSections: [] };
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
  const promptCost = () => Math.ceil(estimateTextTokens(renderPromptSections([...selected.values()])) * 4 / 3) + 32 + toolTokens;
  const remaining = inputLimit - promptCost() - Math.ceil(selectedRawCost * 4 / 3);
  if (remaining < 0) throw overflow();

  // Optional sections share at most half the remaining room; the other half
  // is kept for recent turns. Within that share (audit L3):
  //   • stable reference blocks (`placement: 'system'` — project settings,
  //     profile, the conversation ledger) are bounded by their own maxTokens
  //     only and never draw from the recall budget;
  //   • per-turn recall (session facts, topic excerpts, memory, dynamic
  //     context) shares RECALL_BUDGET_TOKENS, and every lower-priority block
  //     keeps a floor so `memory` is not truncated and `dynamic` not dropped
  //     by a full ledger while the request is far below the input limit.
  const optionalShare = Math.floor(remaining / 2);
  const optional = unique.filter(section => !section.required).sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const place = (section, allowance) => {
    const text = truncateToTokens(section.text, Math.max(0, Math.floor((allowance - 8) * 3 / 4)));
    if (!text) { diagnostics.droppedSections.push(section.id); return 0; }
    if (text !== section.text) diagnostics.truncatedSections.push(section.id);
    selected.set(section.id, { ...section, text });
    return Math.ceil(estimateTextTokens(text) * 4 / 3) + 8;
  };
  const recall = optional.filter(section => section.placement !== 'system');
  const floorOf = section => Math.min(RECALL_SECTION_FLOOR_TOKENS, Math.floor((section.maxTokens || 5000) * 4 / 3));
  // Stable blocks may not eat the recall floors either (a small local budget
  // with a full ledger used to leave nothing for memory and dynamic context).
  const recallReserve = Math.min(recall.reduce((sum, section) => sum + floorOf(section), 0), Math.floor(optionalShare / 2));
  let stableBudget = optionalShare - recallReserve;
  for (const section of optional.filter(section => section.placement === 'system')) {
    stableBudget -= place(section, Math.min(stableBudget, Math.floor((section.maxTokens || 5000) * 4 / 3)));
  }
  let recallBudget = Math.min(RECALL_BUDGET_TOKENS, Math.max(0, stableBudget + recallReserve));
  recall.forEach((section, index) => {
    const reserved = recall.slice(index + 1).reduce((sum, later) => sum + floorOf(later), 0);
    // Guaranteed share: the floor, or an equal split when the budget is below the floors.
    const guaranteed = Math.min(floorOf(section), Math.floor(recallBudget / (recall.length - index)));
    const allowance = Math.min(Math.max(recallBudget - reserved, guaranteed), Math.floor((section.maxTokens || 5000) * 4 / 3));
    recallBudget -= place(section, allowance);
  });
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
  // Split by placement: stable sections stay in the system prompt; per-turn
  // sections travel inside the current user message when the caller asks for
  // it, keeping the system prompt and earlier history byte-identical across
  // turns so providers can serve them from the prompt cache.
  const moveTurnContext = turnContextPlacement === 'message';
  const systemSections = moveTurnContext ? keptSections.filter(section => section.placement !== 'turn') : keptSections;
  const turnSections = moveTurnContext ? keptSections.filter(section => section.placement === 'turn') : [];
  const systemPrompt = renderPromptSections(systemSections);
  const turnContext = renderPromptSections(turnSections);
  const keptMessages = selectedMessages();
  // Token accounting covers both placements: the turn block is counted where
  // it will actually travel.
  diagnostics.inputTokens = Math.ceil(estimateTextTokens(systemPrompt) * 4 / 3) + 32 + toolTokens + estimateMessagesTokens(attachTurnContextToMessages(keptMessages, turnContext));
  diagnostics.droppedMessages = messages.length - keptMessages.length;
  diagnostics.turnContextTokens = turnContext ? Math.ceil(estimateTextTokens(turnContext) * 4 / 3) : 0;
  diagnostics.sections = keptSections.map(section => ({ id: section.id, estimatedTokens: estimateTextTokens(section.text), placement: section.placement || 'system' }));
  if (diagnostics.inputTokens > inputLimit) throw overflow();
  // promptText is the full instruction text regardless of placement — use it
  // for "did this block reach the model" checks (memory usage feedback).
  return { systemPrompt, turnContext, promptText: [systemPrompt, turnContext].filter(Boolean).join('\n\n'), messages: keptMessages, sections: keptSections, diagnostics };
}
