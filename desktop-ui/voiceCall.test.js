import { setLanguage } from './i18n.js';
setLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceCall, voiceCallActive, voiceCallSupported, renderVoiceCall, renderVoiceCallToggle } from './voiceCall.js';
import { VOICE_TURN, voiceCallPhrase } from '../shared/agent/voiceTurn.js';

// Live voice call on the desktop page (2026-11-16). The native engine is a
// message log; sending, supplements and the two speech requests are fakes
// with counters, so each test checks what really happened underneath.

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function fixture({ native = true, serverVoice = true, engine = 'auto', replying = false, speech, chatId = 'c1', sendTurn } = {}) {
  let context = 'chat|p|c1|agent-a', id = 0, pageChat = chatId;
  const posted = [], turns = [], supplements = [], stops = [], others = [], plans = [], requests = [], changes = [];
  const state = { replying };
  const timers = [], cleared = new Set();
  const env = {
    crypto: { randomUUID: () => `session-${++id}` },
    setTimeout: (work, ms) => { timers.push({ work, ms }); return timers.length; },
    clearTimeout: handle => { cleared.add(handle); },
    ...(native ? { webkit: { messageHandlers: { meloVoice: { postMessage: message => posted.push(message) } } } } : {}),
  };
  const call = createVoiceCall({
    env,
    getContext: () => context,
    getChatId: () => pageChat,
    getAgentId: () => 'agent-a',
    isReplying: () => state.replying,
    // Like handleSendMessage: resolves once the turn has settled (its finally calls onSettled).
    sendTurn: sendTurn || ((text, observer, callChat) => new Promise(resolve => {
      const settle = observer.onSettled;
      observer.onSettled = result => { settle(result); resolve(); };
      turns.push({ text, observer, chatId: callChat });
    })),
    sendSupplement: async text => { supplements.push(text); },
    stopReply: () => { stops.push('stop'); },
    stopOtherAudio: () => { others.push('stopped'); },
    requestSpeechPlan: async (body, signal) => {
      plans.push({ body, signal });
      const sentences = body.text.split('|');
      return { ok: true, sentences, serverVoice, condensed: false, language: 'zh' };
    },
    requestSpeech: speech || (async (body, signal) => { requests.push({ body, signal }); return { ok: true, audio: Buffer.from(body.text).toString('base64'), mimeType: 'audio/mpeg' }; }),
    readSettings: () => ({ endpointMs: 1200, language: 'zh-CN', engine, systemVoice: 'Tingting' }),
    onChange: next => changes.push(next),
  });
  const native_ = detail => call.receive({ sessionID: call.state.sessionID, ...detail });
  return { call, posted, turns, supplements, stops, others, plans, requests, changes, state, timers, cleared, native: native_, setContext: value => { context = value; }, setChatId: value => { pageChat = value; } };
}

function started(options) {
  const f = fixture(options);
  f.call.start();
  f.native({ type: 'state', phase: 'listening', echoCancellation: true });
  return f;
}

const byAction = (posted, action) => posted.filter(message => message.action === action);

function finishClip(f, clip) { f.native({ type: 'clipFinished', id: clip.id }); }

async function finishSentences(f, count) {
  for (let i = 0; i < count; i += 1) {
    await flush();
    const clip = f.posted.filter(item => ['callSpeak', 'callPlay'].includes(item.action)).at(-1);
    assert.ok(clip);
    finishClip(f, clip);
  }
}


test('start opens the native call with the contract timings and the chosen end-of-speech wait', () => {
  const f = fixture();
  assert.equal(voiceCallSupported({}), false);
  f.call.start();
  assert.deepEqual(f.others, ['stopped'], 'read-aloud and dictation stop before the microphone opens');
  const [startMessage] = f.posted;
  assert.equal(startMessage.action, 'callStart');
  assert.equal(startMessage.sessionID, 'session-1');
  assert.equal(startMessage.language, 'zh-CN');
  assert.equal(startMessage.endpointMs, 1200);
  assert.equal(startMessage.bargeInMs, VOICE_TURN.timing.bargeInMs);
  assert.equal(startMessage.utteranceLimitMs, VOICE_TURN.timing.utteranceLimitMs);
  assert.equal(f.call.state.phase, 'starting');
  f.call.start();
  assert.equal(byAction(f.posted, 'callStart').length, 1, 'one call at a time');
  f.native({ type: 'state', phase: 'listening' });
  assert.ok(voiceCallActive(f.call.state));
});

