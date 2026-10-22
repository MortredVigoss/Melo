'use strict';
const api = window.meloPet;
const messages = document.getElementById('messages');
const permissions = document.getElementById('permissions');
const status = document.getElementById('status');
const input = document.getElementById('input');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
let state = { messages: [], run: { busy: false, text: '', permissions: [], tools: [] } };
let composing = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderMessages() {
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 70;
  messages.replaceChildren();
  for (const message of state.messages) {
    const article = element('article', undefined, `message ${message.role}`);
    article.append(element('span', message.role === 'assistant' ? 'Melo' : '你', 'message-label'), element('div', message.content));
    messages.append(article);
  }
  if (state.run.text) {
    const article = element('article', undefined, 'message assistant pending');
    article.append(element('span', 'Melo', 'message-label'), element('div', state.run.text));
    messages.append(article);
  }
  if (nearBottom || state.run.busy) messages.scrollTop = messages.scrollHeight;
}

function renderStatus() {
  const run = state.run;
  status.classList.toggle('error', !!run.error);
  if (run.error) status.textContent = run.error;
  else if (!run.busy) status.textContent = '';
  else if (run.permissions.length) status.textContent = '等待你的授权选择';
  else if (run.tools.length) status.textContent = run.tools.map(tool => `正在使用工具：${tool.name || tool.id}`).join('\n');
  else if (run.work) status.textContent = run.work;
  else status.textContent = ({ connecting: '正在连接 Melo…', sending: '正在发送…', waiting: 'Melo 正在处理…', replying: '正在接收回复…', tools: '正在执行工具…' })[run.phase] || 'Melo 正在处理…';
  send.disabled = run.busy || !input.value.trim();
  stop.hidden = !run.busy;
}

function renderPermissions() {
  const existing = new Set([...permissions.children].map(node => node.dataset.requestId));
  for (const { event, payload } of state.run.permissions) {
    if (!payload.requestId || existing.has(payload.requestId)) continue;
    const card = element('article', undefined, 'permission');
    card.dataset.requestId = payload.requestId;
    card.append(element('h2', event === 'capability_request' ? 'Melo 请求临时使用能力' : 'Melo 请求执行操作'));
    // Keep the human-facing explanation first; detailed tool arguments remain reviewable.
    const operationNames = { read: '读取文件', read_batch: '读取一组文件', write_new: '创建文件', write_overwrite: '覆盖文件', edit: '编辑文件', move: '移动文件', delete: '删除文件', bash: '运行命令' };
    if (event === 'capability_request') card.append(element('p', payload.prompt || payload.capabilityLabel || payload.reason || '需要你的临时授权。'));
    else card.append(element('p', operationNames[payload.operation] || payload.toolId || '请确认下面的操作。'));
    for (const text of [payload.reason, payload.path, payload.src && `从：${payload.src}`, payload.dst && `到：${payload.dst}`, payload.command, payload.diffPreview, payload.contentPreview].filter(Boolean)) card.append(element('pre', text));
    if (Array.isArray(payload.paths)) card.append(element('pre', payload.paths.join('\n')));
    const details = { ...payload };
    delete details.requestId; delete details.turnRequestId; delete details.runId; delete details.chatId;
    const disclosure = element('details');
    disclosure.append(element('summary', '查看操作详情'), element('pre', JSON.stringify(details, null, 2)));
    card.append(disclosure);
    let confirmation;
    if (payload.kind === 'file_safety' && (payload.expectedConfirmation || payload.stage === 'confirm')) {
      const label = element('label', payload.expectedConfirmation ? `请输入「${payload.expectedConfirmation}」确认：` : '请输入操作要求的确认文字：');
      confirmation = element('input');
      confirmation.type = 'text';
      confirmation.autocomplete = 'off';
      confirmation.setAttribute('aria-label', '操作确认文字');
      label.append(confirmation); card.append(label);
    }
    const error = element('p', '', 'permission-error');
    const actions = element('div', undefined, 'permission-actions');
    for (const [decision, title] of [['deny', '拒绝'], ['allow', event === 'capability_request' ? '本次任务允许' : '仅这次允许']]) {
      const button = element('button', title, decision);
      button.type = 'button';
      button.addEventListener('click', async () => {
        const buttons = [...actions.querySelectorAll('button')]; buttons.forEach(item => { item.disabled = true; });
        error.textContent = '';
        try {
          await api.permission(payload.requestId, decision, confirmation?.value || '');
          state.run.permissions = state.run.permissions.filter(item => item.payload.requestId !== payload.requestId);
          renderPermissions(); renderStatus();
        } catch (failure) { error.textContent = failure.message; }
        finally { buttons.forEach(item => { item.disabled = false; }); }
      });
      actions.append(button);
    }
    card.append(error, actions); permissions.append(card);
  }
  const wanted = new Set(state.run.permissions.map(item => item.payload.requestId));
  for (const card of [...permissions.children]) if (!wanted.has(card.dataset.requestId)) card.remove();
}

function applySnapshot(next) {
  state = next;
  renderMessages(); renderPermissions(); renderStatus();
}

api.onSnapshot(applySnapshot);
api.onEvent(({ event, payload }) => {
  const run = state.run;
  if (event === 'status') run.phase = payload.phase;
  if (event === 'started') run.phase = 'waiting';
  if (event === 'delta') { run.text = typeof payload.text === 'string' ? payload.text : run.text + String(payload.delta || ''); run.phase = 'replying'; renderMessages(); }
  if (event === 'tool_calls_start') { run.tools = payload.calls || []; run.phase = 'tools'; }
  if (event === 'tool_calls_done') { run.tools = []; run.phase = 'waiting'; }
  if (event === 'execution_scene') run.work = [...(payload.scene?.pipeline || []), ...(payload.scene?.operations || [])].filter(item => item.status === 'running').map(item => item.name).filter(Boolean).join(' · ');
  if (event === 'tool_permission' || event === 'capability_request') {
    run.permissions = run.permissions.filter(item => item.payload.requestId !== payload.requestId);
    run.permissions.push({ event, payload }); renderPermissions();
  }
  if (event === 'permission_resolved' || event === 'capability_request_closed') { run.permissions = run.permissions.filter(item => item.payload.requestId !== payload.requestId); renderPermissions(); }
  renderStatus();
});
api.onFocus(() => input.focus());
document.getElementById('hide').addEventListener('click', () => api.hide());
stop.addEventListener('click', () => api.stop());
input.addEventListener('input', renderStatus);
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; });
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); document.getElementById('composer').requestSubmit(); }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); api.hide(); } });
document.getElementById('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.run.busy || !input.value.trim()) return;
  const text = input.value;
  input.value = '';
  state.run.busy = true;
  renderStatus();
  try { await api.send(text); }
  catch (error) { state.run.error = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); renderStatus(); }
  finally { input.focus(); }
});
api.state().then(applySnapshot).catch(error => { status.textContent = error.message; status.className = 'error'; });
