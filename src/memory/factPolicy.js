import { createHash } from 'node:crypto';

export const normalizedFact = text => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function factId(chatId, fact) {
  return `promoted:${createHash('sha256').update(`${chatId}\n${normalizedFact(fact)}`).digest('hex').slice(0, 32)}`;
}

// Unknown subjects coexist. Similar wording alone is never evidence of a correction.
export function factSubject(fact) {
  if (fact.subjectKey) return String(fact.subjectKey).trim().toLowerCase();
  const text=String(fact.fact || '');
  if (fact.category === 'identity') return text.match(/^\s*([\p{L}\s]{1,24})[:：]/u)?.[1]?.trim().toLowerCase() || '';
  if (fact.category !== 'correction') return '';
  if (/\bES20\d\d\b/i.test(text)) return 'build.ecmascript';
  if (/部署端口|deployment port/i.test(text)) return 'deployment.port';
  if (/回复.{0,6}(中文|英文)|reply language/i.test(text)) return 'reply.language';
  return '';
}

export const isLocalChat = chat => !chat?.source || ['desktop','mobile','ios','iphone'].includes(chat.source);
export function factNamespace(chat, scope='chat', agentId=chat?.agentId || 'main') {
  if (isLocalChat(chat)) {
    if (scope==='project' && chat.projectId) return `project:${chat.projectId}`;
    if (scope==='agent') return `agent:${agentId}`;
    if (scope==='personal') return 'user:local';
  }
  return `chat:${chat.id}`;
}

export function canRecallMemory(entry, {chat,agentId,projectId,deletedChatIds}={}) {
  const m=entry.metadata || {};
  if (deletedChatIds?.has(m.chatId)) return false;
  if (m.forgotten || m.quarantined || m.sourceDeleted || m.mobileSyncConflict) return false;
  if (entry.kind==='session-fact' || entry.kind==='verification-correction') {
    const scope=m.scope || 'chat';
    if (scope==='chat') return !!chat?.id && m.chatId===chat.id;
    // Sharing is explicit and local. Remote/private/group audiences never inherit
    // the desktop owner's facts merely because they use the same Agent.
    if (!isLocalChat(chat) || m.audience!=='local') return false;
    if (scope==='personal') return true;
    if (scope==='project') return !!projectId && m.projectId===projectId;
    return scope==='agent' && m.agentId===agentId;
  }
  if (entry.kind==='fact' && m.chatId && m.chatId!==chat?.id && !m.scope) return false;
  return true;
}
