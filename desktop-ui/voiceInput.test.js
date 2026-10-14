import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInput, voiceInputSupported, renderVoiceInput } from './voiceInput.js';

function fixture(native = false) {
  let context = 'chat-A', counter = 0;
  const commits = [], messages = [], timers = new Map(), engines = [];
  class Recognition {
    start() { this.onstart?.(); }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; this.onend?.(); }
    result(text, final = false) { this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: final })] }); }
  }
  const env = {
    isSecureContext: true, crypto: { randomUUID: () => String(++counter) }, navigator: { language: 'en-AU' },
    setTimeout: fn => { const id = ++counter; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    SpeechRecognition: class extends Recognition { constructor() { super(); engines.push(this); } },
    ...(native ? { webkit: { messageHandlers: { meloVoice: { postMessage: message => messages.push(message) } } } } : {}),
  };
  const input = createVoiceInput({ env, getContext: () => context, onChange: () => {}, onCommit: text => commits.push(text) });
  return { input, commits, messages, timers, engines, env, changeChat: () => { context = 'chat-B'; } };
}

test('browser dictation previews, waits for final tail, commits once and never sends a message', () => {
  const f = fixture(); f.input.start(); const e = f.engines[0];
  e.result('你好'); assert.equal(f.input.state.preview, '你好'); assert.deepEqual(f.commits, []);
  f.input.stop(); assert.equal(f.input.state.status, 'stopping'); assert.ok(e.stopped);
  e.result('你好 Melo', true); e.onend(); e.onend();
  assert.deepEqual(f.commits, ['你好 Melo']); assert.equal(f.timers.size, 0); assert.ok(e.aborted);
});
test('cancel and stale browser callbacks cannot change the next session or another chat', () => {
  const f = fixture(); f.input.start(); const old = f.engines[0]; old.result('丢弃'); f.input.cancel();
  f.input.start(); old.result('迟到'); old.onend(); assert.equal(f.input.state.preview, '');
  f.engines[1].result('当前'); f.changeChat(); f.engines[1].result('其他对话');
  assert.deepEqual(f.commits, []); assert.equal(f.input.state.status, 'idle');
});
test('native session IDs reject stale partials, duplicate finals and raw audio auto-submit', () => {
  const f = fixture(true); f.input.start(); const id = f.input.state.sessionID;
  assert.equal(f.messages[0].language, 'zh-CN');
  f.input.receive({ sessionID: 'old', status: 'ready', finalText: '错误' });
  f.input.receive({ sessionID: id, status: 'listening', recording: true, partial: '你好' });
  f.input.stop(); f.input.receive({ sessionID: id, status: 'listening', recording: true, partial: '尾字' });
  assert.equal(f.input.state.status, 'stopping'); assert.equal(f.input.state.recording, false);
  f.input.receive({ sessionID: id, status: 'ready', finalText: '你好世界', audioData: 'ignored' });
  f.input.receive({ sessionID: id, status: 'ready', finalText: '重复' });
  assert.deepEqual(f.commits, ['你好世界']);
});
test('permission requests cannot multiply and can be cancelled before recording', () => {
  const f = fixture(true); f.input.start(); f.input.start();
  assert.equal(f.messages.length, 1); const id = f.input.state.sessionID;
  f.input.stop(); assert.equal(f.messages[1].action, 'cancelVoice');
  f.input.receive({ sessionID: id, status: 'listening', recording: true });
  assert.equal(f.input.state.status, 'idle');
});
test('failure retains recognized words and displays an actionable error', () => {
  const f = fixture(); f.input.start(); f.engines[0].result('已有草稿');
  f.engines[0].onerror({ error: 'network' });
  assert.deepEqual(f.commits, ['已有草稿']); assert.match(f.input.state.error, /网络/);
});
test('recording limit stops capture; final timeout preserves partial with an honest notice', () => {
  const f = fixture(); f.input.start(); f.engines[0].result('最后的词');
  [...f.timers.values()][0](); assert.equal(f.input.state.status, 'stopping');
  [...f.timers.values()][0](); assert.deepEqual(f.commits, ['最后的词']); assert.match(f.input.state.notice, /核对/);
});
test('unsupported or insecure browsers get a usable fallback explanation', () => {
  assert.equal(voiceInputSupported({}), false);
  assert.equal(voiceInputSupported({ SpeechRecognition: class {}, isSecureContext: false }), false);
  const f = fixture(); delete f.env.SpeechRecognition; f.input.start(); assert.match(f.input.state.error, /系统键盘听写/);
});
test('partial transcripts are escaped in the preview and cancellation is available', () => {
  const html = renderVoiceInput({ status: 'listening', preview: '<img>' }, s => s.replaceAll('<', '&lt;'));
  assert.match(html, /&lt;img>/); assert.match(html, /cancel-voice-input/); assert.match(html, /60 秒/);
});

test('native recording limit and missing stop reply both terminate without losing partials',()=>{
 const f=fixture(true);f.input.start();const id=f.input.state.sessionID;
 f.input.receive({sessionID:id,status:'listening',recording:true,partial:'保留文字'});
 assert.equal(f.timers.size,1);[...f.timers.values()][0]();assert.equal(f.input.state.status,'stopping');
 assert.equal(f.timers.size,1);[...f.timers.values()][0]();assert.equal(f.input.state.status,'ready');assert.deepEqual(f.commits,['保留文字']);assert.equal(f.messages.at(-1).action,'cancelVoice');
 f.input.receive({sessionID:id,status:'ready',finalText:'迟到'});assert.deepEqual(f.commits,['保留文字']);
});

test('native automatic stopping also has a bridge deadline if its final event is lost',()=>{
 const f=fixture(true);f.input.start();const id=f.input.state.sessionID;
 f.input.receive({sessionID:id,status:'listening',partial:'当前片段'});
 f.input.receive({sessionID:id,status:'stopping',recording:false});assert.equal(f.timers.size,1);
 [...f.timers.values()][0]();assert.equal(f.input.state.status,'ready');assert.deepEqual(f.commits,['当前片段']);
});
