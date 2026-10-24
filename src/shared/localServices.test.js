import test from 'node:test';
import assert from 'node:assert/strict';
import { customVoiceActive, customVoiceService, localServiceUrl } from './localServices.js';

test('custom voice identity survives alternate ports and does not replace transcription settings', () => {
  const config = { ttsProvider: 'custom', customVoiceBaseUrl: 'http://localhost:19281/v1', whisperBaseUrl: 'https://transcribe.example/v1' };
  assert.equal(customVoiceActive(config), true);
  assert.equal(customVoiceService(config).healthUrl, 'http://localhost:19281/health');
  assert.equal(customVoiceService(config).port, '19281');
  assert.equal(config.whisperBaseUrl, 'https://transcribe.example/v1');
  assert.equal(customVoiceActive({ ...config, ttsProvider: 'edge' }), false);
});
test('legacy exact endpoint compatibility does not claim another service', () => {
  assert.equal(customVoiceActive({ whisperBaseUrl: 'http://127.0.0.1:7860/v1' }), true);
  for (const url of ['http://127.0.0.1:7860/other', 'https://example.com/127.0.0.1:7860', 'http://127.0.0.1.evil.test:7860/v1', 'http://localhost:9999/v1']) {
    assert.equal(customVoiceActive({ whisperBaseUrl: url }), false, url);
  }
});
test('IPv6 health address is valid; remote and credential-bearing service URLs are rejected', () => {
  assert.equal(customVoiceService({customVoiceBaseUrl:'http://[::1]:9000/v1/'}).healthUrl, 'http://[::1]:9000/health');
  for(const url of ['https://example.com/v1','http://user:secret@localhost:7860/v1','file:///tmp/a']) assert.throws(()=>localServiceUrl(url));
});
