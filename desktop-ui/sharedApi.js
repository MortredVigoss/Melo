// The shared request layer (architecture plan P2, features/README.md): the one
// JSON request helper app.js and every feature use. Moved out of app.js in
// P2c (2026-10-19) so it is tested as a module instead of as cut-out app.js
// source. It reads current page data through getBootstrap(); committed
// commands awaiting recovery notify app.js through onRecoveryChange().
//
// It sends the request's page-data baseline (x-melo-bootstrap-base), decodes
// bootstrap patches against that baseline and settles P1 committed saves: a
// { ok: true, receipt, bootstrapError } answer is never applied as page data —
// GET /api/bootstrap is fetched instead (bootstrapPatch.js settleCommittedSave).
import { decodeBootstrap, settleCommittedSave } from './bootstrapPatch.js';

const RECEIPT_ROUTES = new Set(['/api/projects', '/api/projects/update', '/api/agents/create-custom', '/api/agents/update', '/api/agents/channel/test']);

export function createSharedApi({ getBootstrap, onRecoveryChange = () => {}, request = (...args) => fetch(...args) }) {
  const pending = new Map();
  const inFlight = new Map();
  let sequence = 0;

  function recover({ receipt, error, reload }) {
    return new Promise(resolve => {
      const id = ++sequence;
      pending.set(id, { id, receipt, error, reload, resolve, retrying: false });
      onRecoveryChange();
    });
  }

  async function send(path, options) {
    // Keep the request's exact baseline even if another response arrives first.
    const base = getBootstrap()?._snapshot ? structuredClone(getBootstrap()) : null;
    const response = await request(path, {
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        ...(base ? { 'x-melo-bootstrap-base': base._snapshot.token } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Request failed.');
    }

    // A project/Agent save that committed but could not rebuild the page data
    // answers { ok, receipt, bootstrapError } (P1, src/http/bootstrapAfterCommit.js):
    // reload the bootstrap instead of applying the receipt, for every caller.
    return settleCommittedSave(decodeBootstrap(payload, base), {
      reload: () => api('/api/bootstrap', { signal: AbortSignal.timeout(15_000) }),
      recover,
    });
  }

  function api(path, options = {}) {
    // A repeated click while a committed command awaits page data shares its
    // original result. Never send the mutation again to recover a failed GET.
    if ((options.method || 'GET') !== 'POST' || !RECEIPT_ROUTES.has(path)) return send(path, options);
    const key = `${path}:${JSON.stringify(options.body || null)}`;
    if (!inFlight.has(key)) {
      inFlight.set(key, send(path, options).finally(() => inFlight.delete(key)));
    }
    return inFlight.get(key);
  }

  api.pendingSaves = () => [...pending.values()].map(({ id, receipt, retrying }) => ({ id, receipt, retrying }));
  api.retryCommittedSave = async id => {
    const entry = pending.get(Number(id));
    if (!entry || entry.retrying) return;
    entry.retrying = true;
    onRecoveryChange();
    try {
      const bootstrap = await entry.reload();
      pending.delete(entry.id);
      entry.resolve(bootstrap);
    } catch (error) {
      entry.error = error;
    } finally {
      entry.retrying = false;
      onRecoveryChange();
    }
  };
  return api;
}
