import { currentRequestContext } from '../../runtime/requestScope.js';
import { COMMON_TOOLS, normalizeRuntimeConfig, normalizeSearchResponse, validateCommonTool, searchRequest } from '../../../shared/agent/tools.js';
import { createHash } from 'node:crypto';

function endpointURL(value, debug) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(debug && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('SEARCH_ENDPOINT_INVALID');
  return url;
}

export function searchCredentialId(endpoint) { return createHash('sha256').update(new URL(endpoint).toString()).digest('hex'); }

async function boundedJSON(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 262_144) { await response.body.cancel().catch(() => {}); throw new Error('SEARCH_RESPONSE_LIMIT'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createSharedSearchTool(legacyTool) {
  const spec = COMMON_TOOLS.find(tool => tool.name === 'web_search');
  return {
    id: spec.name, name: 'Web Search', category: 'web', description: spec.description,
    parametersSchema: spec.parameters, requiresPermission: false, isConcurrencySafe: false,
    capability: 'network', needsWorkspace: false, uiModule: 'search', inputKeys: ['query'],
    examples: [{ query: 'Surry Hills restaurants', maxResults: 6 }],
    async run(args, options = {}) {
      // Bind every config, secret and environment dependency before awaiting IO.
      const context = options.requestContext || currentRequestContext();
      const capturedConfig = options.config || context?.config || {};
      const env = context?.env || {};
      const search = normalizeRuntimeConfig(capturedConfig.agentRuntime).search;
      const slot = search.endpoint ? (() => { try { return searchCredentialId(search.endpoint); } catch { return ''; } })() : '';
      const stored = slot && typeof capturedConfig.searchCredentials?.[slot] === 'string' ? capturedConfig.searchCredentials[slot] : '';
      const credential = options.searchCredential ?? (search.credentialRef === 'search' ? stored || (env.MELO_SEARCH_ENDPOINT === search.endpoint ? env.MELO_SEARCH_API_KEY : '') : '');
      const debug = env.MELO_TEST_MODE === '1' || options.fixture === true;
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(20_000)].filter(Boolean));
      const failure = code => ({ ok: false, error: code, output: JSON.stringify({ ok: false, error: code, results: [], backend: search.backend }) });
      try {
        validateCommonTool(spec.name, args);
        if (search.backend === 'http' && search.endpoint) {
          if (credential && (!/^[\x21-\x7e]{1,4096}$/u.test(credential))) return failure('SEARCH_CREDENTIAL_INVALID');
          if (search.credentialRef && !credential) return failure('SEARCH_CREDENTIAL_UNAVAILABLE');
          const endpoint = endpointURL(search.endpoint, debug);
          const effect = searchRequest(args, { search });
          const target = endpointURL(effect.url, debug);
          if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname) return failure('SEARCH_ENDPOINT_INVALID');
          const response = await fetch(target, { method: effect.method, redirect: 'error', signal,
            headers: { 'content-type': 'application/json', accept: 'application/json', ...(credential ? { [effect.credentialHeader]: effect.credentialPrefix + credential } : {}) },
            ...(effect.body ? { body: JSON.stringify(effect.body) } : {}) });
          if (!response.ok) { await response.body?.cancel(); return failure('SEARCH_HTTP_' + response.status); }
          const result = normalizeSearchResponse(await boundedJSON(response), { fetchedAt: new Date().toISOString(), backend: effect.backend });
          return { ok: result.ok, status: result.status, code: result.code, output: JSON.stringify(result), error: result.error, meta: { results: result.results, provider: result.backend, fetchedAt: result.fetchedAt, freshness: result.freshness,
            progressKey: createHash('sha256').update(JSON.stringify(result.results)).digest('hex') } };
        }
        if (search.browserFallback && legacyTool) return legacyTool.run({ query: args.query, num_results: args.maxResults || 6 }, options);
        return failure('SEARCH_UNAVAILABLE');
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        return failure(error.code === 'INVALID_TOOL_ARGUMENTS' ? error.code : 'SEARCH_REQUEST_FAILED');
      }
    },
  };
}
