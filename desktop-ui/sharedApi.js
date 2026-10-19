// The shared request layer (architecture plan P2, features/README.md): the one
// JSON request helper app.js and every feature use. Moved out of app.js in
// P2c (2026-10-19) so it is tested as a module instead of as cut-out app.js
// source; the body is the former api() except that it reads the current page
// data through getBootstrap() and reports through showError().
//
// It sends the request's page-data baseline (x-melo-bootstrap-base), decodes
// bootstrap patches against that baseline and settles P1 committed saves: a
// { ok: true, receipt, bootstrapError } answer is never applied as page data —
// GET /api/bootstrap is fetched instead (bootstrapPatch.js settleCommittedSave).
import { decodeBootstrap, settleCommittedSave } from './bootstrapPatch.js';
import { t } from './i18n.js';

export function createSharedApi({ getBootstrap, showError, request = (...args) => fetch(...args) }) {
  return async function api(path, options = {}) {
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
      reload: () => api('/api/bootstrap'),
      current: () => getBootstrap(),
      notify: error => showError(`${t('已保存')} · ${error.message}`),
    });
  };
}
