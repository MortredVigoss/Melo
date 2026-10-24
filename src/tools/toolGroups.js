// Catalogs follow current capability/service configuration, not keywords.

export const TOOL_GROUP_IDS = Object.freeze(['browser', 'documents', 'media']);

export function toolGroupOf(toolId) {
  const id = String(toolId || '');
  if (/^browser_/.test(id)) return 'browser';
  if (id === 'pdf' || id === 'xlsx') return 'documents';
  if (id === 'image' || id === 'media_info' || id === 'media_api') return 'media';
  // web_screenshot is a small definition and sits in core next to fetch_url;
  // the routing prompt (not the definition list) says when not to use it.
  return 'core';
}

// Authorized document/media tools are available independent of wording.
// Browser automation additionally needs the user's explicit local opt-in.
export function wantedToolGroups({ searchPlan = null, env = {} } = {}) {
  const wanted = new Set(['documents', 'media']);
  if (env.MELO_CDP_ENABLED === '1' && !searchPlan?.sharedPlan?.network?.fetchForbidden &&
      !['user-disabled-network', 'network-forbidden'].includes(searchPlan?.reason)) wanted.add('browser');
  return wanted;
}

/** Compatibility merge for persisted history; not the current catalog policy. */
export function nextActivatedGroups(activated = [], wanted = new Set()) {
  return [...new Set([...(Array.isArray(activated) ? activated : []), ...wanted])].filter(id => TOOL_GROUP_IDS.includes(id)).sort();
}

/** Core tools plus activated extension groups, original order preserved. */
export function selectStableTools(tools = [], activatedGroups = []) {
  const active = new Set(activatedGroups);
  return (Array.isArray(tools) ? tools : []).filter(tool => {
    const group = toolGroupOf(tool?.id);
    return group === 'core' || active.has(group);
  });
}
