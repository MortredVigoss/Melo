// Provider connections supply inference only. Melo owns the agent/tool loop.
export const LLM_PROVIDERS = Object.freeze([
  { id: 'chatgpt', name: 'ChatGPT', authMode: 'codex', baseUrl: 'https://chatgpt.com/backend-api', model: 'gpt-6.1-sol', oauth: true },
  { id: 'openai', name: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', model: '', modelHint: '填写账号可用的模型 ID' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: '', modelHint: '填写 DeepSeek 控制台的模型 ID' },
  { id: 'doubao', name: '豆包 · 火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', modelHint: '模型 ID 或已开通的 ep-… 推理接入点' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', modelHint: '填写 Gemini 模型 ID' },
  { id: 'anthropic', name: 'Anthropic Claude', apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: '', modelHint: '填写 Claude 模型 ID' },
  { id: 'kimi', name: 'Kimi · Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: '', modelHint: '填写开放平台模型 ID；国际站可修改地址' },
  { id: 'qwen', name: '通义千问 · 百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '', modelHint: '填写模型 ID；地址必须与密钥所在区域一致' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', modelHint: 'provider/model；使用 OpenRouter 额度', oauth: true },
  { id: 'local', name: '本地模型', authMode: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: '' },
  { id: 'custom', name: '自定义兼容服务', baseUrl: '', model: '', modelHint: '服务端提供的模型 ID' },
].map(p => Object.freeze({ authMode: 'api-key', apiProtocol: 'chat-completions', ...p })));

export function llmProvider(id) {
  const provider = LLM_PROVIDERS.find(p => p.id === id);
  if (!provider) throw new Error('未知模型平台。');
  return provider;
}

export function normalizeLlmBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('请填写有效的模型服务地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.hash || url.search) {
    throw new Error('模型地址必须使用 HTTPS（本机地址可用 HTTP），且不能含凭证或查询参数。');
  }
  return url.href.replace(/\/(?:chat\/completions|messages)\/?$/, '').replace(/\/+$/, '');
}

export function publicLlmConnections(config) {
  return {
    providers: LLM_PROVIDERS,
    activeId: config.activeLlmProfileId || '',
    profiles: Object.entries(config.llmProfiles || {}).map(([id, p]) => ({
      id, providerId: p.providerId, name: p.name, authMode: p.authMode,
      apiProtocol: p.apiProtocol || 'chat-completions', baseUrl: p.baseUrl,
      model: p.model, hasKey: Boolean(p.apiKey), authKind: p.authKind || 'api-key',
      models: p.models || [], revision: p.revision || 0, test: p.test || null, visionTest: p.visionTest || null, searchTest: p.searchTest || null,
    })),
  };
}
