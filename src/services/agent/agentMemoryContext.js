import { requestEnvironment } from '../../runtime/requestScope.js';
import { canRecallMemory, isLocalChat, normalizedFact } from '../../memory/factPolicy.js';
import { buildSpeakerMemoryNamespace } from '../../memory/snapshotBuilder.js';
import { recallMemoryGroups, recallMemoriesTiered, getMemoriesByIds, isEntryInvalidated } from '../../memory/store.js';
import { atticEnabled, enabledTiers, injectHotAttic } from '../../memory/attic.js';
import { buildSpeakerProfileBlock, shouldCompactSpeakerFacts } from '../../memory/speakerProfile.js';
import { normalizeConversationSnippet } from '../../memory/heuristics.js';
import { shouldSuppressMemoryContextText } from '../../domain/chat/contextFilters.js';
import { normalizePromptHistory } from '../../domain/activity/activityLog.js';
import { normalizeApprovals } from '../../domain/approval/approvalService.js';
import { normalizeTasks } from '../../domain/task/taskService.js';

function lifecyclePrefix(entry) {
  const meta = entry.metadata || {};
  if (meta.status === 'historical') return '[historical] ';
  if (meta.status !== 'needs_confirmation') return '';
  return meta.staleBecause?.changedFactKey
    ? `[needs confirmation; ${meta.staleBecause.changedFactKey} changed] ` : '[needs confirmation] ';
}
const snippet = (row, max = 180) => lifecyclePrefix(row) + normalizeConversationSnippet(row.text || '',max);

