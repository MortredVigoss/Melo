'use strict';

const { randomUUID } = require('node:crypto');

function bridgeError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function abortError() {
  return new DOMException('已停止回复。', 'AbortError');
}

function parseEventStreamBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim() || event;
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  try {
    return { event, payload: JSON.parse(data.join('\n')) };
  } catch {
    throw bridgeError('Melo 返回了无效的流式数据。', 'INVALID_STREAM_EVENT');
  }
}

/** A local transport for Melo's ordinary main-agent conversation; no model or prompt lives here. */
class MeloClient {
  constructor({ baseUrl = 'http://127.0.0.1:43127', readState = () => ({}), writeState = () => {}, emit = () => {}, fetchImpl = globalThis.fetch } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw bridgeError('Melo 地址必须是本机 HTTP 服务地址。', 'INVALID_MELO_URL');
    }
    this.baseUrl = url.origin;
    this.readState = readState;
    this.writeState = writeState;
    this.emit = emit;
    this.fetch = fetchImpl;
    this.controller = null;
    this.pendingPermissions = new Map();
  }

  get busy() { return this.controller !== null; }

  async json(route, body, signal) {
    const timeout = AbortSignal.timeout(15000);
    const response = await this.fetch(this.baseUrl + route, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw bridgeError(data.message || data.error || `Melo 连接失败 (${response.status})`, data.code || 'MELO_HTTP_ERROR', { status: response.status });
    return data;
  }

  async ensureChat(signal) {
    const saved = (await this.readState())?.chatId;
    const bootstrap = await this.json('/api/bootstrap', undefined, signal);
    const summary = saved && bootstrap.chats?.find(chat => chat.id === saved);
    if (saved && (summary || bootstrap.activeChat?.id === saved)) {
      // Melo's sidebar summaries deliberately omit agentId. Never interpret a
      // missing field as main, and never recreate a valid chat on every message.
      let detail = bootstrap.activeChat?.id === saved ? bootstrap.activeChat : null;
      if (!detail && typeof summary?.agentId === 'string') detail = summary;
      if (!detail) {
        // This is the same selection operation as clicking a conversation in
        // Melo, performed only before a user send (which selects it as well).
        const selected = await this.json('/api/settings', { selectedChatId: saved, activeView: 'chat' }, signal);
        detail = selected.activeChat;
      }
      if (detail?.id === saved && detail.agentId === 'main') return saved;
    }
    if (signal?.aborted) throw abortError();
    // Explicitly unscoped: another open Melo project must not change this pet's chat.
    const created = await this.json('/api/chats', { mode: 'chat', agentId: 'main', projectId: null }, signal);
    const chat = created.activeChat || created.bootstrap?.activeChat || created.chat;
    const chatId = chat?.id;
    if (!chatId || (chat.agentId && chat.agentId !== 'main')) throw bridgeError('Melo 没有返回主助手对话。', 'INVALID_MELO_CHAT');
    await this.writeState({ chatId });
    return chatId;
  }

  async send(content) {
    if (typeof content !== 'string' || !content.trim()) throw bridgeError('请输入消息。', 'EMPTY_MESSAGE');
    if (this.busy) throw bridgeError('上一条消息仍在回复中。', 'SEND_IN_PROGRESS');
    const controller = new AbortController();
    this.controller = controller;
    const requestId = randomUUID();
    let reader;
    try {
      this.emit({ event: 'status', payload: { phase: 'connecting', requestId } });
      const chatId = await this.ensureChat(controller.signal);
      if (controller.signal.aborted) throw abortError();
      this.emit({ event: 'status', payload: { phase: 'sending', chatId, requestId } });
      const response = await this.fetch(this.baseUrl + '/api/chat/send/stream', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        // Keep content byte-for-byte: no weather, location, persona or hidden instructions.
        body: JSON.stringify({ chatId, requestId, content, mode: 'chat', attachments: [] }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw bridgeError(error.message || error.error || `Melo 连接失败 (${response.status})`, error.code || 'MELO_HTTP_ERROR', { status: response.status });
      }
      if (!response.body) throw bridgeError('Melo 没有返回消息流。', 'EMPTY_STREAM');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let final = null;
      const receive = block => {
        const message = parseEventStreamBlock(block);
        if (!message) return;
        const { event, payload } = message;
        // File-safety events do not carry turn identity; other permission events do.
        const belongsToTurn = !payload?.turnRequestId || payload.turnRequestId === requestId;
        if (belongsToTurn && ['tool_permission', 'capability_request'].includes(event) && payload?.requestId) {
          this.pendingPermissions.set(payload.requestId, { event, payload, controller, submitting: false });
        } else if (event === 'capability_request_closed') {
          this.pendingPermissions.delete(payload?.requestId);
        }
        this.emit(message);
        if (event === 'done') final = payload;
        if (event === 'error') throw bridgeError(payload?.message || payload?.error || 'Melo 回复失败。', payload?.code || 'MELO_STREAM_ERROR', { requestId, chatId });
        if (event === 'aborted') throw abortError();
      };
      while (!final) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          receive(block);
          if (final) break;
        }
        if (done) {
          if (!final && buffer.trim()) receive(buffer);
          break;
        }
      }
      if (controller.signal.aborted) throw abortError();
      const reply = final?.assistantMessage?.content;
      if (typeof reply !== 'string' || !reply.trim()) throw bridgeError('Melo 回复未完成，请重试。', 'STREAM_INTERRUPTED');
      const result = { text: reply, chatId, requestId, messageId: final.assistantMessage.id, source: 'melo', modelResponses: final.assistantMessage.metadata?.modelResponses };
      await this.writeState({ lastReply: result });
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw abortError();
      throw error;
    } finally {
      try { await reader?.cancel(); } catch {}
      try { reader?.releaseLock(); } catch {}
      this.pendingPermissions.clear();
      if (this.controller === controller) this.controller = null;
      this.emit({ event: 'status', payload: { phase: 'idle', requestId } });
    }
  }

  /** Call only from an explicit user decision. Only this operation/run can be allowed. */
  async respondPermission(requestId, decision, { confirmInput = '' } = {}) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.controller !== this.controller || pending.controller.signal.aborted) throw bridgeError('这个授权请求已经结束。', 'PERMISSION_NOT_PENDING');
    if (!['allow', 'deny'].includes(decision)) throw bridgeError('授权选项无效。', 'INVALID_PERMISSION_DECISION');
    if (pending.submitting) throw bridgeError('正在保存这个授权选择。', 'PERMISSION_IN_PROGRESS');
    pending.submitting = true;
    const granted = decision === 'allow';
    const { event, payload, controller } = pending;
    try {
      let response;
      if (event === 'capability_request') {
        response = await this.json('/api/capability-requests/respond', { requestId, decision: granted ? 'run' : 'deny' }, controller.signal);
      } else {
        response = await this.json('/api/tools/permission-response', {
          requestId, granted, scope: 'once',
          ...(payload.kind === 'file_safety' ? { kind: 'file_safety', confirmInput: String(confirmInput), persistent: false } : { toolId: payload.toolId }),
        }, controller.signal);
      }
      if (response.ok === false) throw bridgeError(response.message || response.reason || response.error || '授权没有保存。', response.reason || 'PERMISSION_REJECTED');
      this.pendingPermissions.delete(requestId);
      this.emit({ event: 'permission_resolved', payload: { requestId, decision } });
      return response;
    } finally {
      pending.submitting = false;
    }
  }

  stop() {
    this.controller?.abort();
    this.pendingPermissions.clear();
  }
}

module.exports = { MeloClient, parseEventStreamBlock };
