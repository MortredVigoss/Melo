import {validateProjectMemory} from './projectMemoryProtocol.js';
import {validateAgentSettings} from './agentSettingsProtocol.js';
import {mergeWorkspaces} from './workspaceProtocol.js';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeSnapshots, validateSnapshot } from './protocol.js';
export function authorized(request, token) {
  const actual = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return token.length >= 32 && actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function createSyncServer({ token, directory }) {
  if (!token || token.length < 32) throw new Error('Set a random MELO_SYNC_TOKEN of at least 32 characters');
  const file = join(directory, 'conversations.json');
  let queue = Promise.resolve();
  const read = async () => {
    try { return validateSnapshot(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, chats: [] }; throw error; }
  };
  return createServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    const projectMemory=request.url==='/v1/project-memory';
    const settings=request.url==='/v1/agent-settings'||projectMemory;
    const validateExtension=projectMemory?validateProjectMemory:validateAgentSettings;
    const targetFile=settings?join(directory,projectMemory?'project-memory.json':'agent-settings.json'):file;
    if ((!settings && request.url !== '/v1/sync') || request.method !== 'POST') return reply(404, { error: 'Not found' });
    if (!authorized(request, token)) return reply(401, { error: 'Unauthorized' });
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { reply(413, { error: 'Snapshot exceeds 8 MB' }); request.resume(); return; }
        chunks.push(chunk);
      }
      let incoming;
      try { incoming = (settings?validateExtension:validateSnapshot)(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { return reply(400, { error: 'Invalid snapshot' }); }
      const transaction = queue.then(async () => {
        let stored;
        if(settings){try{stored=validateExtension(JSON.parse(await readFile(targetFile,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;stored={version:1,records:[]};}}
        const merged = settings?validateExtension(mergeWorkspaces(stored,incoming)):mergeSnapshots(await read(), incoming);
        const serialized = JSON.stringify(merged);
        if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw Object.assign(new Error('Storage limit'), { status: 413 });
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(targetFile + '.tmp', serialized, { mode: 0o600 });
        await rename(targetFile + '.tmp', targetFile);
        return merged;
      });
      queue = transaction.catch(() => {});
      reply(200, await transaction);
    } catch (error) { reply(error.status || 500, { error: error.status === 409 ? error.message : 'Sync failed; existing data preserved' }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createSyncServer({ token: process.env.MELO_SYNC_TOKEN, directory: resolve(process.env.MELO_SYNC_DIR || './sync-data') });
  server.requestTimeout = 15000;
  server.listen(Number(process.env.PORT || 43129), '127.0.0.1', () => console.log('Melo sync listening on loopback; use an HTTPS reverse proxy for remote devices.'));
}
