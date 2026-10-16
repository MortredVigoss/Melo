export function decodeBootstrap(payload, base) {
  if (payload?.bootstrap) return { ...payload, bootstrap: decodeBootstrap(payload.bootstrap,base) };
  if (payload?.kind !== 'bootstrap-patch') return payload;
  if (!base || base._snapshot?.token !== payload.baseToken) throw Error('Bootstrap baseline unavailable');
  const next = { ...base, ...payload.set, _snapshot: payload._snapshot };
  for (const key of payload.remove || []) delete next[key];
  return next;
}

export function olderBootstrap(incoming, current) {
  if (!incoming?._snapshot || !current?._snapshot || incoming._snapshot.epoch !== current._snapshot.epoch) return false;
  if (incoming._snapshot.stateRevision !== current._snapshot.stateRevision) return incoming._snapshot.stateRevision < current._snapshot.stateRevision;
  return incoming._snapshot.sequence < current._snapshot.sequence;
}

export function changedBootstrapSections(previous, next) {
  if (!previous) return null;
  return new Set([...new Set([...Object.keys(previous),...Object.keys(next)])]
    .filter(key => key !== '_snapshot' && key !== 'stateRevision' && JSON.stringify(previous[key]) !== JSON.stringify(next[key])));
}

export function pageAffected(view, sections) {
  if (!sections) return true;
  if (sections.has('settings')) return true;
  const shared = ['conversationProfiles','customize','syncConflicts'];
  const fields = {
    chat: ['workspace','activeChat','activeChatArtifacts','chats','projects','tasks','approvals'],
    settings: ['profile'], model: [], agent: ['activeProject'], customize: ['activeProject'],
    projects: ['projects','activeProject','projectArtifacts','tasks','approvals','workspace'],
    artifacts: ['artifacts','projects','activeChatArtifacts','projectArtifacts'],
    chats: ['chats','recents','projects'], search: ['search','workspace','artifacts','chats'],
  };
  if (!Object.hasOwn(fields,view)) return true;
  return [...shared,...fields[view]].some(key=>sections.has(key));
}