test('a shell built before calls existed never answers: the call gives up after five seconds and says why', () => {
  const silent = fixture();
  silent.call.start();
  assert.equal(silent.timers.length, 1);
  assert.equal(silent.timers[0].ms, 5000);
  silent.timers[0].work();
  assert.equal(silent.call.state.phase, 'failed');
  assert.match(silent.call.state.error, /还不支持语音通话/);
  assert.equal(byAction(silent.posted, 'callEnd').length, 1, 'the request is withdrawn');
  // A current shell answers at once (its first state is "starting"): the timer is cleared and does nothing.
  const answered = fixture();
  answered.call.start();
  answered.native({ type: 'state', phase: 'starting' });
  assert.ok(answered.cleared.has(1), 'the first event clears the timer');
  answered.timers[0].work();
  assert.equal(answered.call.state.phase, 'starting', 'a late timer cannot fail a call that answered');
});

test('outside the desktop app there is no call, only an explanation', () => {
  const f = fixture({ native: false });
  f.call.start();
  assert.equal(f.call.state.phase, 'failed');
  assert.match(f.call.state.error, /桌面版/);
  assert.equal(f.posted.length, 0);
});

test('an utterance becomes a voice turn; tools, approvals and the final reply are spoken in order', async () => {
  const f = started();
  f.native({ type: 'utterance', text: '明天天气怎么样' });
  await flush();
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].text, '明天天气怎么样');
  assert.ok(byAction(f.posted, 'callStopPlayback').length >= 1, 'a new question replaces the rest of the last answer');
  assert.equal(f.call.state.replying, true);
  assert.deepEqual(f.call.state.lines, [{ user: true, text: '明天天气怎么样' }]);
  const { observer } = f.turns[0];
  observer.onEvent('tool_calls_start', { calls: [] });
  observer.onEvent('tool_calls_start', { calls: [] });
  observer.onEvent('tool_permission', { requestId: 'r1' });
  const phrases = byAction(f.posted, 'callSpeak').map(message => message.text);
  assert.deepEqual(phrases, [voiceCallPhrase('tools', 'zh'), voiceCallPhrase('approval', 'zh')], 'each placeholder once');
  observer.onEvent('reply_text', { text: '明天晴。|最高十八度。|适合出门。', final: true });
  await flush(); await flush(); await flush();
  const firstAnswer = f.posted.findIndex(message => message.action === 'callPlay');
  const lastPrompt = f.posted.findLastIndex(message => message.action === 'callSpeak');
  assert.ok(f.posted.slice(lastPrompt + 1, firstAnswer).some(message => message.action === 'callStopPlayback'), 'final answer supersedes progress audio');
  assert.equal(f.plans.length, 1);
  assert.deepEqual(f.plans[0].body, { text: '明天晴。|最高十八度。|适合出门。', agentId: 'agent-a' }, 'the replying Agent voices the reply');
  await finishSentences(f, 2);
  await flush();
  const plays = byAction(f.posted, 'callPlay');
  assert.deepEqual(plays.map(message => message.text), ['明天晴。', '最高十八度。', '适合出门。'], 'clips reach the native queue in order');
  assert.deepEqual(plays.map(message => Buffer.from(message.data, 'base64').toString()), ['明天晴。', '最高十八度。', '适合出门。']);
  assert.equal(new Set(plays.map(message => message.id)).size, 3);
  assert.deepEqual(f.call.state.lines.at(-1), { user: false, text: '明天晴。 最高十八度。 适合出门。' });
  observer.onSettled({ ok: true });
  assert.equal(f.call.state.replying, false);
});

