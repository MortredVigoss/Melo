// A reply that is a failed model request (`metadata.executionError`). The
// server stores one of a few fixed English sentences
// (src/services/chat/providerErrors.js PROVIDER_FAILURE_TEXT). They stay as
// stored, because later prompts and memory recognise them by that text, but
// the chat shows them in the interface language and marks the reply as a
// request that did not finish instead of an ordinary answer (agent audit
// 2026-11-10). providerFailureText.test.js keeps this list equal to the
// server's; an unknown text is shown as stored.
import { t } from '../../i18n.js';

export const PROVIDER_FAILURES = Object.freeze({
  quota: ['The model service is connected, but this API key currently has no available quota. Add billing or credits with your provider, then try again.', '模型服务已连接，但这个 API Key 目前没有可用额度。请到服务商处充值或开通计费后再试。'],
  key: ['The model service rejected this API key. Check the key in Melo and try again.', '模型服务拒绝了这个 API Key。请在 Melo 里检查密钥后再试。'],
  model: ['The selected model is unavailable for this account. Choose another model and try again.', '所选模型在这个账号下不可用。请换一个模型后再试。'],
  rate: ['The model service rate-limited this request. Wait a moment and try again.', '模型服务对这次请求限流了。请稍等片刻再试。'],
  policy: ['Codex blocked this request because the current thread context looked cybersecurity-sensitive. This is usually caused by stale technical, cookie, token, or error text in a long chat. Start a fresh chat or prune the old context, then retry.', 'Codex 拦截了这次请求，因为当前对话的上下文看起来涉及网络安全敏感内容。这通常是长对话里残留的技术细节、Cookie、令牌或报错文本造成的。请新开一段对话或清理旧上下文后重试。'],
  login: ['Your Codex OAuth session needs attention. Reconnect Codex in Melo’s Model settings and try again.', 'Codex OAuth 登录需要处理。请在 Melo 的模型设置里重新连接 Codex 后再试。'],
  stalled: ['The model stopped responding midway. This is usually a network hiccup or provider-side stall. Please retry in a moment.', '模型中途停止了响应。这通常是网络波动或服务方卡顿，请稍后重试。'],
  empty: ['The model connection opened, but Melo never received a final reply. This is usually a temporary provider or streaming issue. Please retry in a moment.', '模型连接已建立，但 Melo 没有收到最终回复。这通常是服务方或流式传输的临时问题，请稍后重试。'],
  timeout: ['This request hit Melo’s safety time cap. Longer tasks are allowed, so if this keeps happening it is likely a connectivity or provider issue rather than your prompt being too complex.', '这次请求达到了 Melo 的安全时间上限。较长的任务是允许的；如果反复出现，多半是网络或服务方的问题，而不是你的问题太复杂。'],
  backend: ['The model backend did not finish this request. This is usually temporary or provider-side. Please retry in a moment.', '模型后端没有完成这次请求。这通常是暂时的或服务方的问题，请稍后重试。'],
  unknown: ['Melo could not complete the model request right now. This is often temporary, so please retry in a moment.', 'Melo 暂时无法完成这次模型请求。这通常是暂时的，请稍后重试。'],
});
export const PROVIDER_FAILURE_DETAILS_PREFIX = 'Melo could not complete the model request right now. Details: ';
// Sentences stored before 2026-11-10 named OpenAI for every connection.
const EARLIER = Object.freeze({
  'OpenAI is connected, but this API key currently has no available quota. Add API billing or credits in the OpenAI platform, then try again.': 'quota',
  'OpenAI rejected this API key. Check the key in Melo and try again.': 'key',
  'The selected OpenAI model is unavailable for this account. Choose another model and try again.': 'model',
  'OpenAI rate-limited this request. Wait a moment and try again.': 'rate',
});

export const isFailedRequest = message => message?.role === 'assistant' && !!message?.metadata?.executionError;

// The stored text in the interface language, or null when it is not one of the fixed sentences.
export function failureDisplayText(message) {
  if (!isFailedRequest(message)) return null;
  const text = String(message.content || '').trim();
  const kind = Object.keys(PROVIDER_FAILURES).find(key => PROVIDER_FAILURES[key][0] === text) || EARLIER[text];
  if (kind) return t(PROVIDER_FAILURES[kind][1]);
  if (text.startsWith(PROVIDER_FAILURE_DETAILS_PREFIX)) return t('Melo 暂时无法完成这次模型请求。详情：{details}', { details: text.slice(PROVIDER_FAILURE_DETAILS_PREFIX.length) });
  return null;
}
