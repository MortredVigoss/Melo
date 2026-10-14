// Checkpoint manifest projection; byte-for-byte port from chatPersistence.js.
export function serializeChatForPersistence(chat) {
  return {
    id: chat.id,
    checkpointId: chat.checkpointId || null,
    title: chat.title,
    mode: chat.mode,
    projectId: chat.projectId || null,
    agentId: chat.agentId || 'main',
    modelSelection: chat.modelSelection || null,
    contextArtifactIds: chat.contextArtifactIds || [],
    source: chat.source || 'desktop',
    chatType: chat.chatType || 'private',
    chatTitle: chat.chatTitle || '',
    messageThreadId: chat.messageThreadId || null,
    externalThreadKey: chat.externalThreadKey || '',
    locked: Boolean(chat.locked),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

