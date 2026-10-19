import { getDesktopBootstrap } from '../services/desktop/bootstrap.js';
import { sendJson } from './transport.js';

// Compatibility adapter (architecture plan P1, 2026-10-19). Project and Agent
// mutations return a commit receipt; existing desktop clients still expect
// every save to answer with the whole desktop bootstrap. Transport rebuilds it
// here after the commit, exactly as the mutations used to, so the old URLs,
// request bodies and successful response bytes stay the same.
//
// Error semantics: once the mutation has committed, a failure while building
// the follow-up page data never turns the save into an error. The response
// stays HTTP 200 with `{ ok: true, receipt, bootstrapError }`; the client
// must reload the bootstrap instead of retrying the save (retrying a create
// would duplicate the project or Agent). Errors thrown by the mutation itself
// still propagate unchanged. See docs/backend-architecture.md.

const RECORD_FIELDS = ['project', 'projects', 'agent'];

// Records stay out of the HTTP fallback (Agent records carry channel
// credentials); the client reads committed data through the bootstrap reload.
export function receiptSummary(receipt = {}) {
  const summary = Object.fromEntries(Object.entries(receipt).filter(([key]) => !RECORD_FIELDS.includes(key)));
  if (receipt.project?.id && !Object.hasOwn(summary, 'projectId')) summary.projectId = receipt.project.id;
  return summary;
}

// Legacy response: the bootstrap, plus the Agent Markdown export warning that
// the mutation used to merge into it.
export async function sendBootstrapAfterCommit(response, receipt, { buildBootstrap = getDesktopBootstrap } = {}) {
  let bootstrap;
  try {
    bootstrap = await buildBootstrap();
  } catch (error) {
    console.warn(`Bootstrap after committed save failed: ${error?.message || error}`);
    sendJson(response, 200, {
      ok: true,
      receipt: receiptSummary(receipt),
      bootstrapError: { code: 'BOOTSTRAP_UNAVAILABLE', message: String(error?.message || error) },
    });
    return;
  }
  sendJson(response, 200, receipt?.agentExportWarning ? { ...bootstrap, agentExportWarning: receipt.agentExportWarning } : bootstrap);
}
