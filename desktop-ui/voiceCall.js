// Live voice call on the desktop page (plan A, 2026-11-16,
// docs/realtime-voice-plan-20261116.md). The native shell owns the microphone,
// the recognizer and playback — the engine shared with the iPhone
// (ios/Melo/VoiceCall.swift through desktop-app/VoiceCallBridge.swift, events
// arrive as `melo-voice-call`). This module runs the conversation: a finished
// utterance becomes a voice turn, a supplement to the running reply or a stop;
// a finished reply is planned by the server (/api/voice-call/speech-plan) and
// read sentence by sentence in the Agent's voice (/api/voice-call/speech →
// callPlay) or by the system voice (callSpeak). Approvals stay on screen.
import { t, ui } from './i18n.js';
import { voiceCallPhrase, voiceTurnLanguage, isVoiceStopPhrase, voiceCallTiming } from '../shared/agent/voiceTurn.js';

const LIVE_PHASES = ['starting', 'listening', 'hearing', 'speaking'];
export const voiceCallActive = state => LIVE_PHASES.includes(state?.phase);
export const voiceCallSupported = (env = globalThis) => Boolean(env.webkit?.messageHandlers?.meloVoice);
export const VOICE_CALL_ENDPOINTS = Object.freeze([600, 800, 1200]);
const LINE_LIMIT = 6;
const PREFETCH = 2;
// The native engine reports its first state at once; silence means a shell built before calls existed.
const START_TIMEOUT_MS = 5000;

const idleState = () => ({ sessionID: '', phase: 'idle', partial: '', muted: false, echoCancellation: true, onDevice: false, replying: false, lines: [], error: '', notice: '' });

/**
 * @param {object} options
 * @param {() => string} options.getContext   view | project | chat | Agent; a change hangs up
 * @param {() => string|null} options.getChatId
 * @param {() => string} options.getAgentId   the replying Agent (its voice reads the reply)
 * @param {() => boolean} options.isReplying  a reply is running in this chat
 * @param {(text: string, observer: object, chatId: string|null) => Promise<unknown>} options.sendTurn
 *        chatId null: the call started on the overview or the new-chat page; this turn creates the chat
 *        and the controller hands it to adoptChat()
 * @param {(text: string) => Promise<unknown>} options.sendSupplement
 * @param {() => void} options.stopReply
 * @param {() => void} options.stopOtherAudio read-aloud and dictation stop before the microphone opens
 * @param {(body: object, signal: AbortSignal) => Promise<any>} options.requestSpeechPlan POST /api/voice-call/speech-plan
 * @param {(body: object, signal: AbortSignal) => Promise<any>} options.requestSpeech POST /api/voice-call/speech
 * @param {() => { endpointMs?: number, language?: string, engine?: string, systemVoice?: string }} options.readSettings
 * @param {(state: object) => void} options.onChange
 */