test('synthesis runs at most two sentences ahead of playback', async () => {
  let inFlight = 0, peak = 0;
  const releases = [];
  const f = started({
    speech: (body) => new Promise(resolve => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      releases.push(() => { inFlight -= 1; resolve({ ok: true, audio: Buffer.from(body.text).toString('base64'), mimeType: 'audio/mpeg' }); });
    }),
  });
  f.native({ type: 'utterance', text: '讲一下' });
  await flush();
  f.turns[0].observer.onEvent('reply_text', { text: '一。|二。|三。|四。', final: true });
  await flush(); await flush();
  assert.equal(releases.length, 2, 'two requests before the first answer');
  releases[1](); await flush();
  assert.equal(byAction(f.posted, 'callPlay').length, 0, 'slow first sentence keeps order');
  releases[0](); await flush();
  assert.equal(releases.length, 2, 'fast synthesis cannot run ahead of slow playback');
  for (let index = 0; index < 3; index += 1) {
    finishClip(f, byAction(f.posted, 'callPlay').at(-1));
    await flush();
    if (releases[index + 2]) releases[index + 2]();
    await flush();
  }
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.deepEqual(byAction(f.posted, 'callPlay').map(message => message.text), ['一。', '二。', '三。', '四。']);
});

test('an interruption aborts the sentences being synthesized and none of them is played afterwards', async () => {
  const pending = [];
  const f = started({ speech: (body, signal) => new Promise(resolve => pending.push({ body, signal, resolve })) });
  f.native({ type: 'utterance', text: '讲个长一点的' });
  await flush();
  f.turns[0].observer.onEvent('reply_text', { text: '第一句。|第二句。|第三句。', final: true });
  await flush(); await flush();
  assert.equal(pending.length, 2);
  f.native({ type: 'bargeIn' });
  assert.ok(pending.every(request => request.signal.aborted), 'the requests behind the sentences are aborted');
  for (const request of pending) request.resolve({ ok: true, audio: 'bGF0ZQ==', mimeType: 'audio/mpeg' });
  await flush(); await flush();
  assert.equal(byAction(f.posted, 'callPlay').length, 0, 'a late synthesis result is never handed to the speaker');
  assert.equal(pending.length, 2, 'no further sentence was requested');
});

test('a stop phrase cancels the running reply; while idle it only stops playback', async () => {
  const f = started({ replying: true });
  f.native({ type: 'utterance', text: '算了吧。' });
  await flush();
  assert.deepEqual(f.stops, ['stop']);
  assert.equal(f.turns.length, 0);
  assert.equal(f.supplements.length, 0);
  assert.equal(byAction(f.posted, 'callSpeak').at(-1).text, voiceCallPhrase('stopped', 'zh'));
  f.state.replying = false;
  const stopsBefore = byAction(f.posted, 'callStopPlayback').length;
  f.native({ type: 'utterance', text: 'stop' });
  await flush();
  assert.deepEqual(f.stops, ['stop'], 'nothing to cancel');
  assert.equal(byAction(f.posted, 'callStopPlayback').length, stopsBefore + 1);
  assert.equal(f.turns.length, 0, 'a stop phrase is never sent to the model');
});

test('while a reply runs, what the user says joins it as a supplement', async () => {
  const f = started({ replying: true });
  f.native({ type: 'utterance', text: '顺便查一下后天' });
  await flush();
  assert.deepEqual(f.supplements, ['顺便查一下后天']);
  assert.equal(f.turns.length, 0);
});

test('without a server voice, or with the macOS engine, the system voice reads every sentence', async () => {
  for (const options of [{ serverVoice: false }, { engine: 'macos' }]) {
    const f = started(options);
    f.native({ type: 'utterance', text: '你好' });
    await flush();
    f.turns[0].observer.onEvent('reply_text', { text: options.engine === 'macos' ? '你好呀。有什么事？' : '你好呀。|有什么事？', final: true });
    await flush(); await flush();
    assert.equal(f.requests.length, 0, 'no server synthesis');
    await finishSentences(f, 1);
    await flush();
    assert.equal(f.plans.length, options.engine === 'macos' ? 0 : 1);
    const spoken = byAction(f.posted, 'callSpeak').map(message => message.text);
    assert.deepEqual(spoken, ['你好呀。', '有什么事？']);
    if (options.engine === 'macos') assert.ok(byAction(f.posted, 'callSpeak').every(message => message.voice === 'Tingting'));
  }
});

