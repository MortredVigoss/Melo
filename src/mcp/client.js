/**
 * Lightweight MCP (Model Context Protocol) stdio client.
 *
 * Implements the JSON-RPC 2.0 transport over a child process's stdin/stdout.
 * Supports the minimal set of MCP methods needed to register and call tools:
 *
 *   initialize          – capability handshake
 *   tools/list          – discover available tools
 *   tools/call          – invoke a tool
 *   resources/list      – list resources (optional)
 *   resources/read      – read a resource (optional)
 *
 * Connection lifecycle:
 *   const client = new McpStdioClient({ command, args, env });
 *   await client.connect();          // spawns process, initializes
 *   const tools = await client.listTools();
 *   const result = await client.callTool('toolName', { arg1: 'value' });
 *   client.disconnect();             // kills process
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname } from 'node:path';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const CONNECT_TIMEOUT_MS   = 15_000;
const CALL_TIMEOUT_MS      = 60_000;

export class McpStdioClient {
  /**
   * @param {Object} options
   * @param {string}   options.command  - executable (e.g. 'npx', 'python3')
   * @param {string[]} [options.args]   - arguments
   * @param {Object}   [options.env]    - extra env vars merged with process.env
   * @param {string}   [options.name]   - human-readable server name for logging
   * @param {string}   [options.cwd]    - default working directory for the
   *                                     child process. melo defaults each MCP
   *                                     server to its own subtree under
   *                                     `~/.melo/desktop/mcp-workspace/<name>/`
   *                                     so artefacts the server writes
   *                                     without an explicit path land
   *                                     somewhere predictable.  This is NOT
   *                                     a sandbox — a misbehaving server can
   *                                     still touch any path the OS allows
   *                                     via absolute paths or `..`.  Real
   *                                     access control is enforced by the
   *                                     per-agent whitelist + per-call
   *                                     approval modal in melo. Caller is
   *                                     responsible for creating the
   *                                     directory before calling `connect()`
   *                                     (see manager.js).
   */
  constructor({ command, args = [], env = {}, name = 'mcp-server', cwd = null }) {
    this.command  = command;
    this.args     = args;
    this.envVars  = env;
    this.name     = name;
    this.cwd      = cwd;
    this._proc    = null;
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._buffer  = '';
    this._connected = false;
    this._capabilities = {};
  }

  // ─── Connect ────────────────────────────────────────────────────────────────

  async connect() {
    if (this._connected) return;

    const spawnOptions = {
      // Native app launches may find Node through NVM while inheriting only
      // system PATH entries. Its sibling npm/npx and node shebangs must also
      // resolve. An explicit per-server PATH still takes precedence.
      env: { ...process.env,
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
        ...this.envVars },
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (this.cwd) spawnOptions.cwd = this.cwd;

    this._proc = spawn(this.command, this.args, spawnOptions);

    this._proc.stderr.on('data', chunk => {
      // Surface MCP server stderr to Node stderr prefixed with server name
      process.stderr.write(`[mcp:${this.name}] ${chunk}`);
    });

    this._proc.on('close', (code) => {
      this._connected = false;
      // Reject all pending requests
      for (const { reject, timer } of this._pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server "${this.name}" exited with code ${code}`));
      }
      this._pending.clear();
    });

    this._proc.on('error', (err) => {
      this._connected = false;
      for (const { reject, timer } of this._pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this._pending.clear();
    });

    // Line-framed JSON-RPC reader
    this._proc.stdout.on('data', chunk => {
      this._buffer += chunk.toString('utf8');
      let nl;
      while ((nl = this._buffer.indexOf('\n')) !== -1) {
        const line = this._buffer.slice(0, nl).trim();
        this._buffer = this._buffer.slice(nl + 1);
        if (line) this._handleMessage(line);
      }
    });

    // Capability handshake
    const initResult = await this._request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'melo', version: '1.0' },
    }, CONNECT_TIMEOUT_MS);

    this._capabilities = initResult?.capabilities || {};

    // Notify server that initialization is complete
    this._notify('notifications/initialized', {});

    this._connected = true;
    return this._capabilities;
  }

  // ─── Disconnect ──────────────────────────────────────────────────────────────

  disconnect() {
    this._connected = false;
    if (this._proc) {
      try { this._proc.stdin.end(); } catch {}
      try { this._proc.kill('SIGTERM'); } catch {}
      this._proc = null;
    }
  }

  // ─── Tools ──────────────────────────────────────────────────────────────────

  /**
   * List all tools provided by this server.
   * @returns {Promise<Array<{ name: string, description: string, inputSchema: Object }>>}
   */
  async listTools() {
    const result = await this._request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /**
   * Call a tool on the MCP server.
   * @param {string} toolName
   * @param {Object} args
   * @returns {Promise<{ content: Array, isError?: boolean }>}
   */
  async callTool(toolName, args = {}) {
    const result = await this._request('tools/call', {
      name: toolName,
      arguments: args,
    }, CALL_TIMEOUT_MS);
    return result;
  }

  // ─── Resources (optional) ────────────────────────────────────────────────────

  async listResources() {
    if (!this._capabilities?.resources) return [];
    try {
      const result = await this._request('resources/list', {});
      return Array.isArray(result?.resources) ? result.resources : [];
    } catch {
      return [];
    }
  }

  async readResource(uri) {
    const result = await this._request('resources/read', { uri });
    return result;
  }

  // ─── Internal JSON-RPC transport ─────────────────────────────────────────────

  _request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this._proc) {
        reject(new Error(`MCP server "${this.name}" is not running.`));
        return;
      }

      const id = randomUUID();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request "${method}" to "${this.name}" timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        this._proc.stdin.write(msg);
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _notify(method, params) {
    if (!this._proc) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try { this._proc.stdin.write(msg); } catch {}
  }

  _handleMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON lines
    }

    // JSON-RPC response (has 'id')
    if (msg.id != null) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(msg.id);

      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server notification (no id) — ignore for now
  }
}

// ─── Convert MCP tool result to a plain string ──────────────────────────────

/**
 * Flatten MCP tool result content blocks into a plain string.
 * MCP returns content as an array of { type, text } blocks.
 *
 * @param {{ content: Array, isError?: boolean }} result
 * @returns {{ ok: boolean, output: string }}
 */
export function mcpResultToToolResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .map(b => {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'image') return `[image: ${b.mimeType || 'unknown'}]`;
      if (b.type === 'resource') return `[resource: ${b.resource?.uri || 'unknown'}]`;
      return JSON.stringify(b);
    })
    .join('\n');

  return {
    ok: !result?.isError,
    output: text || '(no output)',
  };
}
