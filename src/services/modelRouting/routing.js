import { createHash } from 'node:crypto';
import { selectRouting, escalateRouting, parseRoutingJudgment, ROUTING_JUDGE_PROMPT, ROUTING_VERSION } from '../../../shared/agent/modelRouting.js';

export function routingCandidates(config) {
  const active = config.activeLlmProfileId || '';
  const profiles = Object.entries(config.llmProfiles || {});
  if (!profiles.some(([id]) => id === active)) profiles.unshift([active, config]);
  return profiles.flatMap(([connectionId, p]) => {
    const models = [...new Set([p.model, ...(p.models || []), ...(connectionId === active ? config.modelCatalogs?.[p.authMode] || [] : [])].filter(m => typeof m === 'string' && m.trim()))];
    return models.map(model => ({ connectionId, model, name: p.name || connectionId || '当前连接',
      capabilities: { tools: true, vision: p.visionTest?.ok === true && p.visionTest.requestedModel === model },
      contextWindow: p.contextWindows?.[model] || 0,
      available: p.authMode === 'codex' ? config.codexAuth?.loggedIn !== false : p.authMode === 'local' || !!p.apiKey,
      price: config.modelPricing?.[model] || null,
      latencyMs: p.test?.requestedModel === model && p.test.ok ? p.test.latencyMs : null }));
  });
}
export function routingPolicy(config) {
  const saved = config.smartRouting || {};
  const policy = { revision: 0, defaultMode: 'fixed', preference: 'balanced', allowCrossConnection: false, allowEscalation: true, tiers: { light: [], standard: [], strong: [] }, ...saved };
  const local = routingCandidates(config).filter(c => c.connectionId === (config.activeLlmProfileId || '') && c.available);
  // A single model needs no fabricated classification or tier decisions.
  if (!Object.values(policy.tiers || {}).some(a => a.length) && local.length === 1) policy.tiers = Object.fromEntries(['light','standard','strong'].map(t => [t, [{ connectionId: local[0].connectionId, model: local[0].model }]]));
  return policy;
}
export function publicSmartRouting(config) { return { ...routingPolicy(config), candidates: routingCandidates(config) }; }

export function routeConnection(config, route) {
  const p = route.connectionId === (config.activeLlmProfileId || '') ? config : config.llmProfiles?.[route.connectionId];
  if (!p) throw Object.assign(new Error('所选智能模型的连接已不可用。'), { code: 'ROUTING_CONNECTION_MISSING' });
  return { ...config, authMode: p.authMode, apiProtocol: p.apiProtocol || 'chat-completions', apiKey: p.apiKey || '', baseUrl: p.baseUrl, activeLlmProfileId: route.connectionId, model: route.model, routingContextWindow: p.contextWindows?.[route.model] || 0 };
}
const cache = new Map();
export function clearRoutingCache() { cache.clear(); }
export async function createRoutingSession({ config, agent, text, messages = [], attachments = [], home, signal, createReply, onDecision, now = Date.now }) {
  signal?.throwIfAborted();
  config = { ...config };
  const policy = routingPolicy(config);
  const mode = config.conversationModelSelected ? config.conversationModelMode || 'fixed' : policy.defaultMode;
  const input = { mode, policy, candidates: routingCandidates(config), connectionId: config.activeLlmProfileId || '', defaultModel: config.model,
    fixedModel: config.conversationModelSelected && mode !== 'smart' ? config.model : agent?.model || '',
    text, context: messages, attachments };
  // Explicit per-assignment modality confirmations are stored with the policy.
  for (const c of input.candidates) for (const entries of Object.values(policy.tiers || {})) {
    if (entries.some(a => a.connectionId === c.connectionId && a.model === c.model && a.vision === true)) c.capabilities.vision = true;
  }
  let current = selectRouting(input);
  if (current.judge) {
    const connection = routeConnection(config, current.judge);
    const identity = [home, ROUTING_VERSION, policy, connection.activeLlmProfileId, connection.baseUrl, connection.authMode, connection.apiProtocol, connection.model,
      createHash('sha256').update(connection.apiKey || '').digest('hex'), messages, text, attachments];
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const cached = cache.get(key);
    let judgment = cached?.expires > now() ? cached.value : null;
    let source = judgment ? 'cache' : 'model';
    if (!judgment) {
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal].filter(Boolean));
      let timer;
      try {
        const request = createReply({ authMode: connection.authMode, apiProtocol: connection.apiProtocol, apiKey: connection.apiKey, baseUrl: connection.baseUrl, model: connection.model,
          systemPrompt: ROUTING_JUDGE_PROMPT, messages: [{ role: 'user', content: JSON.stringify({ context: messages.filter(m => m.role === 'user').map(m => m.content).slice(-4), text, attachments: attachments.map(a => ({ kind: a.kind, mimeType: a.mimeType })) }) }],
          signal: combined, timeoutMs: 3000, maxTokens: 512, providerProfile: 'fast', purpose: 'routing-judge',
          nativeWebSearchEnabled: false, nativeImageGenerationEnabled: false });
        const raw = await Promise.race([request, new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error('Routing judgment timed out'); controller.abort(e); reject(e); }, 3000); })]);
        judgment = parseRoutingJudgment(typeof raw === 'string' ? raw : raw?.text);
        if (judgment) { if (cache.size >= 128) cache.delete(cache.keys().next().value); cache.set(key, { value: judgment, expires: now() + 300000 }); }
      } catch (error) { if (signal?.aborted) throw signal.reason || error; source = 'fallback'; }
      finally { clearTimeout(timer); }
    }
    signal?.throwIfAborted();
    current = { ...selectRouting({ ...input, judgment, judgmentAttempted: true }), judgmentSource: judgment ? source : 'fallback' };
  }
  const emit = () => onDecision?.({ ...current, judge: undefined });
  if (current.mode === 'smart') emit();
  return {
    get current() { return current; },
    connection() { return routeConnection(config, current); },
    escalate(details) {
      signal?.throwIfAborted();
      let next;
      try { next = escalateRouting({ ...input, ...details, previous: current }); }
      catch (error) { if (error.code !== 'ROUTING_MODEL_UNAVAILABLE') throw error; return false; }
      if (!next) return false;
      current = next; emit(); return true;
    },
  };
}
