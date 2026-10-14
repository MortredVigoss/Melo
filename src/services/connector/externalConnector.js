import { normalizeEndpointBase, normalizeConnectorPath, maskSecret, normalizeManifestEntries, normalizeExternalConnectorManifest, normalizeExternalConnector } from '../../domain/connector/externalConnector.js';
export { normalizeEndpointBase, normalizeConnectorPath, maskSecret, normalizeManifestEntries, normalizeExternalConnectorManifest, normalizeExternalConnector };

export function externalConnectorUrl(connector, pathValue) {
  return `${normalizeEndpointBase(connector.endpoint)}${normalizeConnectorPath(pathValue, '/')}`;
}

export async function requestExternalConnectorJson(connector, pathValue, options = {}) {
  if (!connector.endpoint) {
    throw new Error('External connector endpoint is not configured.');
  }

  const response = await fetch(externalConnectorUrl(connector, pathValue), {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(connector.authToken ? { authorization: `Bearer ${connector.authToken}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(
      `Connector request failed (${response.status} ${response.statusText}): ${errorText}`,
    );
  }

  return response.json();
}

export async function refreshExternalConnectorStatus(connector, fallbackError = '') {
  try {
    let manifest = normalizeExternalConnectorManifest({});

    try {
      manifest = normalizeExternalConnectorManifest(
        await requestExternalConnectorJson(connector, connector.manifestPath),
      );
    } catch (error) {
      manifest = connector.manifest;
      if (!fallbackError) {
        fallbackError = error.message;
      }
    }

    try {
      await requestExternalConnectorJson(connector, connector.healthPath);
    } catch (error) {
      if (!manifest.tools.length && !manifest.resources.length && !manifest.prompts.length) {
        throw error;
      }
      if (!fallbackError) {
        fallbackError = error.message;
      }
    }

    return {
      ...connector,
      manifest,
      lastCheckedAt: nowIso(),
      lastStatus: 'connected',
      lastError: fallbackError,
      updatedAt: nowIso(),
    };
  } catch (error) {
    return {
      ...connector,
      lastCheckedAt: nowIso(),
      lastStatus: 'error',
      lastError: error.message,
      updatedAt: nowIso(),
    };
  }
}

export async function fetchExternalConnectorContext(connector, payload) {
  if (!connector.endpoint) {
    return '';
  }

  const response = await requestExternalConnectorJson(connector, connector.contextPath, {
    method: 'POST',
    body: payload,
  });

  if (typeof response?.context === 'string') {
    return response.context.slice(0, 3200);
  }

  if (Array.isArray(response?.items)) {
    return response.items
      .map(item => {
        if (typeof item === 'string') {
          return item;
        }
        return `${item?.title || 'Item'}\n${item?.content || ''}`.trim();
      })
      .join('\n\n')
      .slice(0, 3200);
  }

  return '';
}

export async function readExternalConnectorResourcePayload(connector, payload) {
  if (!connector.endpoint) {
    return {
      title: 'Resource unavailable',
      content: 'Connector endpoint is not configured.',
    };
  }

  const response = await requestExternalConnectorJson(connector, connector.resourcePath, {
    method: 'POST',
    body: payload,
  });

  return {
    title:
      response?.title ||
      response?.resource?.name ||
      response?.resourceId ||
      payload?.resourceId ||
      'Resource preview',
    content:
      typeof response?.content === 'string'
        ? response.content
        : JSON.stringify(response, null, 2),
  };
}

export async function readExternalConnectorPromptPayload(connector, payload) {
  if (!connector.endpoint) {
    return {
      title: 'Prompt unavailable',
      content: 'Connector endpoint is not configured.',
    };
  }

  const response = await requestExternalConnectorJson(connector, connector.promptPath, {
    method: 'POST',
    body: payload,
  });

  return {
    title:
      response?.title ||
      response?.prompt?.name ||
      response?.promptId ||
      payload?.promptId ||
      'Prompt preview',
    content:
      typeof response?.content === 'string'
        ? response.content
        : JSON.stringify(response, null, 2),
  };
}
import { nowIso } from '../../shared/helpers.js';