test('a sentence the server voice cannot read falls back to the system voice instead of being skipped', async () => {
  let attempt = 0;
  const f = started({ speech: async body => (++attempt === 2 ? Promise.reject(new Error('502')) : { ok: true, audio: Buffer.from(body.text).toString('base64'), mimeType: 'audio/mpeg' }) });
  f.native({ type: 'utterance', text: '说三句' });
  await flush();
  f.turns[0].observer.onEvent('reply_text', { text: 'A。|B。|C。', final: true });
  for (let i = 0; i < 6; i += 1) await flush();
  const played = byAction(f.posted, 'callPlay')[0];
  f.native({ type: 'clipFailed', id: played.id, reason: '这句语音无法解码' });
  await flush();
  assert.deepEqual(byAction(f.posted, 'callSpeak').map(message => message.text), ['A。']);
  finishClip(f, played); // old completion cannot release the fallback
  await flush();
  assert.equal(attempt, 2);
  await finishSentences(f, 2);
  await flush();
  assert.deepEqual(f.posted.filter(item => ['callPlay', 'callSpeak'].includes(item.action)).map(item => item.text), ['A。', 'A。', 'B。', 'C。']);
});

test('a reply that could not be planned is explained once; the next turn clears the note', async () => {
  const f = fixture();
  let failPlan = true;
  const call = createVoiceCall({
    env: { crypto: { randomUUID: () => 'plan' }, setTimeout: () => 1, clearTimeout: () => {}, webkit: { messageHandlers: { meloVoice: { postMessage: message => f.posted.push(message) } } } },
    getContext: () => 'same', getChatId: () => 'c1', getAgentId: () => 'agent-a', isReplying: () => false,
    sendTurn: (text, observer) => new Promise(resolve => { f.turns.push({ text, observer, resolve }); }),
    sendSupplement: async () => {}, stopReply: () => {}, stopOtherAudio: () => {},
    requestSpeechPlan: async () => { if (failPlan) throw new Error('offline'); return { sentences: ['好的。'], serverVoice: false }; },
    requestSpeech: async () => null, readSettings: () => ({}), onChange: () => {},
  });
  call.start();
  call.receive({ sessionID: 'plan', type: 'state', phase: 'listening' });
  call.receive({ sessionID: 'plan', type: 'utterance', text: '第一问' });
  await flush();
  f.turns[0].observer.onEvent('reply_text', { text: '答案一。', final: true });
  await flush(); await flush();
  assert.equal(call.state.notice, 'speech-failed');
  assert.match(renderVoiceCall(call.state, escapeHtml), /没能读出来/);
  f.turns[0].observer.onSettled({ ok: true }); f.turns[0].resolve();
  failPlan = false;
  call.receive({ sessionID: 'plan', type: 'utterance', text: '第二问' });
  await flush();
  assert.equal(call.state.notice, '', 'the note belonged to the previous answer');
  f.turns[1].observer.onEvent('reply_text', { text: '好的。', final: true });
  await flush(); await flush();
  assert.equal(byAction(f.posted, 'callSpeak').at(-1).text, '好的。');
});

test('a failed or refused turn is said and shown; an aborted one is not', async () => {
  const f = started();
  f.native({ type: 'utterance', text: '第一问' });
  await flush();
  f.turns[0].observer.onSettled({ ok: false, error: '模型连接失败' });
  assert.equal(f.call.state.error, '模型连接失败');
  assert.equal(byAction(f.posted, 'callSpeak').at(-1).text, voiceCallPhrase('failed', 'zh'));
  const spokenBefore = byAction(f.posted, 'callSpeak').length;
  f.native({ type: 'utterance', text: '第二问' });
  await flush();
  f.turns[1].observer.onSettled({ ok: false, aborted: true });
  assert.equal(byAction(f.posted, 'callSpeak').length, spokenBefore, 'Stop is not a failure');
  // The send never started (another reply was running, an Agent switch): the call still says so.
  const refused = fixture();
  refused.call.start();
  refused.native({ type: 'state', phase: 'listening' });
  const call = createVoiceCall({
    env: { crypto: { randomUUID: () => 'x' }, webkit: { messageHandlers: { meloVoice: { postMessage: message => refused.posted.push(message) } } } },
    getContext: () => 'same', getChatId: () => 'c1', getAgentId: () => '', isReplying: () => false,
    sendTurn: async () => {}, sendSupplement: async () => {}, stopReply: () => {}, stopOtherAudio: () => {},
    requestSpeechPlan: async () => ({ sentences: [] }), requestSpeech: async () => null, readSettings: () => ({}), onChange: () => {},
  });
  call.start();
  call.receive({ sessionID: 'x', type: 'state', phase: 'listening' });
  call.receive({ sessionID: 'x', type: 'utterance', text: '你好' });
  await flush(); await flush();
  assert.match(call.state.error, /没有发出去/);
  assert.equal(call.state.replying, false);
});

