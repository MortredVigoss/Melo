// The only requests the approvals feature makes, through app.js's shared api()
// (JSON in / out, throws Error(payload.error) on HTTP errors).
export function createApprovalsApi(request) {
  return {
    // { requestId, decision: 'run' | 'project' | 'always' | 'deny' }
    respondCapability: body => request('/api/capability-requests/respond', { method: 'POST', body }),
    grants: () => request('/api/capability-grants'),
    revokeGrant: id => request('/api/capability-grants/revoke', { method: 'POST', body: { id } }),
  };
}
