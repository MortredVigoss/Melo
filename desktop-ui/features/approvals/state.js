// Approvals feature state (capability elevation, 2026-10-20). Owned by this
// feature; app.js neither reads nor writes it. The pending prompts themselves
// stay in the shared permission queue (toolPermissions()) next to the tool
// permission and file-safety requests the same stream delivers.
export function createApprovalsState() {
  return {
    // GET /api/capability-grants, refreshed at most every GRANTS_TTL_MS while a
    // grant list is on screen, after every decision and every revoke.
    grants: [],
    grantsLoadedAt: 0,
    grantsLoading: false,
    grantsError: '',
    // grant id → revoke in flight
    revoking: {},
    // The prompt whose primary button got focus (focus moves once per prompt).
    focusedRequestId: '',
  };
}

export let approvalsState = createApprovalsState();

export function resetApprovalsState() {
  approvalsState = createApprovalsState();
  return approvalsState;
}
