// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from './i18n.js';
setFixtureLanguage('zh-CN');
// "登录电脑时启动 Melo": the page and the native shell must agree on the type
// of the value.
//
// Until 2026-11-14 they did not. The page turns the select's "true" / "false"
// into a JS boolean, a JS boolean reaches Swift as NSNumber, and main.swift
// compared the value with the STRING "true". "开启" therefore always took the
// unregister branch: the login item was never registered, on every macOS 13+.
//
// Registering a login item changes the user's system, so the native branch
// itself cannot run in a test. Three things can, and together they hold the
// contract: what the page sends (run), how the native parser reads that value
// (compiled and run), and that the launchAtLogin branch uses that parser
// (read from the source).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// localSettings.js is loaded from a data: URL so that its module state is
// fresh; its relative imports are pointed back at the real files.
const realFile = specifier => JSON.stringify(new URL(specifier, import.meta.url).href);
const source = (await readFile(new URL('./localSettings.js', import.meta.url), 'utf8'))
  .replace("'./i18n.js'", realFile('./i18n.js'))
  .replace("'../src/shared/userAgents.js'", realFile('../src/shared/userAgents.js'))
  .replace("'./agentAvatar.js'", realFile('./agentAvatar.js'))
  .replace("'./settingsEdit.js'", realFile('./settingsEdit.js'))
  .replace("'/shared/localPreferences.js'", realFile('../src/domain/settings/localPreferences.js'));

test('choosing 开启 or 关闭 sends a boolean for launchAtLogin through the native bridge', async () => {
  const local = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#launch-at-login');
  const dom = new JSDOM('<main></main>', { url: 'http://localhost' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
  const sent = [];
  let native = { launchAtLogin: false, loginNeedsApproval: false, closeBehavior: 'quit', notifications: false };
  window.webkit = { messageHandlers: { meloVoice: { postMessage(message) {
    if (message.action === 'setLocalSettings') { sent.push(message); native = { ...native, [message.key]: message.value }; }
    queueMicrotask(() => window.dispatchEvent(new window.CustomEvent('melo-local-settings', { detail: { requestID: message.requestID, ...native } })));
  } } } };
  const data = { profile: { name: 'fixture' }, settings: { localPreferences: {} }, chats: [], customize: { agents: [] } };
  const render = () => { document.querySelector('main').innerHTML = local.renderLocalSettings(data); };
  local.installLocalSettings({ uiState: { bootstrap: data }, render, api: async () => data, applyBootstrap() {}, stopSpeech() {} });
  const click = selector => document.querySelector(selector).click();
  const choose = value => { const select = document.querySelector('[data-local-native=launchAtLogin]'); select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    render(); await tick(); click('[data-tab=general]');
    click('[data-action=settings-edit]'); choose('true'); click('[data-action=settings-save]'); await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].key, 'launchAtLogin');
    assert.strictEqual(sent[0].value, true, 'a boolean, not the string "true"');
    assert.equal(document.querySelector('[data-local-native=launchAtLogin]').value, 'true', 'the saved state is shown');
    click('[data-action=settings-edit]'); choose('false'); click('[data-action=settings-save]'); await tick();
    assert.strictEqual(sent.at(-1).value, false);
  } finally {
    dom.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.localStorage;
  }
});

test('the native launchAtLogin branch reads its value with the parser that accepts a JS boolean', async () => {
  const swift = await readFile(new URL('../desktop-app/main.swift', import.meta.url), 'utf8');
  const start = swift.indexOf('key == "launchAtLogin"');
  assert.ok(start > 0, 'main.swift handles launchAtLogin');
  const branch = swift.slice(start, swift.indexOf('} else if key == "notifications"', start));
  assert.match(branch, /^key == "launchAtLogin", #available\(macOS 13, \*\), let enabled = DesktopPetManager\.boolValue\(payload\["value"\]\) \{/);
  assert.match(branch, /if enabled \{ try SMAppService\.mainApp\.register\(\) \}\s*else \{ try SMAppService\.mainApp\.unregister\(\) \}/);
  assert.doesNotMatch(swift.replace(/\/\/.*$/gm, ''), /payload\["value"\] as\? String == "true"/, 'no branch decides on the string "true" any more');
});

test('compiled: the parser reads a bridged boolean, which is not a String', { skip: process.platform !== 'darwin' ? 'macOS only' : false, timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'melo-launch-at-login-'));
  try {
    const entry = join(directory, 'main.swift');
    await writeFile(entry, `
import Foundation
// What WKScriptMessage hands over for a JS \`true\` / \`false\`.
let bridgedTrue: Any = NSNumber(value: true)
let bridgedFalse: Any = NSNumber(value: false)
func show(_ value: Bool?) -> String { value.map { $0 ? "true" : "false" } ?? "nil" }
print("old-check-on-bridged-true=\\(bridgedTrue as? String == "true")")
print("bool(bridged true)=\\(show(DesktopPetManager.boolValue(bridgedTrue)))")
print("bool(bridged false)=\\(show(DesktopPetManager.boolValue(bridgedFalse)))")
print("bool(\\"true\\")=\\(show(DesktopPetManager.boolValue("true")))")
print("bool(\\"false\\")=\\(show(DesktopPetManager.boolValue("false")))")
print("bool(\\"maybe\\")=\\(show(DesktopPetManager.boolValue("maybe")))")
print("bool(nil)=\\(show(DesktopPetManager.boolValue(nil)))")
`);
    const binary = join(directory, 'fixture');
    // DesktopPet.swift holds the parser; it needs ProcessShutdown.swift to compile.
    const shell = name => fileURLToPath(new URL(`../desktop-app/${name}`, import.meta.url));
    execFileSync('xcrun', ['swiftc', shell('DesktopPet.swift'), shell('ProcessShutdown.swift'), entry, '-o', binary], { timeout: 150_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = execFileSync(binary, { encoding: 'utf8', timeout: 20_000 }).trim().split('\n');
    assert.deepEqual(output, [
      'old-check-on-bridged-true=false', // why "开启" never registered the login item
      'bool(bridged true)=true',
      'bool(bridged false)=false',
      'bool("true")=true',
      'bool("false")=false',
      'bool("maybe")=nil',
      'bool(nil)=nil',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
