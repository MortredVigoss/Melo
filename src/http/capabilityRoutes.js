// Capability elevation routes (2026-10-20). The only way a grant is created is
// a user decision on a live request id, posted from the desktop UI. Writes are
// local-write (origin gate); the request ids exist only in the desktop SSE
// stream, never in prompts or tool output.
import { createRouteRegistry } from './routeRegistry.js';
import { readJsonBody, sendJson } from './transport.js';
import { CAPABILITY_ELEVATION } from '../domain/agent/capabilityElevation.js';
import { listGrants, respondCapabilityRequest, revokeGrant } from '../services/agent/capabilityElevation.js';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT_ID = /^cg_[0-9a-f-]{36}$/i;
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;

async function body(request, response) {
  try {
    const value = await readJsonBody(request, { maxBytes: 4096 });
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (error) {
    sendJson(response, error.statusCode || 400, { ok: false, error: error.code || 'INVALID_JSON', message: error.message });
    return null;
  }
  sendJson(response, 400, { ok: false, error: 'INVALID_BODY', message: 'Request body must be a JSON object.' });
  return null;
}

const fail = (response, error) => sendJson(response, error.statusCode || 500, { ok: false, error: error.code || 'CAPABILITY_REQUEST_FAILED', message: error.message });

// `home` is captured when the server starts (CLAUDE.md §6), never read per request.
export function createCapabilityRoutes({ home }) {
  return createRouteRegistry([
    { method: 'POST', path: '/api/capability-requests/respond', auth: 'local-write', handler: async ({ request, response }) => {
      const input = await body(request, response);
      if (!input) return;
      const { requestId, decision } = input;
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) { sendJson(response, 400, { ok: false, error: 'INVALID_REQUEST_ID', message: 'requestId must be a request id.' }); return; }
      if (!CAPABILITY_ELEVATION.responses.includes(decision)) { sendJson(response, 400, { ok: false, error: 'INVALID_CAPABILITY_DECISION', message: `decision must be one of ${CAPABILITY_ELEVATION.responses.join(', ')}.` }); return; }
      try { sendJson(response, 200, await respondCapabilityRequest(requestId, decision, { home })); }
      catch (error) { fail(response, error); }
    } },
    { method: 'GET', path: '/api/capability-grants', auth: 'local-read', handler: async ({ response, url }) => {
      const agentId = url.searchParams.get('agentId');
      if (agentId !== null && !AGENT_ID.test(agentId)) { sendJson(response, 400, { ok: false, error: 'INVALID_AGENT_ID', message: 'agentId is invalid.' }); return; }
      try { sendJson(response, 200, { ok: true, grants: listGrants({ home, agentId }) }); }
      catch (error) { fail(response, error); }
    } },
    { method: 'POST', path: '/api/capability-grants/revoke', auth: 'local-write', handler: async ({ request, response }) => {
      const input = await body(request, response);
      if (!input) return;
      if (typeof input.id !== 'string' || !GRANT_ID.test(input.id)) { sendJson(response, 400, { ok: false, error: 'INVALID_GRANT_ID', message: 'id must be a grant id.' }); return; }
      try {
        const grant = revokeGrant(input.id, { home });
        if (!grant) { sendJson(response, 404, { ok: false, error: 'CAPABILITY_GRANT_NOT_FOUND', message: 'Unknown or expired grant.' }); return; }
        sendJson(response, 200, { ok: true, grant });
      } catch (error) { fail(response, error); }
    } },
  ]);
}