// Retrieval and rendering are read-only. Each rendered row carries its exact
// fragment; the model boundary records feedback after the final budget pass.
export function buildAgentMemoryNodeContext({
  state, chat, latestUserMessage = '', activeAgentProfile, project,
  queryEmbedding = null, includedMessageIds = [], excludedFacts = [],
  onRecall = null, onCandidates = null, env = requestEnvironment(),
}) {
  const deletedChatIds = new Set([...(state?.pendingChatDeletions || []), ...(state?.mobileDeletedChats || []).map(row=>row.id)]);
  const liveChatIds = Array.isArray(state?.chats) ? new Set(state.chats.map(row => row.id)) : null;
  const windowIds = new Set(includedMessageIds);
  const windowText = new Set((chat?.messages || []).filter(m=>windowIds.has(m.id)).map(m=>normalizedFact(m.content || '')));
  windowText.add(normalizedFact(latestUserMessage));
  const excludedIds = new Set(excludedFacts.map(row=>row.id));
  const seen = new Set(excludedFacts.map(row=>normalizedFact(row.fact || row.text)));
  const seenIds = new Set(excludedIds);
  const accept = row => {
    if (liveChatIds && row.metadata?.chatId && !liveChatIds.has(row.metadata.chatId)) return false;
    if (excludedIds.has(row.id) || shouldSuppressMemoryContextText(row.text || row.searchText || '')) return false;
    if (!canRecallMemory(row,{chat,agentId:activeAgentProfile?.id,projectId:project?.id || chat?.projectId,deletedChatIds})) return false;
    if (row.kind === 'prompt' && (windowIds.has(row.metadata?.messageId || row.sourceId) || windowText.has(normalizedFact(row.text)))) return false;
    return true;
  };
  const namespaces = [isLocalChat(chat) ? 'user:local' : '', chat?.id ? `chat:${chat.id}` : '',
    project?.id ? `project:${project.id}` : '', activeAgentProfile?.id ? `agent:${activeAgentProfile.id}` : ''].filter(Boolean);
  const current = [...(chat?.messages || [])].reverse().find(m=>m.role === 'user');
  const speaker = buildSpeakerMemoryNamespace({chat,message:current,agentId:activeAgentProfile?.id});
  const label = current?.senderName || current?.senderUsername || current?.senderId || 'Current speaker';
  const local = row => !row.metadata?.chatId || row.metadata.chatId === chat?.id;
  const localOrProject = row => local(row) || (project?.id && row.metadata?.projectId === project.id);
  const groups = [
    {id:'speaker',namespaces:speaker?[speaker]:[],kinds:['prompt'],limit:10,accept:local},
    {id:'speakerFacts',namespaces:speaker?[speaker]:[],kinds:['fact'],limit:8},
    {id:'corrections',namespaces,kinds:['verification-correction','session-fact'],limit:6},
    {id:'prompts',namespaces,kinds:['prompt'],limit:12,accept:local},
    {id:'approvals',namespaces,kinds:['approval'],limit:6,accept:localOrProject},
    {id:'tasks',namespaces,kinds:['task'],limit:6,accept:localOrProject},
  ];
  const participants = new Map();
  if (['group','supergroup'].includes(chat?.chatType) && activeAgentProfile?.id) {
    for (const message of chat.messages || []) {
      if (message.role !== 'user' || !message.senderId) continue;
      const ns = buildSpeakerMemoryNamespace({chat,message,agentId:activeAgentProfile.id});
      if (ns && ns !== speaker) participants.set(ns,message.senderName || message.senderUsername || message.senderId);
    }
    for (const ns of participants.keys()) groups.push({id:ns,namespaces:[ns],kinds:['fact'],limit:3});
  }
  const gate = String(env.MELO_MEMORY_TIERS_RECALL || '').trim();
  const tiers = enabledTiers(env);
  const tieredRecall = gate === '1' || (gate !== '0' && (tiers.has('scene') || tiers.has('frame')));
  // audit C-12: with tiered recall on, the flat `prompts` group was queried and
  // then discarded (its rows were overwritten by tiered contents) — one SQLite +
  // vector pass per turn for nothing. Skip it up front; the tiered path falls
  // back to a flat query only if it throws.
  const flatGroups = tieredRecall ? groups.filter(group=>group.id !== 'prompts') : groups;
  const recalled = recallMemoryGroups({groups:flatGroups,query:latestUserMessage,queryEmbedding,accept});
  const rows = id => recalled.get(id) || [];
  for (const group of recalled.values()) onCandidates?.(group);
  let scenes = [], frames = [], facts = [], prompts = rows('prompts');
  if (tieredRecall) {
    try {
      const tiered = recallMemoriesTiered({namespaces,query:latestUserMessage,queryEmbedding,
        accept:row=>accept(row)&&local(row),limits:{scenes:3,frames:8,contents:12}});
      scenes = tiered.scenes || []; frames = tiered.frames || [];
      prompts = (tiered.contents || []).filter(row=>row.kind === 'prompt');
      facts = (tiered.contents || []).filter(row=>row.kind === 'fact');
      onCandidates?.([...scenes,...frames,...prompts,...facts]);
    } catch (error) {
      console.warn(`[memory.recall.tiered] fallback to flat recall: ${error.message}`);
      const fallback = recallMemoryGroups({groups:groups.filter(group=>group.id === 'prompts'),query:latestUserMessage,queryEmbedding,accept});
      prompts = fallback.get('prompts') || [];
      onCandidates?.(prompts);
    }
  }
  const blocks = [], rendered = [];
  const take = entries => entries.filter(row=>{
    const textKey = normalizedFact(row.text);
    // Speaker facts about different participants are independent assertions.
    const key = row.namespace?.startsWith('speaker:') ? `${row.namespace}:${textKey}` : textKey;
    if (!textKey || seenIds.has(row.id) || seen.has(key)) return false;
    seenIds.add(row.id);seen.add(key);return true;
  });
  const append = (heading,entries,format = row=>`- ${snippet(row)}`) => {
    const selected = take(entries);
    if (!selected.length) return;
    const lines = selected.map(row=>{
      const renderedText = format(row);
      rendered.push({...row,renderedText});return renderedText;
    });
    blocks.push(`${heading}\n${lines.join('\n')}`);
  };
  if (atticEnabled(env)) {
    const hot = injectHotAttic({namespaces,accept:row=>accept(row)&&!seen.has(normalizedFact(row.text)),onRecall:entries=>{
      take(entries);rendered.push(...entries);onCandidates?.(entries);
    }});
    if (hot) blocks.push(hot);
  }
  const appendSpeaker = (heading,entries,participantLabel) => {
    if (!shouldCompactSpeakerFacts(entries)) {
      append(heading,entries,row=>`- ${lifecyclePrefix(row)}${row.text}`);return;
    }
    const selected = take(entries);
    if (!selected.length) return;
    const profile = buildSpeakerProfileBlock(selected,{label:participantLabel});
    if (profile) {blocks.push(profile);rendered.push(...selected.map(row=>({...row,renderedText:profile})));}
  };
  appendSpeaker(`Current speaker fact nodes (${label}):`,rows('speakerFacts'),label);
  append(`Current speaker memory nodes (${label}):`,rows('speaker'));
  for (const [ns,participantLabel] of participants) appendSpeaker(`Known facts about group participant (${participantLabel}):`,rows(ns),participantLabel);
  append('Relevant saved facts and corrections (scope-filtered reference data):',rows('corrections'),row=>`- ${snippet(row,200)}`);
  append('Conversation scene summaries:',scenes,row=>`- ${snippet(row,220)}`);
  append('Frame summaries:',frames,row=>`- ${snippet(row,200)}`);
  append('Prompt memory nodes:',prompts);
  append('Recalled fact nodes (tiered):',facts);
  append('Approval memory nodes:',rows('approvals'),row=>`- ${row.metadata?.title || row.text} [${row.metadata?.status || 'unknown'}]${row.metadata?.resultSummary ? ` :: ${row.metadata.resultSummary}` : ''}`);
  append('Task memory nodes:',rows('tasks'),row=>`- ${row.metadata?.title || row.text} [${row.metadata?.status || 'unknown'}]${row.metadata?.latestNote ? ` :: ${normalizeConversationSnippet(row.metadata.latestNote,160)}` : ''}`);

  // Legacy states without an index remain usable, but never echo the current
  // input or a message already included in the model's recent-history window.
  if (!blocks.length && !deletedChatIds.has(chat?.id)) {
    const previous = normalizePromptHistory(state?.settings?.promptHistory)
      .filter(row=>row.chatId === chat?.id && !windowIds.has(row.messageId || row.id) && !windowText.has(normalizedFact(row.content)) && !seen.has(normalizedFact(row.content)))
      .filter(row=>{
        const [stored] = getMemoriesByIds([`prompt:chat:${chat.id}:${row.id}`]);
        return !stored || (!isEntryInvalidated(stored.metadata) && accept(stored));
      }).slice(0,4);
    if (previous.length) blocks.push(`Prompt memory nodes:\n${previous.map(row=>`- ${normalizeConversationSnippet(row.content,180)}`).join('\n')}`);
    const approvals = normalizeApprovals(state?.approvals).filter(row=>row.chatId===chat?.id || (project?.id && row.projectId===project.id)).slice(0,3);
    if (approvals.length) blocks.push(`Approval memory nodes:\n${approvals.map(row=>`- ${row.title} [${row.status}]${row.resultSummary ? ` :: ${row.resultSummary}` : ''}`).join('\n')}`);
    const tasks = normalizeTasks(state?.tasks).filter(row=>row.chatId===chat?.id || (project?.id && row.projectId===project.id)).slice(0,3);
    if (tasks.length) blocks.push(`Task memory nodes:\n${tasks.map(row=>`- ${row.title} [${row.status}]${row.latestNote ? ` :: ${normalizeConversationSnippet(row.latestNote,160)}` : ''}`).join('\n')}`);
  }
  onRecall?.(rendered);
  return blocks.join('\n\n');
}