export function createVoiceCall({ env = globalThis, getContext, getChatId, getAgentId, isReplying, sendTurn, sendSupplement, stopReply, stopOtherAudio, requestSpeechPlan, requestSpeech, readSettings, onChange }) {
  let state = idleState();
  let owner = '';
  let chatId = null;
  let speech = null; // { controller, token }
  let speechToken = 0;
  let clipNumber = 0;
  let startTimer = null;
  let answered = false;
  // The turn that is creating the call's chat (a call started without one). Until adoptChat()
  // or the end of that turn, the page change it causes is expected and does not hang up.
  let creating = null;
  const clipText = new Map();
  const setTimer = (work, ms) => (env.setTimeout || globalThis.setTimeout)(work, ms);
  const clearTimer = () => { if (startTimer !== null) (env.clearTimeout || globalThis.clearTimeout)(startTimer); startTimer = null; };
  const bridge = () => env.webkit?.messageHandlers?.meloVoice;
  const post = message => { try { bridge()?.postMessage(message); } catch {} };
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const remember = line => emit({ lines: [...state.lines, line].slice(-LINE_LIMIT) });

  function nextClipId() { clipNumber += 1; return `${state.sessionID}:${clipNumber}`; }

  /** Drops the sentences being synthesized or waiting; the native queue is stopped separately. */
  function abortSpeech() {
    speechToken += 1;
    speech?.controller.abort();
    speech = null;
    clipText.clear();
  }

  function sayPhrase(key, language) {
    if (!voiceCallActive(state)) return;
    const text = voiceCallPhrase(key, language);
    const id = nextClipId();
    clipText.set(id, text);
    post({ action: 'callSpeak', sessionID: state.sessionID, id, text });
  }

  function start() {
    if (voiceCallActive(state)) return;
    if (!voiceCallSupported(env)) {
      emit({ ...idleState(), phase: 'failed', error: t('语音通话需要 Melo 桌面版，浏览器里无法使用。') });
      return;
    }
    stopOtherAudio();
    owner = getContext();
    chatId = getChatId();
    const settings = readSettings() || {};
    const id = env.crypto.randomUUID();
    clipNumber = 0;
    answered = false;
    creating = null;
    state = { ...idleState(), sessionID: id, phase: 'starting' };
    onChange(state);
    post({ action: 'callStart', sessionID: id, language: settings.language || 'system', ...voiceCallTiming({ endpointMs: settings.endpointMs }) });
    clearTimer();
    startTimer = setTimer(() => {
      startTimer = null;
      if (answered || state.sessionID !== id || state.phase !== 'starting') return;
      post({ action: 'callEnd', sessionID: id });
      emit({ phase: 'failed', error: t('当前安装的 Melo 还不支持语音通话，更新 Melo 后再试。') });
    }, START_TIMEOUT_MS);
  }

  function end() {
    clearTimer();
    creating = null;
    if (!state.sessionID) return;
    const wasLive = voiceCallActive(state);
    abortSpeech();
    if (wasLive) post({ action: 'callEnd', sessionID: state.sessionID });
    emit({ phase: wasLive ? 'ended' : state.phase, partial: '', replying: false });
  }

  function setMuted(muted) {
    if (!voiceCallActive(state)) return;
    post({ action: 'callMute', sessionID: state.sessionID, muted: Boolean(muted) });
  }

  function interrupt() {
    if (!voiceCallActive(state)) return;
    abortSpeech();
    post({ action: 'callInterrupt', sessionID: state.sessionID });
  }

  function setEndpoint(endpointMs) {
    if (!voiceCallActive(state)) return;
    post({ action: 'callTiming', sessionID: state.sessionID, ...voiceCallTiming({ endpointMs }) });
  }

  /** The page changed under the call (another chat, Agent, project or view): hang up.
   *  Not while the call's own first turn is creating its chat — that change is expected. */
  function checkContext() {
    if (voiceCallActive(state) && !creating && owner !== getContext()) end();
  }

  /** The first turn of a call started without a chat created this one: the call moves into it.
   *  If the page is not showing that chat any more, the call hangs up. */
  function adoptChat(id) {
    if (!creating) return;
    creating = null;
    if (!voiceCallActive(state)) return;
    if (id && chatId === null && getChatId() === id) { chatId = id; owner = getContext(); return; }
    checkContext();
  }

  /** Reads a finished reply: the server plans the sentences; each is synthesized ahead of playback. */
  async function speakReply(text) {
    if (!voiceCallActive(state) || !String(text || '').trim()) return;
    abortSpeech();
    const controller = new AbortController();
    const token = speechToken;
    speech = { controller, token };
    const current = () => speechToken === token && voiceCallActive(state);
    const agentId = getAgentId();
    const settings = readSettings() || {};
    let plan;
    try {
      plan = await requestSpeechPlan({ text, agentId }, controller.signal);
    } catch {
      if (current()) emit({ notice: 'speech-failed' });
      return;
    }
    if (!current() || !Array.isArray(plan?.sentences) || !plan.sentences.length) return;
    remember({ user: false, text: plan.sentences.join(' ') });
    const serverVoice = plan.serverVoice === true && !['macos', 'browser'].includes(settings.engine);
    const systemVoice = settings.engine === 'macos' ? settings.systemVoice || '' : '';
    const speakNatively = (id, sentence) => post({ action: 'callSpeak', sessionID: state.sessionID, id, text: sentence, ...(systemVoice ? { voice: systemVoice } : {}) });
    const synthesize = sentence => Promise.resolve().then(() => requestSpeech({ text: sentence, agentId }, controller.signal))
      .then(result => (result?.ok && result.audio ? result : null), () => null);
    // Up to PREFETCH sentences are synthesized at once; clips are handed over in order.
    const pending = [];
    const ensure = index => { if (index < plan.sentences.length && !pending[index]) pending[index] = synthesize(plan.sentences[index]); };
    for (let index = 0; index < plan.sentences.length; index += 1) {
      const sentence = plan.sentences[index];
      const id = nextClipId();
      clipText.set(id, sentence);
      if (!serverVoice) { speakNatively(id, sentence); continue; }
      for (let ahead = 0; ahead < PREFETCH; ahead += 1) ensure(index + ahead);
      const audio = await pending[index];
      if (!current()) return;
      // No server voice for this sentence (provider error): the system voice reads it instead of skipping it.
      if (audio) post({ action: 'callPlay', sessionID: state.sessionID, id, data: audio.audio, mimeType: audio.mimeType, text: sentence });
      else speakNatively(id, sentence);
    }
  }

  /** What the call does with the events of a reply it is listening to. */
  function observer() {
    const turn = { toolSpoken: false, promptSpoken: false, language: 'zh', spoke: false, settled: false };
    return {
      turn,
      onEvent(event, payload = {}) {
        if (!voiceCallActive(state)) return;
        if (event === 'tool_calls_start' && !turn.toolSpoken && !turn.spoke) { turn.toolSpoken = true; sayPhrase('tools', turn.language); }
        else if ((event === 'tool_permission' || event === 'capability_request') && !turn.promptSpoken) { turn.promptSpoken = true; sayPhrase('approval', turn.language); }
        else if (event === 'reply_text' && payload.final === true) { turn.spoke = true; speakReply(String(payload.text || '')); }
      },
      onSettled({ ok = false, aborted = false, error = '' } = {}) {
        if (turn.settled) return;
        turn.settled = true;
        if (!state.sessionID) return;
        emit({ replying: false, ...(ok || aborted ? {} : { error: String(error || '') }) });
        if (!ok && !aborted && voiceCallActive(state)) sayPhrase('failed', turn.language);
      },
    };
  }

  /** True while a call listens in this chat. */
  function activeFor(id) {
    return voiceCallActive(state) && Boolean(id) && id === chatId;
  }

  /** An observer for any reply in the call's chat (a typed message, a supplement follow-up). */
  function observerFor(id) {
    return activeFor(id) ? observer() : null;
  }

  async function handleUtterance(text) {
    const language = voiceTurnLanguage(text);
    if (isVoiceStopPhrase(text)) {
      if (isReplying()) { stopReply(); sayPhrase('stopped', language); }
      else { abortSpeech(); post({ action: 'callStopPlayback', sessionID: state.sessionID }); }
      return;
    }
    remember({ user: true, text });
    if (isReplying()) { await sendSupplement(text); return; }
    // A new question replaces whatever is left of the previous answer.
    abortSpeech();
    post({ action: 'callStopPlayback', sessionID: state.sessionID });
    const watcher = observer();
    watcher.turn.language = language;
    // A new turn: last answer's "could not be read" note no longer applies.
    emit({ replying: true, error: '', ...(state.notice === 'speech-failed' ? { notice: '' } : {}) });
    // A call without a chat yet: this turn creates it (a later sentence during creation does not).
    const token = {};
    if (chatId === null && !creating) creating = token;
    try {
      await sendTurn(text, watcher, chatId);
    } catch (error) {
      watcher.onSettled({ ok: false, error: error?.message || '' });
    }
    // The send was refused before it started (another reply, an Agent switch): nothing will settle it.
    if (!watcher.turn.settled) watcher.onSettled({ ok: false, error: t('这句话没有发出去，请再说一次。') });
    // No chat was adopted (the send was refused or creating the chat failed): look at the page again.
    if (creating === token) { creating = null; checkContext(); }
  }

  function receive(detail = {}) {
    if (!detail.sessionID || detail.sessionID !== state.sessionID) return;
    answered = true;
    clearTimer();
    if (voiceCallActive(state) && !creating && owner !== getContext()) { end(); return; }
    switch (detail.type) {
      case 'state': {
        const phase = String(detail.phase || state.phase);
        if (['ended', 'failed'].includes(phase)) abortSpeech();
        emit({ phase, partial: String(detail.partial || ''), muted: Boolean(detail.muted), echoCancellation: detail.echoCancellation !== false,
          onDevice: Boolean(detail.onDevice), notice: String(detail.notice || state.notice || ''), ...(detail.error ? { error: String(detail.error) } : {}) });
        if (['ended', 'failed'].includes(phase)) emit({ replying: false });
        break;
      }
      case 'utterance':
        if (voiceCallActive(state) && String(detail.text || '').trim()) handleUtterance(String(detail.text).trim());
        break;
      case 'bargeIn':
        abortSpeech();
        break;
      case 'clipFailed': {
        // A server clip that could not be decoded is read by the system voice instead.
        const text = clipText.get(detail.id);
        clipText.delete(detail.id);
        if (text && voiceCallActive(state) && String(detail.reason || '').includes('解码')) {
          const id = nextClipId();
          clipText.set(id, text);
          post({ action: 'callSpeak', sessionID: state.sessionID, id, text });
        }
        break;
      }
      case 'clipFinished':
        clipText.delete(detail.id);
        break;
      default:
        break;
    }
  }

  return { start, end, setMuted, interrupt, setEndpoint, checkContext, adoptChat, receive, activeFor, observerFor, get state() { return state; } };
}

