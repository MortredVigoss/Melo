// Connector prompt summarization — sub-phase 7d-5β of the desktopStore
// decomposition. Pure leaf: filter enabled connectors, format their
// `name` + `prompt` into the system-prompt block. Byte-for-byte port from
// desktopStore.js (CLAUDE.md §5).

export function summarizeConnectorPrompts(connectors) {
  return connectors
    .filter(connector => connector.enabled)
    .map(connector => `Connector: ${connector.name}\n${connector.prompt}`)
    .join('\n\n');
}