test('another chat, Agent or view hangs up; so does end(); late events of the old session change nothing', async () => {
  const f = started();
  f.native({ type: 'utterance', text: '讲个故事' });
  await flush();
  f.turns[0].observer.onEvent('reply_text', { text: '很久以前。|有一座山。', final: true });
  f.setContext('chat|p|c2|agent-a');
  f.call.checkContext();
  assert.equal(byAction(f.posted, 'callEnd').length, 1);
  assert.equal(f.call.state.phase, 'ended');
  await flush(); await flush();
  assert.equal(byAction(f.posted, 'callPlay').length, 0, 'nothing is played after the hang-up');
  assert.ok(f.plans.every(plan => plan.signal.aborted), 'the speech plan request was aborted');
  f.native({ type: 'utterance', text: '挂断后的话' });
  await flush();
  assert.equal(f.turns.length, 1, 'no turn after the call ended');
  f.call.end();
  assert.equal(byAction(f.posted, 'callEnd').length, 1, 'a second hang-up sends nothing');

  const g = started();
  g.call.end();
  assert.equal(byAction(g.posted, 'callEnd').length, 1);
  g.call.start();
  const old = 'session-1';
  g.call.receive({ sessionID: old, type: 'utterance', text: '旧会话' });
  await flush();
  assert.equal(g.turns.length, 0, 'events of an earlier session are ignored');

  const h = started();
  h.setContext('chat|p|c1|agent-b');
  h.native({ type: 'utterance', text: '换了 Agent 之后' });
  await flush();
  assert.equal(h.turns.length, 0);
  assert.equal(byAction(h.posted, 'callEnd').length, 1, 'any event after a context change hangs up');
});

test('observerFor gives typed replies in the call chat a reader, and nothing elsewhere', () => {
  const f = started();
  assert.ok(f.call.observerFor('c1'));
  assert.equal(f.call.observerFor('c2'), null);
  assert.equal(f.call.activeFor('c1'), true);
  f.call.end();
  assert.equal(f.call.observerFor('c1'), null);
  assert.equal(f.call.activeFor('c1'), false);
});

test('mute, interrupt and the end-of-speech wait reach the native engine', async () => {
  const f = started();
  f.call.setMuted(true);
  f.call.interrupt();
  f.call.setEndpoint(600);
  assert.deepEqual(byAction(f.posted, 'callMute')[0].muted, true);
  assert.equal(byAction(f.posted, 'callInterrupt').length, 1);
  assert.equal(byAction(f.posted, 'callTiming')[0].endpointMs, 600);
});

test('the panel: controls while live, escaped words, explanations', () => {
  assert.equal(renderVoiceCall({ phase: 'idle', lines: [] }, escapeHtml), '');
  const live = renderVoiceCall({ phase: 'speaking', echoCancellation: true, muted: false, replying: false, partial: '<b>你好</b>', lines: [{ user: true, text: '<img src=x>' }, { user: false, text: '好的' }], error: '', notice: 'half-duplex' }, escapeHtml, { endpointMs: 1200 });
  assert.match(live, /data-action="interrupt-voice-call"/);
  assert.match(live, /data-action="mute-voice-call"/);
  assert.doesNotMatch(live, /data-action="toggle-voice-call"/, 'hang-up lives on the composer toggle, not twice');
  assert.match(live, /class="voice-call-dot"/, 'a live call shows the breathing dot');
  assert.match(live, /<option value="1200" selected>/);
  assert.match(live, /直接开口可以打断/);
  assert.match(live, /没有回声消除/);
  assert.doesNotMatch(live, /<img src=x>|<b>你好<\/b>/, 'user words are escaped');
  const listening = renderVoiceCall({ phase: 'listening', echoCancellation: true, muted: false, replying: true, partial: '', lines: [], error: '', notice: '' }, escapeHtml);
  assert.match(listening, /正在思考/);
  assert.doesNotMatch(listening, /interrupt-voice-call/);
  const failed = renderVoiceCall({ phase: 'failed', lines: [], error: '麦克风未获授权' }, escapeHtml);
  assert.match(failed, /通话已结束/);
  assert.match(failed, /麦克风未获授权/);
  assert.doesNotMatch(failed, /data-action/);
});

