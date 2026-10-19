// The memory feature's limited request interface (architecture plan P2).
// `request` is app.js's shared api(): JSON body in, decoded JSON out, throws
// on HTTP errors. URLs and bodies are exactly what the page sent before.
export function createMemoryApi(request) {
  return {
    status: () => request('/api/memory/status'),
    facts: (query, offset) => request(`/api/memory/facts?q=${encodeURIComponent(query || '')}&offset=${offset || 0}`),
    updateFact: (id, patch) => request('/api/memory/facts/update', { method: 'POST', body: { id, patch } }),
    repair: () => request('/api/memory/repair', { method: 'POST', body: {} }),
    diagnose: () => request('/api/memory/diagnose', {}),
    connect: connection => request('/api/memory/connect', { method: 'POST', body: connection }),
    wipeEmbeddings: () => request('/api/memory/wipe-embeddings', { method: 'POST', body: { confirm: 'YES, WIPE EMBEDDINGS' } }),
    projectBook: projectId => request(`/api/projects/memory-book?projectId=${encodeURIComponent(projectId)}`),
    addProjectBookRow: body => request('/api/projects/memory-book', { method: 'POST', body }),
  };
}
