import { validateTaskSync, mergeTaskSync } from './taskProtocol.js';
import { validateWorkspace, mergeWorkspaces } from './workspaceProtocol.js';
// The v1 text envelope optionally carries versioned workspace context. Credentials,
// local attachment files and execution permissions stay on each device.
import { validSyncID as id, validMessageID } from './identifiers.js';
import { syncSchema } from './syncContract.generated.js';
import { validateSchema } from './schemaValidator.js';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function validateSnapshot(value) {
  validateSchema(value,syncSchema.$defs.snapshot,syncSchema);
  if (value?.version !== 1 || !Array.isArray(value.chats)) throw new Error('Invalid sync snapshot');
  const seen = new Set();
  return { version: 1, deletedChats: mergeDeletedChats(value.deletedChats), ...(value.workspace ? {workspace:validateWorkspace(value.workspace)} : {}), ...((value.tasks || value.handoffs) ? validateTaskSync(value) : {}), chats: value.chats.map(chat => {
    if (!id(chat.id) || seen.has(chat.id) || typeof chat.title !== 'string' || chat.title.length > 500 || !date(chat.createdAt) || !date(chat.updatedAt) || !Array.isArray(chat.messages)) throw new Error('Invalid conversation');
    seen.add(chat.id);
    const messages = new Set();
    return { id: chat.id, title: chat.title, createdAt: new Date(chat.createdAt).toISOString(), updatedAt: new Date(chat.updatedAt).toISOString(), messages: chat.messages.map(message => {
      if (!validMessageID(message.id) || messages.has(message.id) || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !date(message.createdAt)) throw new Error('Invalid message');
      messages.add(message.id);
      return { id: message.id, role: message.role, content: message.content, createdAt: new Date(message.createdAt).toISOString() };
    }) };
  }) };
}
export function mergeSnapshots(left, right) {
  left = validateSnapshot(left); right = validateSnapshot(right);
  const deletedChats = mergeDeletedChats(left.deletedChats, right.deletedChats);
  const deleted = new Set(deletedChats.map(row => row.id));
  const chats = new Map(left.chats.filter(chat => !deleted.has(chat.id)).map(chat => [chat.id, chat]));
  for (const incoming of right.chats) {
    if (deleted.has(incoming.id)) continue;
    const existing = chats.get(incoming.id);
    if (!existing) { chats.set(incoming.id, incoming); continue; }
    const messages = new Map(existing.messages.map(message => [message.id, message]));
    for (const message of incoming.messages) {
      const previous = messages.get(message.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw Object.assign(new Error('Message identity conflict; no data overwritten'), { status: 409 });
      messages.set(message.id, message);
    }
    const newer = incoming.updatedAt > existing.updatedAt || (incoming.updatedAt === existing.updatedAt && incoming.title > existing.title) ? incoming : existing;
    chats.set(existing.id, { ...newer, createdAt: [existing.createdAt, incoming.createdAt].sort()[0], messages: [...messages.values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) });
  }
  return validateSnapshot({ version: 1, deletedChats, ...((left.workspace || right.workspace)?{workspace:mergeWorkspaces(withoutDeletedChatContext(left.workspace, deletedChats),withoutDeletedChatContext(right.workspace, deletedChats))}:{}), ...((left.tasks || right.tasks || left.handoffs || right.handoffs) ? mergeTaskSync(left,right) : {}), chats: [...chats.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) });
}

// Absence in a snapshot never means deletion. Tombstones survive indefinitely
// because an offline device can reconnect arbitrarily late; restoration uses a new ID.
export function mergeDeletedChats(...lists) {
  const result = new Map();
  for (const list of lists) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error('Invalid conversation deletions');
    for (const row of list) {
      if (!row || !id(row.id) || !date(row.deletedAt)) throw new Error('Invalid conversation deletion');
      const deletedAt = new Date(row.deletedAt).toISOString();
      const old = result.get(row.id);
      if (!old || old.deletedAt < deletedAt) result.set(row.id, {id:row.id, deletedAt});
    }
  }
  return [...result.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
export function withoutDeletedChatContext(workspace, deletedChats = []) {
  if (!workspace) return workspace;
  const deleted = new Set(deletedChats.map(row=>row.id));
  return {...workspace, records:workspace.records.filter(row =>
    !(row.kind === 'conversation' && deleted.has(row.id)) &&
    !(['message','memory'].includes(row.kind) && row.versions.some(v => deleted.has(v.value.chatId))))};
}
export function requireDeletionAcknowledgement(sent, received) {
  const returned = new Map(mergeDeletedChats(received.deletedChats).map(row=>[row.id,row.deletedAt]));
  if (mergeDeletedChats(sent.deletedChats).some(row=>!returned.has(row.id) || returned.get(row.id) < row.deletedAt)) {
    throw new Error('Sync service did not acknowledge deletions; update the sync service. Local data preserved.');
  }
}