// 2026-11-16 entry redesign (option A): the call starts on any composer. Without a chat, the
// first sentence creates one and the call moves into it instead of hanging up on that change.
test('a call started without a chat: the first sentence creates it, the call moves in and stays', async () => {
  let f;
  const created = [];
  f = fixture({ chatId: null, sendTurn: (text, observer, chatId) => new Promise(resolve => {
    f.turns.push({ text, observer, chatId });
    if (chatId !== null) { observer.onSettled({ ok: true }); resolve(); return; }
    // What handleSendMessage does: create the chat (the page now shows it), then adopt it.
    f.setContext('chat|p|new-chat|agent-a');
    f.setChatId('new-chat');
    f.call.checkContext();
    created.push(voiceCallActive(f.call.state));
    // A native event arriving in that moment does not hang up either.
    f.native({ type: 'state', phase: 'listening', echoCancellation: true });
    created.push(voiceCallActive(f.call.state));
    f.call.adoptChat('new-chat', observer);
    observer.onSettled({ ok: true });
    resolve();
  }) });
  f.setContext('chat|p||agent-a');
  f.call.start();
  f.native({ type: 'state', phase: 'listening', echoCancellation: true });
  f.native({ type: 'utterance', text: '今天几号' });
  await flush();
  assert.equal(f.turns[0].chatId, null, 'the first sentence asks for a new chat');
  assert.deepEqual(created, [true, true], 'creating the chat neither hangs up nor ends on a native event');
  assert.equal(byAction(f.posted, 'callEnd').length, 0);
  assert.equal(f.call.activeFor('new-chat'), true, 'the call now belongs to the chat it created');
  const typed = f.call.observerFor('new-chat');
  assert.ok(typed, 'typed replies there are read by the call');
  typed.onSettled({ ok: true });
  f.native({ type: 'utterance', text: '再说一遍' });
  await flush();
  assert.equal(f.turns[1].chatId, 'new-chat', 'later sentences go to that chat');
  f.setContext('chat|p|other-chat|agent-a');
  f.call.checkContext();
  assert.equal(byAction(f.posted, 'callEnd').length, 1, 'leaving the adopted chat hangs up as usual');
});

test('creating the chat fails: nothing is adopted; a page that moved meanwhile hangs up, an unchanged one keeps the call', async () => {
  let f;
  f = fixture({ chatId: null, sendTurn: async (text, observer, chatId) => {
    f.turns.push({ text, observer, chatId });
    f.call.checkContext();
    throw new Error('offline');
  } });
  f.call.start();
  f.native({ type: 'state', phase: 'listening', echoCancellation: true });
  f.native({ type: 'utterance', text: '今天几号' });
  await flush(); await flush();
  assert.equal(voiceCallActive(f.call.state), true, 'same page: the call keeps listening');
  assert.match(f.call.state.error, /offline/);
  assert.equal(f.call.activeFor('new-chat'), false);

  let g;
  g = fixture({ chatId: null, sendTurn: async (text, observer, chatId) => {
    g.turns.push({ text, observer, chatId });
    g.setContext('projects|p||agent-a');
    g.call.checkContext();
    assert.equal(voiceCallActive(g.call.state), true, 'still creating: the change is not judged yet');
    throw new Error('offline');
  } });
  g.call.start();
  g.native({ type: 'state', phase: 'listening', echoCancellation: true });
  g.native({ type: 'utterance', text: '今天几号' });
  await flush(); await flush();
  assert.equal(byAction(g.posted, 'callEnd').length, 1, 'the page moved and no chat was created: hang up');
});

test('a second sentence while the chat is being created does not take over or end the creation', async () => {
  let f;
  let finishFirst;
  f = fixture({ chatId: null, sendTurn: (text, observer, chatId) => new Promise(resolve => {
    f.turns.push({ text, observer, chatId });
    if (f.turns.length === 1) { finishFirst = () => { f.call.adoptChat('new-chat', observer); observer.onSettled({ ok: true }); resolve(); }; return; }
    resolve(); // refused while the first send runs: never settled
  }) });
  f.call.start();
  f.native({ type: 'state', phase: 'listening', echoCancellation: true });
  f.native({ type: 'utterance', text: '第一句' });
  await flush();
  f.setContext('chat|p|new-chat|agent-a');
  f.setChatId('new-chat');
  f.native({ type: 'utterance', text: '第二句' });
  await flush(); await flush();
  assert.equal(f.turns.length, 1, 'creation is owned by the first sentence');
  assert.match(f.call.state.error, /没有发出去/, 'the refused second sentence is explained');
  assert.equal(voiceCallActive(f.call.state), true, 'the refused sentence did not end the creation');
  finishFirst();
  await flush();
  assert.equal(f.call.activeFor('new-chat'), true);
  assert.equal(byAction(f.posted, 'callEnd').length, 0);
});

