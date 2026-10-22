'use strict';
const { app, BrowserWindow, ipcMain, screen, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MeloClient } = require('./melo-client.cjs');
const { createControlServer } = require('./control-server.cjs');
const { writeRuntimeInfo, removeRuntimeInfo } = require('./runtime-info.cjs');

const root = __dirname;
const profile = process.env.MELO_PET_PROFILE || path.join(app.getPath('appData'), 'melo-desktop-pet-dsh');
const meloBaseUrl = process.env.MELO_BASE_URL || 'http://127.0.0.1:43127';
const upstream = path.join(root, 'upstream');
const hostEntry = path.join(upstream, 'lib', 'melo-host.mjs');
const helperExecutable = process.platform === 'darwin' ? path.join(root, 'runtime', 'DSHPet.app', 'Contents', 'MacOS', 'Electron') : process.execPath;
const dialogEntry = path.join(root, 'dialog', 'index.html');
const dialogUrl = pathToFileURL(dialogEntry).href;
const stateFile = path.join(profile, 'conversation.json');
// Melo reads this to show the real pet status and to send /quit; see runtime-info.cjs.
const runtimeFile = path.join(profile, 'runtime.json');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setName('melo桌宠');
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

let chatWindow = null;
let chatReady = null;
let hostProcess = null;
let controlServer = null;
let shuttingDown = false;
let shutdownComplete = false;
let currentPetId = '';
let run = { busy: false, text: '', phase: 'idle', tools: [], permissions: [], work: '', error: '' };
let state = { chatId: '', messages: [] };
if (fs.existsSync(stateFile)) {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state = { ...saved, messages: Array.isArray(saved.messages) ? saved.messages.filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string') : [] };
  } catch (error) { console.error('[melo-pet-controller] conversation state unreadable:', error.message); }
}

