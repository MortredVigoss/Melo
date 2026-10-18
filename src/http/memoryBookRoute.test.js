// Bug audit 2026-10-18 M6: POST /api/projects/memory-book validates the project
// and the section through the real route (the service became async; the route
// must await it so errors reach the client instead of an unhandled rejection).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home, previous;
test.beforeEach(async () => { previous = process.env.MELO_HOME; home = await mkdtemp(join(tmpdir(), 'melo-book-route-')); process.env.MELO_HOME = home; });
test.afterEach(async () => { if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous; await rm(home, { recursive: true, force: true }); });

function request(body) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = 'POST'; stream.headers = {}; stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}
function response() {
  const out = { statusCode: null, body: '' };
  out.writeHead = code => { out.statusCode = code; }; out.end = chunk => { out.body += chunk || ''; };
  out.setHeader = () => {}; out.getHeader = () => undefined; out.headersSent = false;
  return out;
}

test('POST /api/projects/memory-book rejects an unknown project and an invalid section, writes a valid row', async () => {
  const { handleDomainRoutes } = await import('./domainRoutes.js');
  const { saveState } = await import('../state/stateStore.js');
  const store = await import('../memory/store.js');
  store._resetStoreForTests();
  await saveState({ projects: [{ id: 'P', name: 'P' }], chats: [], settings: {} });
  const url = new URL('http://localhost/api/projects/memory-book');
  const call = async body => { const res = response(); let error = null; try { await handleDomainRoutes(request(body), res, url, () => true); } catch (e) { error = e; } return { res, error }; };
  const missing = await call({ projectId: 'missing', text: '目标' });
  assert.ok(missing.error, 'rejected with an error for the dispatcher to report');
  assert.match(String(missing.error?.message), /项目不存在/);
  const badSection = await call({ projectId: 'P', text: '目标', section: 'nope' });
  assert.match(String(badSection.error?.message), /分节无效/);
  const ok = await call({ projectId: 'P', text: '目标：发布 1.0', section: 'goal' });
  assert.equal(ok.error, null); assert.equal(ok.res.statusCode, 200);
  const payload = JSON.parse(ok.res.body);
  assert.equal(payload.section, 'goal'); assert.equal(payload.bookStatus, 'user');
  const { listProjectBook } = await import('../services/project/projectMemoryBook.js');
  assert.deepEqual(listProjectBook('P').map(r => r.text), ['目标：发布 1.0']);
  store._resetStoreForTests();
});
