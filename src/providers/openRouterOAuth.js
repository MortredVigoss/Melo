import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { currentRequestContext, runWithRequestContext } from '../runtime/requestScope.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { inspectLlmProfile, saveLlmProfile } from '../services/settings/llmConnections.js';

const sessions = new Map();
const TOKEN_ENDPOINT = 'https://openrouter.ai/api/v1/auth/keys';
const AUTH_ENDPOINT = 'https://openrouter.ai/auth';
const nonce = () => randomBytes(32).toString('base64url');
const view = entry => ({ id: entry.id, status: entry.status, error: entry.error || '', expiresAt: entry.expiresAt });

export async function startOpenRouterOAuth(profileId, { fetchImpl = fetch, lifetimeMs = 600000 } = {}) {
  const context = currentRequestContext() || createRequestContext();
  const profile = await runWithRequestContext(context, () => inspectLlmProfile(profileId));
  if (profile.providerId !== 'openrouter' || profile.baseUrl !== 'https://openrouter.ai/api/v1') throw new Error('请先保存 OpenRouter 官方地址的连接。');
  // One flow per Melo home. Never let a prior account flow overwrite a newer one.
  for (const entry of sessions.values()) if (entry.home === context.home) entry.cancel();
  const id = nonce(), state = nonce(), verifier = nonce();
  const abort = new AbortController();
  const entry = { id, home: context.home, status: 'pending', expiresAt: Date.now() + lifetimeMs };
  let timer;
  const close = () => { clearTimeout(timer); server.close(); };
  entry.cancel = () => {
    if (['pending', 'exchanging'].includes(entry.status)) { entry.status = 'cancelled'; abort.abort(); }
    close();
    sessions.delete(entry.id);
  };
  const reply = (res, status, text) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'" });
    res.end(text);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', callbackUrl);
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { reply(res, 404, 'Not found'); return; }
    if (entry.status !== 'pending' || Date.now() >= entry.expiresAt) { reply(res, 410, '登录已结束，请回到 Melo 重试。'); return; }
    // OpenRouter omits state on access_denied. This path can only cancel;
    // exchanging or saving a credential always requires the matching state.
    if (url.searchParams.get('error') === 'access_denied' && !url.searchParams.has('state') && !url.searchParams.has('code')) {
      entry.status = 'cancelled'; reply(res, 200, '授权已取消，可以返回 Melo。'); close(); return;
    }
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
      reply(res, 400, '登录校验失败，请回到 Melo 重试。'); return;
    }
    if (url.searchParams.has('error')) { entry.status = 'cancelled'; reply(res, 200, '授权已取消，可以返回 Melo。'); close(); return; }
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.getAll('code').length !== 1) { reply(res, 400, '缺少授权码。'); return; }
    entry.status = 'exchanging';
    try {
      const response = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
      });
      if (!response.ok) throw new Error(`授权交换失败（${response.status}），请重新登录。`);
      const { key } = await response.json();
      if (typeof key !== 'string' || !key.trim() || key.length > 4096) throw new Error('授权服务没有返回有效凭证。');
      if (abort.signal.aborted || Date.now() >= entry.expiresAt) throw new Error('授权已取消或过期。');
      await runWithRequestContext(context, () => saveLlmProfile({ id: profileId, providerId: 'openrouter' }, { oauthKey: key, expectedRevision: profile.revision, signal: abort.signal }));
      entry.status = 'completed';
      reply(res, 200, 'OpenRouter 已连接。请返回 Melo 选择模型并测试；用量计入 OpenRouter 账号。');
    } catch (error) {
      if (!abort.signal.aborted) { entry.status = 'failed'; entry.error = '授权未保存，连接可能已变更或授权服务不可用。请返回 Melo 重试。'; }
      reply(res, 400, entry.error || '授权已取消。');
    } finally { close(); }
  });
  // Only local browser callbacks can reach this listener.
  let callbackUrl;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  callbackUrl = `http://127.0.0.1:${server.address().port}/auth/callback`;
  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.search = new URLSearchParams({ callback_url: callbackUrl, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', key_label: 'Melo' }).toString();
  timer = setTimeout(() => { entry.status = 'expired'; abort.abort(); close(); }, lifetimeMs);
  timer.unref(); server.unref();
  // Retain terminal status for the client without keeping a process/listener alive.
  const cleanup = setTimeout(() => { close(); sessions.delete(id); }, lifetimeMs + 60000); cleanup.unref();
  sessions.set(id, entry);
  return { ...view(entry), url: authUrl.href };
}

export function openRouterOAuthStatus(id, { cancel = false } = {}) {
  const home = (currentRequestContext() || createRequestContext()).home;
  const entry = sessions.get(id);
  if (!entry || entry.home !== home) return { id, status: 'expired' };
  if (cancel) entry.cancel();
  return view(entry);
}
