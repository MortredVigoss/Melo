import { normalizeModelCapabilities, capabilitiesFromMetadata } from '../../../shared/agent/modelCapabilities.js';
import sharp from 'sharp';
import { randomInt } from 'node:crypto';
import { connectionDiagnosis } from './connectionDiagnosis.js';
import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig, getResolvedConfig, withConfigLock } from '../../config.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { createOpenAICompatibleReply, discoverAvailableModels } from '../../openai.js';
import { llmProvider, normalizeLlmBaseUrl, publicLlmConnections } from '../../shared/llmProviders.js';
import { probeHostedSearch } from '../search/hostedSearchCapability.js';

const profileFields = ['authMode', 'baseUrl', 'model', 'apiKey', 'apiProtocol'];
const scoped = work => currentRequestContext() ? work() : runWithRequestContext(createRequestContext(), work);
const applyProfile = (config, id, profile) => ({ ...config, activeLlmProfileId: id,
  ...Object.fromEntries(profileFields.map(k => [k, profile[k] || (k === 'apiProtocol' ? 'chat-completions' : '')])),
  modelCatalogs: { ...config.modelCatalogs, [profile.authMode]: [...new Set([profile.model, ...(profile.models || [])].filter(Boolean))] },
});

function profilesWithLegacy(config) {
  if (Object.keys(config.llmProfiles || {}).length) return { ...config.llmProfiles };
  return { existing: { id: 'existing', providerId: config.authMode === 'codex' ? 'chatgpt' : config.authMode === 'local' ? 'local' : 'custom',
    name: '原有连接', ...Object.fromEntries(profileFields.map(k => [k, config[k]])),
    models: config.modelCatalogs?.[config.authMode] || [], revision: 1 } };
}

function requireProfile(config, id) {
  const profile = config.llmProfiles?.[id];
  if (!profile) throw new Error('此模型连接不存在，请刷新后重试。');
  return profile;
}

export function saveLlmProfile(patch, { oauthKey, expectedRevision, signal } = {}) {
  return scoped(() => withConfigLock(async () => {
    signal?.throwIfAborted();
    const config = await loadConfig({ skipModelNormalize: true });
    const provider = llmProvider(patch.providerId);
    const profiles = profilesWithLegacy(Object.keys(config.llmProfiles || {}).length
      ? config : await getResolvedConfig({ skipModelNormalize: true }));
    const id = String(patch.id || provider.id);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('无效连接标识。');
    const previous = profiles[id];
    const revision = expectedRevision ?? patch.revision;
    if (revision != null && Number(revision) !== (previous?.revision || 0)) throw new Error('连接已发生变化，请刷新后重试。');
    if (previous && previous.providerId !== provider.id) throw new Error('请为其他平台建立独立连接。');
    const baseUrl = normalizeLlmBaseUrl(patch.baseUrl ?? previous?.baseUrl ?? provider.baseUrl);
    if (provider.id === 'chatgpt' && baseUrl !== provider.baseUrl) throw new Error('ChatGPT OAuth 仅发送到官方模型地址。');
    const incomingKey = String(oauthKey ?? patch.apiKey ?? '').trim();
    if (previous?.apiKey && previous.baseUrl !== baseUrl && !incomingKey && !patch.clearKey) {
      throw new Error('服务地址已改变。请重新填写该地址的密钥，或先清除旧密钥。');
    }
    if (oauthKey && (provider.id !== 'openrouter' || baseUrl !== provider.baseUrl)) throw new Error('授权密钥只能保存到 OpenRouter 官方地址。');
    const apiProtocol = patch.apiProtocol || previous?.apiProtocol || provider.apiProtocol;
    if (!['chat-completions', 'anthropic', 'responses'].includes(apiProtocol)) throw new Error('不支持的模型协议。');
    const model = String(patch.model ?? previous?.model ?? provider.model).trim();
    if (model.length > 200 || /[\r\n\0]/.test(model)) throw new Error('模型 ID 无效。');
    const sameEndpoint = previous?.baseUrl === baseUrl && previous?.apiProtocol === apiProtocol;
    const declarations = sameEndpoint ? { ...previous.modelCapabilities } : {};
    if (patch.modelCapabilities && typeof patch.modelCapabilities === 'object' && !Array.isArray(patch.modelCapabilities)) {
      for (const [id, caps] of Object.entries(patch.modelCapabilities).slice(0,1000)) {
        if (!id || id.length > 200 || /[\r\n\0]/.test(id) || ['__proto__','constructor','prototype'].includes(id)) throw new Error('Invalid model capability id.');
        declarations[id] = normalizeModelCapabilities(caps);
      }
    }
    if (patch.modelCapability) declarations[model] = normalizeModelCapabilities(patch.modelCapability);
    const next = {
      id, providerId: provider.id, name: String(patch.name || previous?.name || provider.name).slice(0, 100),
      authMode: provider.authMode, baseUrl, apiProtocol, model,
      apiKey: provider.authMode === 'codex' || patch.clearKey ? '' : incomingKey || previous?.apiKey || '',
      authKind: oauthKey ? 'oauth' : incomingKey || patch.clearKey ? 'api-key' : previous?.authKind || 'api-key',
      models: sameEndpoint ? previous.models || [] : [],
      modelMetadata: sameEndpoint ? previous.modelMetadata || {} : {}, modelCapabilities: declarations,
      revision: (previous?.revision || 0) + 1, test: null, searchTest: null,
    };
    // A no-op save before activation must not erase the successful probe.
    if (previous && profileFields.every(field => (previous[field] || '') === (next[field] || ''))) { next.test = previous.test || null; next.visionTest = previous.visionTest || null; next.searchTest = previous.searchTest || null; }
    profiles[id] = next;
    // Merely saving another provider must not disable a legacy env-based connection.
    let updated = { ...config, llmProfiles: profiles, autosaveRevision: Date.now() };
    if (updated.activeLlmProfileId === id) updated = applyProfile(updated, id, next);
    signal?.throwIfAborted();
    await saveConfig(updated, { skipModelNormalize: true });
    return publicLlmConnections(updated);
  }));
}

