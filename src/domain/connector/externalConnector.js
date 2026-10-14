// ─── External connector service ─────────────────────────────────────────────
// Pure HTTP + normalization helpers for the "external MCP-style connector"
// feature: an agent can point at an HTTP endpoint that advertises tools /
// resources / prompts via a manifest, answers /health, and fuses a context
// snippet into the chat prompt via /context.
//
// This module owns:
//   - normalizeEndpointBase / normalizeConnectorPath — URL shape helpers
//   - maskSecret — redacts authToken for UI display
//   - normalizeManifestEntries / normalizeExternalConnectorManifest —
//     canonicalizes the per-connector tool / resource / prompt lists
//   - normalizeExternalConnector — canonicalizes the persisted connector
//     record on load + write
//   - externalConnectorUrl — joins endpoint + path
//   - requestExternalConnectorJson — the single HTTP caller (with 15s timeout
//     and Bearer auth if configured)
//   - refreshExternalConnectorStatus — manifest + health re-fetch, used by
//     the "ping" button and after every create/update
//   - fetchExternalConnectorContext — POST /context, returns a string snippet
//   - readExternalConnectorResourcePayload / readExternalConnectorPromptPayload
//     — the "preview" paths the UI calls
//
// State mutations (addConnector / updateConnector / removeConnector / ping /
// invokeTool) stay in desktopStore.js because they read & write the shared
// state blob; this module is pure I/O + pure data.
//
// Extracted from desktopStore.js in the Phase 3 refactor (see
// _refactor-backup/REFACTOR_PLAN.md). No state dependencies, no imports from
// desktopStore.

import { randomUUID } from 'node:crypto';
import { nowIso, coerceIso } from '../../shared/helpers.js';

// titleCase stays local — it's only used here, not worth a shared-module hop.
function titleCase(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, match => match.toUpperCase());
}

// ─── URL + auth helpers ─────────────────────────────────────────────────────

export function normalizeEndpointBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function normalizeConnectorPath(value, fallback) {
  const normalized = String(value || fallback || '').trim() || fallback;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function maskSecret(value) {
  if (!value) {
    return '(not set)';
  }
  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

// ─── Manifest + connector record normalization ──────────────────────────────

export function normalizeManifestEntries(entries, kind) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.slice(0, 12).map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        id: `${kind}-${index + 1}`,
        name: entry,
        description: '',
      };
    }

    return {
      id: entry?.id || `${kind}-${index + 1}`,
      name: entry?.name || entry?.title || `${titleCase(kind)} ${index + 1}`,
      description: entry?.description || '',
    };
  });
}

export function normalizeExternalConnectorManifest(manifest) {
  return {
    tools: normalizeManifestEntries(manifest?.tools, 'tool'),
    resources: normalizeManifestEntries(manifest?.resources, 'resource'),
    prompts: normalizeManifestEntries(manifest?.prompts, 'prompt'),
  };
}

export function normalizeExternalConnector(connector) {
  return {
    id: connector?.id || randomUUID(),
    type: 'external-mcp',
    name: connector?.name || 'External connector',
    category: 'External',
    description:
      connector?.description ||
      'Expose an MCP-style external service with a manifest, health check, and context endpoint.',
    details:
      connector?.details ||
      'External connectors can advertise tools and resources, be health-checked from Melo, and contribute context into code mode.',
    prompt:
      connector?.prompt ||
      'An external MCP-style connector is available. Consider its advertised tools, resources, and fetched context when relevant.',
    endpoint: normalizeEndpointBase(connector?.endpoint),
    healthPath: normalizeConnectorPath(connector?.healthPath, '/health'),
    manifestPath: normalizeConnectorPath(connector?.manifestPath, '/manifest'),
    contextPath: normalizeConnectorPath(connector?.contextPath, '/context'),
    resourcePath: normalizeConnectorPath(connector?.resourcePath, '/resource'),
    promptPath: normalizeConnectorPath(connector?.promptPath, '/prompt'),
    invokePath: normalizeConnectorPath(connector?.invokePath, '/invoke'),
    authToken: typeof connector?.authToken === 'string' ? connector.authToken : '',
    createdAt: coerceIso(connector?.createdAt),
    updatedAt: coerceIso(connector?.updatedAt),
    lastCheckedAt: connector?.lastCheckedAt ? coerceIso(connector.lastCheckedAt) : null,
    lastStatus: ['idle', 'connected', 'error'].includes(connector?.lastStatus)
      ? connector.lastStatus
      : 'idle',
    lastError: typeof connector?.lastError === 'string' ? connector.lastError : '',
    manifest: normalizeExternalConnectorManifest(connector?.manifest),
  };
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

