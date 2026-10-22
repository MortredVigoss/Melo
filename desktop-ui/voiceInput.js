import { t, ui } from './i18n.js';
export const voiceInputActive = state => ['requesting', 'listening', 'stopping'].includes(state?.status);
export const voiceInputSupported = (env = globalThis) => Boolean(
  env.webkit?.messageHandlers?.meloVoice ||
  ((env.SpeechRecognition || env.webkitSpeechRecognition) && env.isSecureContext !== false),
);

const emptyState = supported => ({ supported, sessionID: '', recording: false, status: 'idle', preview: '', error: '', notice: '' });

export function createVoiceInput({ env = globalThis, getContext, onChange, onCommit, limitMs = 60_000, finalWaitMs = 2500 }) {
  let state = emptyState(voiceInputSupported(env));
  let owner;
  let recognition;
  let timer;
  let finalTimer;
  let hasInterim = false;
  const bridge = env.webkit?.messageHandlers?.meloVoice;
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const clearTimers = () => { env.clearTimeout(timer); env.clearTimeout(finalTimer); };
  const current = id => id && state.sessionID === id && voiceInputActive(state) && owner === getContext();

  function complete(id, text, error = '', notice = '') {
    if (state.sessionID === id && voiceInputActive(state) && owner !== getContext()) { cancel(); return; }
    if (!current(id)) return;
    clearTimers();
    const finalText = String(text || '').trim();
    // Mark terminal before abort, which can synchronously trigger onerror/onend.
    state = { ...state, status: error ? 'error' : 'ready', recording: false, preview: '', error, notice: notice || (!finalText && !error ? t('没有识别到文字，请重试。') : '') };
    const old = recognition; recognition = null;
    old?.abort();
    if (finalText) onCommit(finalText);
    onChange(state);
  }

  function cancel() {
    const id = state.sessionID;
    const wasActive = voiceInputActive(state);
    clearTimers();
    state = emptyState(voiceInputSupported(env));
    const old = recognition; recognition = null;
    old?.abort();
    if (bridge && wasActive) bridge.postMessage({ action: 'cancelVoice', sessionID: id });
    onChange(state);
  }

  function waitForFinal(id) {
    env.clearTimeout(timer);
    env.clearTimeout(finalTimer);
    finalTimer = env.setTimeout(() => {
      if (bridge) bridge.postMessage({ action: 'cancelVoice', sessionID: id });
      complete(id, state.preview, '', t('已保留当前转写，请核对文字。'));
    }, finalWaitMs);
  }

  function receive(detail = {}) {
    if (!detail.sessionID || detail.sessionID !== state.sessionID || !voiceInputActive(state)) return;
    if (owner !== getContext()) { cancel(); return; }
    if (['ready', 'error'].includes(detail.status)) {
      complete(detail.sessionID, detail.finalText, detail.error, detail.notice);
      return;
    }
    // A delayed partial cannot turn a stopped microphone back on in the UI.
    if (detail.status === 'listening' && state.status === 'requesting') timer = env.setTimeout(stop, limitMs);
    if (detail.status === 'stopping' && state.status !== 'stopping') waitForFinal(detail.sessionID);
    emit({ status: state.status === 'stopping' ? 'stopping' : detail.status || state.status,
      recording: state.status === 'stopping' ? false : Boolean(detail.recording), preview: detail.partial ?? state.preview });
  }

  function stop() {
    if (state.status === 'requesting') { cancel(); return; }
    if (state.status !== 'listening') return;
    const id = state.sessionID;
    env.clearTimeout(timer);
    emit({ status: 'stopping', recording: false });
    waitForFinal(id);
    if (bridge) { bridge.postMessage({ action: 'stop', sessionID: id }); return; }
    try { recognition?.stop(); } catch { complete(id, state.preview); }
  }

  function start(language = 'zh-CN') {
    if (voiceInputActive(state)) return;
    if (!voiceInputSupported(env)) {
      emit({ status: 'error', error: t('当前浏览器不支持语音识别，请使用支持的浏览器、系统键盘听写或 Melo 桌面版。') }); return;
    }
    owner = getContext();
    const id = env.crypto.randomUUID();
    emit({ ...emptyState(true), sessionID: id, status: 'requesting' });
    if (bridge) { bridge.postMessage({ action: 'toggle', sessionID: id, language }); return; }
    const Recognition = env.SpeechRecognition || env.webkitSpeechRecognition;
    try {
      const engine = new Recognition();
      recognition = engine;
      engine.lang = language === 'system' ? (env.navigator?.language || 'zh-CN') : language;
      engine.continuous = true;
      engine.interimResults = true;
      hasInterim = false;
      engine.onstart = () => {
        if (!current(id)) { engine.abort(); return; }
        emit({ status: 'listening', recording: true });
        timer = env.setTimeout(stop, limitMs);
      };
      engine.onresult = event => {
        if (!current(id)) { if (state.sessionID === id) cancel(); return; }
        const text = Array.from(event.results, item => item[0]?.transcript || '').join('');
        hasInterim = Array.from(event.results).some(item => !item.isFinal);
        emit({ preview: text });
      };
      engine.onerror = event => {
        const errors = {
          'not-allowed': t('麦克风或语音识别未获授权，请检查浏览器的网站权限。'),
          'service-not-allowed': t('浏览器的语音识别服务不可用，请使用系统键盘听写或桌面版。'),
          'audio-capture': t('没有可用的麦克风，请检查输入设备。'),
          'no-speech': t('没有检测到语音，请重试。'),
          network: t('语音识别网络连接失败，已保留识别到的文字。'),
          'language-not-supported': t('语音识别不支持当前语言，请更换语言。'),
        };
        complete(id, state.preview, errors[event.error] || t('语音识别中断（{reason}）', { reason: event.error || 'unknown' }));
      };
      engine.onend = () => complete(id, state.preview, '', hasInterim ? t('已保留当前转写，请核对文字。') : '');
      engine.start();
    } catch (error) {
      complete(id, '', t('无法启动语音输入：{error}', { error: error.message }));
    }
  }

  return { start, stop, cancel, receive, get state() { return state; } };
}

export function voiceInputLabel(state) {
  if (state.status === 'requesting') return t('等待麦克风授权 · 点击取消');
  if (state.status === 'listening') return t('正在听写 · 点击停止');
  if (state.status === 'stopping') return t('正在完成转写…');
  return t('语音输入 · 转为文字后确认发送');
}

export function renderVoiceInput(state, escapeHtml) {
  const active = voiceInputActive(state);
  if (!active && !state.error && !state.notice) return '';
  return ui`<div class="voice-preview" role="status" aria-live="polite">
    <div class="voice-preview-title">${escapeHtml(active ? voiceInputLabel(state) : t('语音输入'))}
      ${active ? ui`<button type="button" class="ghost-button" data-action="cancel-voice-input">取消</button>` : ''}</div>
    <div class="voice-preview-body">${escapeHtml(state.preview || state.error || state.notice || t('识别内容将进入输入框，不会自动发送。'))}</div>
    ${active ? ui`<small>最长 60 秒 · 使用系统或浏览器语音识别，服务可能需要联网。</small>` : ''}
  </div>`;
}