// ── View ─────────────────────────────────────────────────────────────────────

export function voiceCallLabel(state) {
  if (voiceCallActive(state)) return t('挂断语音通话');
  return t('语音通话 · 说完自动发送，Melo 会读出回答');
}

/** The composer's call toggle (2026-11-16 redesign, option A): a labelled pill beside dictation,
 *  on every page with a composer. The live call shows a pulsing dot and "Hang up". */
export function renderVoiceCallToggle(state, escapeHtml, { disabled = false, icon = '', liveIcon = '' } = {}) {
  const live = voiceCallActive(state);
  const label = voiceCallLabel(state);
  return ui`<button type="button" class="voice-call-toggle ${live ? 'is-live' : ''}" data-action="toggle-voice-call"
    ${disabled ? 'disabled' : ''} aria-pressed="${live}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
    ${live ? ui`<span class="voice-call-dot" aria-hidden="true"></span><span class="toolbar-icon">${liveIcon}</span>` : ui`<span class="toolbar-icon">${icon}</span>`}
    <span class="voice-call-toggle-label">${live ? '挂断' : '通话'}</span>
  </button>`;
}

function phaseLabel(state) {
  if (state.phase === 'starting') return t('正在接通…');
  if (state.phase === 'hearing') return t('正在听你说');
  if (state.phase === 'speaking') return state.echoCancellation ? t('Melo 正在说 · 直接开口可以打断') : t('Melo 正在说 · 点「打断」可以插话');
  if (state.phase === 'listening') return state.muted ? t('已静音') : state.replying ? t('正在思考…') : t('在听，请说');
  if (state.phase === 'failed') return t('通话已结束');
  return t('语音通话');
}