function saveState(patch) {
  state = { ...state, ...patch };
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

function snapshot() {
  return { messages: state.messages, chatId: state.chatId, run, petId: currentPetId };
}

function sendUi(channel, payload) {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send(channel, payload);
}

function broadcast() { sendUi('melo:snapshot', snapshot()); }

const client = new MeloClient({
  baseUrl: meloBaseUrl,
  readState: () => state,
  writeState: saveState,
  emit: message => {
    const { event, payload } = message;
    if (event === 'status') run.phase = payload.phase;
    if (event === 'started') run.phase = 'waiting';
    if (event === 'delta') {
      run.phase = 'replying';
      run.text = typeof payload.text === 'string' ? payload.text : run.text + String(payload.delta || '');
    }
    if (event === 'tool_calls_start') { run.phase = 'tools'; run.tools = payload.calls || []; }
    if (event === 'tool_calls_done') { run.phase = 'waiting'; run.tools = []; }
    if (event === 'execution_scene') run.work = [...(payload.scene?.pipeline || []), ...(payload.scene?.operations || [])].filter(item => item.status === 'running').map(item => item.name).filter(Boolean).join(' · ');
    if (event === 'tool_permission' || event === 'capability_request') {
      run.phase = 'permission';
      run.permissions = run.permissions.filter(item => item.payload.requestId !== payload.requestId);
      run.permissions.push(message);
    }
    if (event === 'permission_resolved' || event === 'capability_request_closed') run.permissions = run.permissions.filter(item => item.payload.requestId !== payload.requestId);
    // Renderer receives the unmodified event, including execution_scene/tool details.
    sendUi('melo:event', message);
  },
});

function trustedSender(event) {
  if (!chatWindow || event.sender !== chatWindow.webContents || event.senderFrame !== chatWindow.webContents.mainFrame || event.senderFrame.url !== dialogUrl) throw new Error('Untrusted IPC sender.');
}

async function openChat(petId = '') {
  if (shuttingDown) return;
  currentPetId = petId || currentPetId;
  if (!chatWindow || chatWindow.isDestroyed()) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(420, area.width), height = Math.min(560, area.height);
    chatWindow = new BrowserWindow({
      title: '与 Melo 对话', width, height,
      x: area.x + area.width - width - Math.min(24, area.width - width),
      y: area.y + area.height - height - Math.min(24, area.height - height),
      minWidth: Math.min(340, area.width), minHeight: Math.min(360, area.height),
      show: false, autoHideMenuBar: true, backgroundColor: '#151820',
      webPreferences: { preload: path.join(root, 'dialog', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    chatWindow.setMenu(null);
    chatWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    chatWindow.webContents.on('will-navigate', event => event.preventDefault());
    chatWindow.webContents.on('will-redirect', event => event.preventDefault());
    chatWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    chatWindow.on('close', event => { if (!shuttingDown) { event.preventDefault(); chatWindow.hide(); } });
    chatWindow.on('closed', () => { chatWindow = null; chatReady = null; });
    chatReady = chatWindow.loadFile(dialogEntry);
  }
  await chatReady;
  if (shuttingDown || !chatWindow || chatWindow.isDestroyed()) return;
  chatWindow.show();
  chatWindow.focus();
  broadcast();
  sendUi('melo:focus', {});
}

async function sendMessage(text) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('请输入消息。'), { code: 'EMPTY_MESSAGE' });
  if (run.busy || client.busy) throw Object.assign(new Error('上一条消息仍在回复中。'), { code: 'SEND_IN_PROGRESS' });
  run = { busy: true, text: '', phase: 'connecting', tools: [], permissions: [], work: '', error: '' };
  saveState({ messages: [...state.messages, { id: randomUUID(), role: 'user', content: text, createdAt: new Date().toISOString() }] });
  broadcast();
  try {
    const result = await client.send(text);
    saveState({ messages: [...state.messages, { id: result.messageId || randomUUID(), role: 'assistant', content: result.text, createdAt: new Date().toISOString(), requestId: result.requestId, source: result.source }] });
    run.text = '';
    return result;
  } catch (error) {
    run.error = error.name === 'AbortError' ? '已停止回复。' : error.cause?.code === 'ECONNREFUSED' || error.message === 'fetch failed'
      ? '暂时连接不到 Melo，请先打开 Melo。' : error.message;
    if (run.error !== error.message) error = new Error(run.error);
    throw error;
  } finally {
    run.busy = false;
    run.phase = 'idle';
    run.permissions = [];
    run.tools = [];
    run.work = '';
    broadcast();
  }
}

function signalHostTree(signal) {
  if (!hostProcess?.pid) return;
  try {
    if (process.platform === 'win32') hostProcess.kill(signal);
    else process.kill(-hostProcess.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') console.error('[melo-pet-controller] stop host:', error.message); }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  client.stop();
  const stopped = hostProcess && hostProcess.exitCode === null && hostProcess.signalCode === null
    ? new Promise(resolve => {
      const timer = setTimeout(resolve, 2000);
      hostProcess.once('exit', () => { clearTimeout(timer); resolve(); });
    }) : Promise.resolve();
  signalHostTree('SIGTERM');
  await stopped;
  // The helper inherits the dedicated host process group, including across skin restarts.
  signalHostTree('SIGKILL');
  await controlServer?.close();
  removeRuntimeInfo(runtimeFile, process.pid);
  shutdownComplete = true;
  app.quit();
}

function startHost() {
  if (!fs.existsSync(hostEntry)) throw new Error(`缺少 DSH 运行入口：${hostEntry}`);
  const token = randomBytes(32).toString('hex');
  return createControlServer({
    token,
    onOpenChat: openChat,
    onChat: sendMessage,
    onQuit: shutdown,
    health: () => ({ ok: true, busy: run.busy, hostPid: hostProcess?.pid || null }),
  }).then(server => {
    controlServer = server;
    hostProcess = spawn(process.execPath, [hostEntry], {
      cwd: upstream, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(profile, 'dsh'), DSH_PET_ELECTRON_PATH: helperExecutable, MELO_PET_CONTROL_URL: server.url, MELO_PET_CONTROL_TOKEN: token },
    });
    hostProcess.stdout.on('data', chunk => process.stdout.write(chunk));
    hostProcess.stderr.on('data', chunk => process.stderr.write(chunk));
    hostProcess.on('error', error => { run.error = `DSH 启动失败：${error.message}`; broadcast(); console.error('[melo-pet-controller]', run.error); });
    hostProcess.on('exit', (code, signal) => {
      if (!shuttingDown) { run.error = `DSH 已退出（${signal || code}）。请重新打开桌宠。`; broadcast(); console.error('[melo-pet-controller]', run.error); }
    });
    writeRuntimeInfo(runtimeFile, { pid: process.pid, hostPid: hostProcess.pid, controlUrl: server.url, token, meloBaseUrl, profile, startedAt: new Date().toISOString() });
    console.log('[melo-pet-controller]', JSON.stringify({ event: 'ready', controlUrl: server.url, pid: process.pid, hostPid: hostProcess.pid, profile, runtimeFile }));
  });
}

if (primary) {
  app.on('second-instance', () => { if (chatWindow?.isVisible()) chatWindow.focus(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => { if (!shutdownComplete) { event.preventDefault(); void shutdown(); } });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('exit', () => { signalHostTree('SIGTERM'); try { removeRuntimeInfo(runtimeFile, process.pid); } catch {} });
  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock.hide();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'melo桌宠', submenu: [{ label: '与 Melo 对话', click: () => { void openChat(); } }, { type: 'separator' }, { label: '退出桌宠', click: () => { void shutdown(); } }] }, { role: 'editMenu' }]));
    ipcMain.handle('melo:state', event => { trustedSender(event); return snapshot(); });
    ipcMain.handle('melo:send', async (event, text) => { trustedSender(event); return sendMessage(text); });
    ipcMain.handle('melo:stop', event => { trustedSender(event); client.stop(); return { ok: true }; });
    ipcMain.handle('melo:hide', event => { trustedSender(event); chatWindow.hide(); return { ok: true }; });
    ipcMain.handle('melo:permission', async (event, requestId, decision, confirmInput) => { trustedSender(event); return client.respondPermission(requestId, decision, { confirmInput }); });
    ipcMain.handle('melo:open-link', async (event, value) => {
      trustedSender(event);
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持这个链接。');
      await shell.openExternal(url.href);
      return { ok: true };
    });
    await startHost();
  }).catch(error => { console.error('[melo-pet-controller] startup failed:', error.message); void shutdown(); });
}
