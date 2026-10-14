import { isDeepStrictEqual } from 'node:util';
import { measureStageSync } from '../runtime/performanceTrace.js';

// Compatibility snapshots stay mutable for existing services. Large transcript
// fields are copied on first access, not during a settings/selection read. The
// committed objects never escape this module through these accessors.
const drafts = new WeakMap();
const deferredFields = new Set(['messages', 'sessionMemory']);

export function ownChat(original) {
  const small = Object.fromEntries(Object.entries(original).filter(([key]) => !deferredFields.has(key)));
  const chat = structuredClone(small);
  const unaccessed = new Set();
  for (const key of deferredFields) {
    if (!Object.hasOwn(original, key)) continue;
    unaccessed.add(key);
    Object.defineProperty(chat, key, {
      enumerable: true, configurable: true,
      get() {
        const value = measureStageSync('state.chat.copy', () => structuredClone(original[key]));
        Object.defineProperty(chat, key, { value, enumerable: true, configurable: true, writable: true });
        unaccessed.delete(key);
        return value;
      },
      set(value) {
        Object.defineProperty(chat, key, { value, enumerable: true, configurable: true, writable: true });
        unaccessed.delete(key);
      },
    });
  }
  drafts.set(chat, { original, unaccessed });
  return chat;
}

export function chatUnchanged(chat, original) {
  if (chat === original) return true;
  const draft = drafts.get(chat);
  if (Object.keys(chat).length !== Object.keys(original).length) return false;
  return Object.keys(original).every(key => {
    if (!Object.hasOwn(chat, key)) return false;
    if (draft?.original === original && draft.unaccessed.has(key) && Object.getOwnPropertyDescriptor(chat,key)?.get) return true;
    return isDeepStrictEqual(chat[key], original[key]);
  });
}

export function ownSnapshot(committed) {
  const { chats, ...metadata } = committed;
  return { ...structuredClone(metadata), chats: (chats || []).map(ownChat) };
}

export function unchangedChats(state, committed) {
  const byId = new Map((committed?.chats || []).map(chat => [chat.id, chat]));
  return new Set(state.chats.filter(chat => byId.has(chat.id) && chatUnchanged(chat, byId.get(chat.id))).map(chat => chat.id));
}

export function commitSnapshot(state, previous, unchanged = new Set()) {
  const byId = new Map((previous?.chats || []).map(chat => [chat.id, chat]));
  const { chats, ...metadata } = state;
  return { ...structuredClone(metadata), chats: chats.map(chat => unchanged.has(chat.id) && byId.has(chat.id)
    ? byId.get(chat.id) : structuredClone(chat)) };
}

export function metadataJson(state) {
  // Comparison intentionally excludes transcript content. Unchanged chat
  // detection above checks only bodies actually accessed by the mutation.
  return JSON.stringify({ ...state, chats: state.chats.map(chat => chat.id) });
}

export function chatPreviewSource(chat) {
  const draft = drafts.get(chat);
  const messages = draft?.unaccessed.has('messages') ? draft.original.messages : chat.messages;
  let lastMessage;
  for (let index = (messages?.length || 0) - 1; index >= 0; index--) {
    if (messages[index].role !== 'system') { lastMessage = messages[index]; break; }
  }
  return { lastMessage: lastMessage ? structuredClone(lastMessage) : undefined, messageCount: messages?.length || 0 };
}
