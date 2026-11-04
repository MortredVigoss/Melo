import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { delimiter, dirname } from 'node:path';
export { mcpResultToToolResult } from './result.js';

export function httpEndpoint(input) {
  const url = new URL(input);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
    throw new Error('MCP requires HTTPS or loopback HTTP, without embedded credentials.');
  }
  return url;
}

// The official SDK owns framing, negotiation, cancellation, and cursor traversal.
export class McpStdioClient {
  constructor({ command, args = [], env = {}, cwd, name = 'mcp-server', url, headers, onClose, onToolsChanged, localTransport, managed = false }) {
    this.name = name;
    this.transportKind = localTransport ? 'in-process' : url ? 'http' : 'stdio';
    this.client = new Client({ name: 'melo', version: '1.0' }, {
      versionNegotiation: { mode: url && !managed ? 'auto' : 'legacy' },
    });
    if (localTransport) {
      this.transport=localTransport;
    } else if (url) {
      this.transport = new StreamableHTTPClientTransport(httpEndpoint(url), {
        requestInit: { headers, redirect: 'error' },
      });
    } else {
      this.transport = new StdioClientTransport({ command, args, cwd: cwd || undefined,
        env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), ...env },
        stderr: 'pipe' });
      this.transport.stderr?.on('data', chunk => process.stderr.write(`[mcp:${name}] ${chunk}`));
    }
    this.client.onclose = () => { this.connected = false; onClose?.(); };
    this.client.setNotificationHandler('notifications/tools/list_changed', () => onToolsChanged?.());
  }
  async connect() {
    await this.client.connect(this.transport, { timeout: 15000 });
    this.connected = true;
    return this.client.getServerCapabilities();
  }
  async listTools() { return (await this.client.listTools(undefined, { timeout: 15000, cache: 'refresh' })).tools; }
  async listResources() {
    if (!this.client.getServerCapabilities()?.resources) return [];
    return (await this.client.listResources()).resources;
  }
  readResource(uri) { return this.client.readResource({ uri }); }
  callTool(name, args = {}, signal) {
    signal?.throwIfAborted();
    return this.client.callTool({ name, arguments: args }, { signal, timeout: 60000 });
  }
  async disconnect() {
    this.connected = false;
    let timer;
    try {
      if(this.transport.terminateSession) await Promise.race([this.transport.terminateSession(),
        new Promise(resolve=>{timer=setTimeout(resolve,1000);timer.unref();})]);
    } catch { /* already gone */ }
    finally { clearTimeout(timer); await this.client.close(); }
  }
}
