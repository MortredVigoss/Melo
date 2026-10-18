// Bug audit 2026-10-18 U12: a `[工具轨迹]` message (persisted when a run is
// stopped after tools already ran — src/services/chat/toolTraceReplay.js) is a
// record for the next turn, not a reply. It renders compactly: no avatar, no
// model receipt, no read-aloud button; TTS never streams it either. Pure
// renderer so it can be tested without a DOM.
import { t, ui } from './i18n.js';

export const isToolTraceMessage = message => message?.role === 'assistant' && message?.kind === 'tool-trace';

export function renderToolTraceMessage(message, escape) {
  if (!isToolTraceMessage(message)) return '';
  const status = String(message?.metadata?.toolTrace?.status || 'cancelled');
  const label = status === 'failed' ? t('失败') : status === 'interrupted' ? t('已中断') : t('已取消');
  return ui`<div class="tool-trace-body"><span class="chip is-muted tool-trace-status">${escape(label)}</span><p class="tool-trace-text">${escape(message.content || '')}</p></div>`;
}