test('the composer toggle: a labelled pill to start, a breathing "Hang up" while live', () => {
  const idle = renderVoiceCallToggle({ phase: 'idle' }, escapeHtml, { icon: '<svg id="wave"></svg>', liveIcon: '<svg id="stop"></svg>' });
  assert.match(idle, /class="voice-call-toggle "/);
  assert.match(idle, /data-action="toggle-voice-call"/);
  assert.match(idle, /aria-pressed="false"/);
  assert.match(idle, />通话</);
  assert.match(idle, /id="wave"/);
  assert.doesNotMatch(idle, /voice-call-dot/);
  const live = renderVoiceCallToggle({ phase: 'listening' }, escapeHtml, { icon: '<svg id="wave"></svg>', liveIcon: '<svg id="stop"></svg>' });
  assert.match(live, /voice-call-toggle is-live/);
  assert.match(live, /aria-pressed="true"/);
  assert.match(live, />挂断</);
  assert.match(live, /voice-call-dot/);
  assert.match(live, /id="stop"/);
  assert.match(live, /aria-label="挂断语音通话"/);
  assert.match(renderVoiceCallToggle({ phase: 'idle' }, escapeHtml, { disabled: true }), /disabled/, 'off while dictation holds the microphone');
});

test('same-chat redial isolates late stream events, settlement and terminal native states', async () => {
  const f = started();
  const old = f.call.observerFor('c1');
  f.call.end();
  f.native({ type: 'state', phase: 'listening' });
  assert.equal(f.call.state.phase, 'ended');
  f.call.start();
  f.native({ type: 'utterance', text: '新问题' });
  for (const event of ['tool_permission', 'tool_calls_start', 'reply_text']) {
    old.onEvent(event, { final: true, text: '上次通话' });
  }
  old.onSettled({ error: '旧失败' });
  await flush();
  assert.equal(f.call.state.replying, true);
  assert.equal(f.call.state.error, '');
  assert.equal(f.plans.length + f.requests.length, 0);
  assert.equal(byAction(f.posted, 'callSpeak').length, 0);
});

test('superseded or settled observers cannot deliver; drafts and duplicate finals do not speak', async () => {
  const f = started({ engine: 'macos' });
  const old = f.call.observerFor('c1');
  const active = f.call.observerFor('c1');
  old.onEvent('reply_text', { final: true, text: '旧回答。' });
  old.onSettled({ error: 'old' });
  active.onEvent('reply_text', { text: '候选句子' });
  for (let i = 0; i < 2; i++) active.onEvent('reply_text', { final: true, text: '已确定。' });
  active.onSettled({ ok: true });
  active.onEvent('tool_permission');
  await flush();
  assert.deepEqual(byAction(f.posted, 'callSpeak').map(c => c.text), ['已确定。']);
  assert.equal(f.requests.length + f.plans.length, 0);
  assert.equal(f.call.state.error, '');
});

test('hanging up while waiting for playback does not prepare another sentence', async () => {
  const f = started();
  f.call.observerFor('c1').onEvent('reply_text', { final: true, text: 'A|B|C|D' });
  await flush();
  const [first] = byAction(f.posted, 'callPlay');
  assert.equal(f.requests.length, 2);
  f.call.end();
  f.call.start();
  finishClip(f, first);
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(byAction(f.posted, 'callPlay').length, 1);
});

test('a second utterance before streaming begins preserves the first observer and its answer', async () => {
  const f = started();
  f.native({ type: 'utterance', text: '第一问' });
  f.native({ type: 'utterance', text: '第二问' });
  assert.equal(f.turns.length, 1);
  assert.match(f.call.state.error, /没有发出去/);
  f.turns[0].observer.onEvent('reply_text', { final: true, text: '第一问的回答' });
  await flush();
  assert.deepEqual(byAction(f.posted, 'callPlay').map(clip => clip.text), ['第一问的回答']);
});
