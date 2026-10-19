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

// Architecture plan P1 (src/http/bootstrapAfterCommit.js): a project or Agent
// save that committed but could not rebuild the page data answers HTTP 200
// `{ ok: true, receipt, bootstrapError }` instead of a bootstrap.
export function committedWithoutBootstrap(payload) {
  return payload?.ok === true && Boolean(payload.bootstrapError) && !payload.settings;
}

// Keep command identity outside the page-data / transport format. A recovery
// may land after the user selected a different Agent in another request.
const committedReceipts = new WeakMap();
export const committedSaveReceipt = bootstrap => committedReceipts.get(bootstrap);

// A committed command must not resolve with stale page data. Its caller keeps
// its busy flag and draft until GET succeeds; recover exposes a read-only
// retry to the user instead of returning the old snapshot or repeating POST.
export async function settleCommittedSave(payload, { reload, recover }) {
  if (!committedWithoutBootstrap(payload)) return payload;
  const warning = payload.receipt?.agentExportWarning;
  const readCommitted = async () => {
    const next = await reload();
    if (!next?.settings || committedWithoutBootstrap(next) ||
        (Number.isFinite(payload.receipt?.revision) &&
         !(Number(next.stateRevision) >= payload.receipt.revision))) {
      throw new Error('Saved page data is not available yet.');
    }
    return next;
  };
  let bootstrap;
  try {
    bootstrap = await readCommitted();
  } catch (error) {
    bootstrap = await recover({ receipt: payload.receipt, error, reload: readCommitted });
  }
  const result = warning ? { ...bootstrap, agentExportWarning: warning } : bootstrap;
  committedReceipts.set(result, payload.receipt);
  return result;
}
