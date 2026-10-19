// The projects feature's limited request interface (architecture plan P2).
// `request` is app.js's shared api(): it already turns a committed save whose
// page data could not be rebuilt ({ ok, receipt, bootstrapError }, P1) into a
// fresh bootstrap, so both calls always resolve to page data.
export function createProjectsApi(request) {
  return {
    create: body => request('/api/projects', { method: 'POST', body }),
    update: (projectId, patch) => request('/api/projects/update', { method: 'POST', body: { projectId, patch } }),
  };
}
