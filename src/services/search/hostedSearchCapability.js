import { createHash } from 'node:crypto';
import { getCodexAuthState } from '../../codexAuth.js';
import { connectionIdentity, hostedCapability, hostedSearchReceipt, hostedSearchProof } from '../../../shared/agent/hostedSearch.js';

const digest = value => createHash('sha256').update(String(value || '')).digest('hex');
export async function hostedConnectionFingerprint(config, { accountId } = {}) {
  const captured = { authMode: config.authMode, protocol: config.authMode === 'codex' ? 'responses' : config.apiProtocol || 'chat-completions', endpoint: config.baseUrl || '', model: config.model,
    credentialFingerprint: digest(config.authMode === 'codex' ? '' : config.apiKey), accountFingerprint: '' };
  if (captured.authMode === 'codex') captured.accountFingerprint = digest(accountId ?? config.codexAuth?.accountId ?? (await getCodexAuthState()).accountId);
  return digest(connectionIdentity(captured));
}

export async function resolveHostedSearchCapability(config, options = {}) {
  const capturedProof = config.llmProfiles?.[config.activeLlmProfileId]?.searchTest?.proof || config.searchTest?.proof;
  if (!capturedProof) return { status: 'unknown' };
  const fingerprint = await hostedConnectionFingerprint(config, options);
  return hostedCapability(capturedProof, fingerprint, options.now ?? Date.now());
}

export async function probeHostedSearch(config, { reply, signal, accountId } = {}) {
  if (config.authMode !== 'codex' && config.apiProtocol !== 'responses') throw new Error('此连接的 Adapter 没有 Hosted Search 编码；请使用 Responses 连接或 HTTP Search Backend。');
  const fingerprint = await hostedConnectionFingerprint(config, { accountId });
  let metadata = {};
  const response = await reply({ ...config, signal, nativeWebSearchEnabled: true, nativeImageGenerationEnabled: false, functionTools: [], workspacePath: null,
    systemPrompt: 'Run web_search once to verify the configured tool and cite a returned official source. Do not claim a search happened without using the tool.',
    messages: [{ role: 'user', content: 'Search the official Android JavaScriptEngine documentation and cite its URL.' }],
    onProviderResponse: value => { metadata = value; },
  });
  if (metadata.simulated) throw new Error('模拟响应不能验证 Hosted Search。');
  const receipt = hostedSearchReceipt({ items: response?.responseItems || response?.output || [], text: typeof response === 'string' ? response : response?.text || '' });
  const proof = hostedSearchProof({ receipt, fingerprint, now: Date.now() });
  return { ok: receipt.verified, proof, note: receipt.verified ? '已观察到服务端 Search completed 回执；不代表每个事实都已独立验证。' : '服务未返回已完成的 Search 回执；普通文字回答不算搜索验证。',
    reportedModel: metadata.reportedModel || '', preview: receipt.verified ? receipt.answer.slice(0, 200) : '',
    ...(receipt.verified ? {} : { error: 'HOSTED_SEARCH_NOT_OBSERVED' }) };
}