export function renderVoiceCall(state, escapeHtml, { endpointMs = 800 } = {}) {
  const live = voiceCallActive(state);
  if (!live && !(state.phase === 'failed' && state.error)) return '';
  const lines = state.lines.slice(-2).map(line => ui`<div class="voice-call-line ${line.user ? 'is-user' : ''}"><span>${line.user ? t('你') : 'Melo'}</span>${escapeHtml(line.text)}</div>`).join('');
  const endpointChoices = VOICE_CALL_ENDPOINTS.map((value, index) => ui`<option value="${value}" ${value === endpointMs ? 'selected' : ''}>${[t('较快'), t('标准'), t('较慢')][index]}</option>`).join('');
  // Hang-up lives on the composer's call toggle (it reads "Hang up" during a call), not here too.
  return ui`<div class="voice-preview voice-call" role="status" aria-live="polite">
    <div class="voice-preview-title"><span class="voice-call-status">${live ? ui`<span class="voice-call-dot" aria-hidden="true"></span>` : ''}${escapeHtml(phaseLabel(state))}</span>
      ${live ? ui`<span class="voice-call-actions">
        ${state.phase === 'speaking' ? ui`<button type="button" class="ghost-button" data-action="interrupt-voice-call">打断</button>` : ''}
        <button type="button" class="ghost-button" data-action="mute-voice-call" aria-pressed="${state.muted}">${state.muted ? t('取消静音') : t('静音')}</button>
        <label class="voice-call-endpoint">${t('说完后等待')}<select data-voice-call-endpoint aria-label="${escapeHtml(t('说完后等待'))}">${endpointChoices}</select></label>
      </span>` : ''}</div>
    ${state.partial ? ui`<div class="voice-preview-body">${escapeHtml(state.partial)}</div>` : ''}
    ${lines ? ui`<div class="voice-call-lines">${lines}</div>` : ''}
    ${state.error ? ui`<div class="voice-call-error">${escapeHtml(state.error)}</div>` : ''}
    ${live && state.notice === 'half-duplex' ? ui`<small>${t('没有回声消除：Melo 说话时不会被打断，可以点「打断」。')}</small>` : ''}
    ${live && state.notice === 'speech-failed' ? ui`<small>${t('这次回答没能读出来，内容在聊天里。')}</small>` : ''}
    ${live ? ui`<small>${t('通话中说的话会作为消息发出；需要确认的操作请在屏幕上点；系统语音识别可能需要联网。')}</small>` : ''}
  </div>`;
}
