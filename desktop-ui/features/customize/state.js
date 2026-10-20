// Feature-owned state of the Customize page (architecture B3 step 2):
// skill filter, skill-run telemetry, file-safety allowlist, domain cookies,
// the Tools & Tasks (advanced) status cache, the skill detail tab and the
// SKILL.md cache. app.js never reads or writes it. The initialisers are the
// ones app.js's uiState carried before the move.
export const customizeState = createCustomizeState();

export function createCustomizeState() {
  return {
    // Phase 3.3.2 — Customize → Skills filter state. `query` is a free-form
    // search over name/description/tags/triggers. `tag` narrows to skills
    // that carry a specific tag (null = no tag filter). `state` is one of
    // 'all' | 'enabled' | 'disabled' | 'custom' | 'builtin' | 'disk'.
    skillFilter: {
      query: '',
      tag: null,
      state: 'all',
    },
    // Phase 3.3.4 — skill-run telemetry shown in the Customize → Skills
    // health panel. Lazily populated when the user opens the Skills tab;
    // `loading` guards concurrent refetches.
    skillRunStats: {
      loading: false,
      loaded: false,
      skills: [],
      error: null,
    },
    // File-safety persistent allowlist (Phase 3b/3c). Lazy-loaded on first
    // navigation to the Safety section; refresh-on-demand otherwise.
    safetyAllowlist: {
      loading: false,
      loaded: false,
      rules: [],
      error: null,
      pendingRemoveId: null,
    },
    // Domain cookies (Phase 4 — Xiaohongshu/Douyin extraction reliability).
    // Lives in the Safety section alongside the file-safety allowlist
    // because both are persistent grants the user trades for capability.
    // The list-side never returns cookie values — only host + length +
    // tail preview — so the DOM never holds the session secret.
    domainCookies: {
      loading: false,
      loaded: false,
      hosts: [],
      error: null,
      addHost: '',
      addCookie: '',
      addInFlight: false,
      addError: '',
      pendingRemoveHost: null,
    },
    // Advanced page (developer / experimental ops). Caches CLI MCP server
    // names, plugin registry, and background-task list — none of these
    // ride on bootstrap, so we lazy-fetch on first navigation and keep the
    // values around until an explicit Refresh.
    advanced: {
      loading: false,
      loaded: false,
      error: null,
      cliServers: [],
      plugins: [],
      tasks: [],
      diagnostics: null,
    },
    // Phase 3 — Skill detail tab: 'overview' (default) or 'markdown'.
    skillDetailTab: 'overview',
    // Cache: skillId → { loading, markdown, error }.  Cleared on import/reload.
    skillMarkdown: {},
  };
}

export function resetCustomizeState() {
  Object.assign(customizeState, createCustomizeState());
}
