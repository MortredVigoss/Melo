import { toolCatalog, validateCommonTool, normalizeFetchedPage } from '../../../shared/agent/tools.js';
import { createHash } from 'node:crypto';

/** Common function contract; native readers stay Host-owned. Browser use is explicit. */
export function createSharedFetchTool(reader) {
  const spec = toolCatalog(['fetch_url'])[0];
  return { ...reader, description: spec.description, parametersSchema: spec.parameters, inputKeys: ['url'],
    async run(args, options) {
      validateCommonTool('fetch_url', args);
      const result = await reader.run({ url: args.url, extract_mode: 'direct' }, options);
      if (!result.ok) return result;
      const receipt = normalizeFetchedPage({ url: args.url, content: result.output, contentType: 'text/plain' }, { fetchedAt: new Date().toISOString() });
      return { ...result, ok: receipt.ok, output: JSON.stringify(receipt), meta: { ...result.meta,
        url: receipt.url, fetchedAt: receipt.fetchedAt, freshness: receipt.freshness,
        progressKey: createHash('sha256').update(args.url + '\n' + receipt.text).digest('hex') } };
    },
  };
}