export function activateLlmProfile(id) {
  return scoped(() => withConfigLock(async () => {
    const config = await loadConfig({ skipModelNormalize: true });
    const profile = requireProfile(config, id);
    if (!profile.model) throw new Error('请先填写模型 ID。');
    if (profile.authMode === 'api-key' && !profile.apiKey) throw new Error('请先保存 API Key 或完成授权。');
    const updated = applyProfile({ ...config, autosaveRevision: Date.now() }, id, profile);
    await saveConfig(updated, { skipModelNormalize: true });
    return publicLlmConnections(updated);
  }));
}

export function forgetLlmProfile(id) {
  return scoped(() => withConfigLock(async () => {
    const config = await loadConfig({ skipModelNormalize: true });
    if (id === config.activeLlmProfileId) throw new Error('请先切换到另一个连接，再移除此连接。');
    const profiles = { ...config.llmProfiles }; delete profiles[id];
    const updated = { ...config, llmProfiles: profiles };
    await saveConfig(updated, { skipModelNormalize: true });
    return publicLlmConnections(updated);
  }));
}

export function inspectLlmProfile(id) {
  return scoped(async () => requireProfile(await loadConfig({ skipModelNormalize: true }), id));
}

export function testLlmProfile(id, { signal, reply = createOpenAICompatibleReply, discover = discoverAvailableModels, catalogOnly = false, modality = 'text', challenge = () => String(randomInt(100000, 999999)) } = {}) {
  return scoped(async () => {
    const profile = await inspectLlmProfile(id);
    const start = Date.now();
    let result;
    try {
      if (catalogOnly) {
        let modelMetadata = {};
        const models = await discover({ ...profile, signal, onModelMetadata: rows => { modelMetadata = Object.fromEntries(rows.map(row => [row.id || row.slug, capabilitiesFromMetadata(row)])); } });
        result = { models, modelMetadata };
      } else if (modality === 'search') {
        result = { ...await probeHostedSearch(profile, { reply, signal }), modality, requestedModel: profile.model, testedAt: new Date().toISOString(), latencyMs: Date.now() - start };
      } else {
        if (!profile.model) throw new Error('请填写要测试的模型 ID。');
        let metadata = {};
        const code = challenge();
        const image = modality === 'vision' ? await sharp(Buffer.from(`<svg width="640" height="240" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="240" fill="white"/><text x="50" y="155" font-size="100" fill="black" font-family="Arial">${code}</text></svg>`)).png().toBuffer() : null;
        const probeContent = image ? [{type:'text',text:'Read the six digits in the image. Reply with only the digits.'},{type:'image_url',image_url:{url:`data:image/png;base64,${image.toString('base64')}`}}] : 'Calculate 2 + 2. Reply with only the number.';
        const text = await reply({ ...profile, systemPrompt: 'Reply briefly. Do not request tools.', messages: [{ role: 'user', content: probeContent }],
          signal, nativeWebSearchEnabled: false, workspacePath: null, onDelta() {},
          onProviderResponse: value => { metadata = value; },
        });
        if (metadata.simulated) throw new Error('当前处于模拟模式，不能作为真实连接测试。');
        if (image && text.replace(/\D/g,'') !== code) throw new Error('连接返回了文字，但未正确识别测试图片中的数字。');
        result = { ok: true, modality, testedAt: new Date().toISOString(), latencyMs: Date.now() - start,
          requestedModel: profile.model, reportedModel: metadata.reportedModel || '', transport: metadata.transport || '',
          preview: text.slice(0, 200), note: image ? '一次实际图片识别测试通过；不代表其他图片均能正确理解。' : '一次真实模型请求成功；不代表已验证搜索、生图或其他工具。' };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = String(error.message || error).split(profile.apiKey || randomUUID()).join('[密钥已隐藏]').slice(0, 500);
      if (catalogOnly) throw new Error(`读取模型列表失败：${message}。可以手填模型 ID 后测试连接。`);
      result = { ok: false, testedAt: new Date().toISOString(), requestedModel: profile.model, error: message, ...connectionDiagnosis(error) };
    }
    await withConfigLock(async () => {
      const config = await loadConfig({ skipModelNormalize: true });
      const current = requireProfile(config, id);
      if (current.revision !== profile.revision) throw new Error('测试期间连接已更改，结果未保存，请重新测试。');
      const updatedProfile = catalogOnly ? { ...current, models: result.models, modelMetadata: result.modelMetadata } : { ...current, [modality === 'search' ? 'searchTest' : modality === 'vision' ? 'visionTest' : 'test']: result };
      let updated = { ...config, llmProfiles: { ...config.llmProfiles, [id]: updatedProfile } };
      if (catalogOnly && updated.activeLlmProfileId === id) updated = applyProfile(updated, id, updatedProfile);
      await saveConfig(updated, { skipModelNormalize: true });
    });
    return result;
  });
}
