// Pure dispatcher for the first-boot productivity-MCP consent
// modal's two click paths. Lifted out of the event handler in
// `app.js` so the request sequence is testable without booting a
// browser or fake `document` (Codex audit 2026-04-29 ⚪): user
// clicks "Skip" → only `productivityMcpsConsented: true` writes;
// user clicks "Enable all" → three `/api/mcp/preset-toggle` POSTs
// flip the flags on, THEN the consent flag commits. Either path
// ends the modal forever on this MELO_HOME.

export const PRODUCTIVITY_MCP_FLAGS = Object.freeze([
  'enableAntvChartMcp',
  'enableMarkdown2PdfMcp',
  'enableMermaidMcp',
]);

/**
 * Run the consent choice. Returns the list of API calls actually
 * dispatched, in order, so a node:test fake can introspect the
 * sequence. Errors propagate so the caller can paint a toast.
 *
 * @param {object} args
 * @param {boolean} args.enableAll  - true for "Enable all", false for "Skip"
 * @param {(path: string, init: object) => Promise<any>} args.apiFn  - injected `api()` (POST helper)
 * @returns {Promise<Array<{ path: string, body: object }>>} dispatched calls (in order)
 */
export async function runProductivityMcpsConsentChoice({ enableAll, apiFn }) {
  if (typeof apiFn !== 'function') {
    throw new TypeError('apiFn must be a function');
  }
  const dispatched = [];
  if (enableAll) {
    for (const flag of PRODUCTIVITY_MCP_FLAGS) {
      const body = { flag, enabled: true };
      await apiFn('/api/mcp/preset-toggle', { method: 'POST', body });
      dispatched.push({ path: '/api/mcp/preset-toggle', body });
    }
  }
  const consentBody = { productivityMcpsConsented: true };
  await apiFn('/api/settings/model', { method: 'POST', body: consentBody });
  dispatched.push({ path: '/api/settings/model', body: consentBody });
  return dispatched;
}
