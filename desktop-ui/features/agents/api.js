// The Agent settings feature's limited request interface (architecture plan
// P2b). `request` is app.js's shared api(): JSON body in, decoded JSON out,
// throws on HTTP errors, and it already turns a committed save whose page data
// could not be rebuilt ({ ok, receipt, bootstrapError }, P1) into a fresh
// bootstrap that keeps receipt.agentExportWarning. URLs and bodies are exactly
// what the page sent before the move.
export function createAgentsApi(request) {
  return {
    createCustom: () => request('/api/agents/create-custom', { method: 'POST', body: {} }),
    // Save (global or project override), Markdown / channel autosaves and
    // clearProjectOverride all use this route.
    update: body => request('/api/agents/update', { method: 'POST', body }),
    testChannel: body => request('/api/agents/channel/test', { method: 'POST', body }),
    confirmSettings: body => request('/api/agent-settings-sync/confirm', { method: 'POST', body }),
    bootstrap: () => request('/api/bootstrap'),
    // Re-applies the saved MiniMax voice's tuning to the global TTS settings.
    saveModelSettings: body => request('/api/settings/model', { method: 'POST', body }),
    // Unload path (pagehide / beforeunload): fire-and-forget, so it cannot go
    // through request(). `body` is the JSON string.
    beaconUpdate: body => {
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(
            '/api/agents/update',
            new Blob([body], { type: 'application/json' }),
          );
        } else {
          fetch('/api/agents/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {});
        }
      } catch {}
    },
  };
}
