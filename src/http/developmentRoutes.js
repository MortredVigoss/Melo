import { createRouteRegistry } from './routeRegistry.js';
import { readJsonBody, sendJson } from './transport.js';
import { developmentRuntime } from '../development/runtime.js';

export function createDevelopmentRoutes({ home, env, service = developmentRuntime(home, env) }) {
  // Begin reconciliation when the server composes its routes, not only when a
  // user happens to open the development panel. Other app routes stay usable.
  const recovery = service.initialize?.() || Promise.resolve();
  recovery.catch(() => {});
  const action = handler => async ({ request, response, url }) => {
    // Remote sync tokens never authorize development or candidate approval.
    if (request.headers.authorization) { sendJson(response, 403, { error: 'Development actions require the local desktop' }); return; }
    try {
      await recovery;
      const input = request.method === 'POST' ? await readJsonBody(request, { maxBytes: 64000 }) : Object.fromEntries(url.searchParams);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid development request');
      sendJson(response, 200, await handler(input));
    } catch (error) { sendJson(response, error.statusCode || 409, { error: error.message }); }
  };
  return createRouteRegistry([
    { method: 'GET', path: '/api/development/jobs', auth: 'local-read', handler: action(async () => ({ jobs: await service.list() })) },
    { method: 'GET', path: '/api/development/job', auth: 'local-read', handler: action(({ id }) => service.details(id)) },
    { method: 'POST', path: '/api/development/create', auth: 'local-write', handler: action(async input => { await service.prepare(input); return service.create(input); }) },
    { method: 'POST', path: '/api/development/start', auth: 'local-write', handler: action(async ({ id }) => service.start(id, await service.prepare(await service.read(id)))) },
    { method: 'POST', path: '/api/development/stop', auth: 'local-write', handler: action(({ id }) => service.stop(id)) },
    { method: 'POST', path: '/api/development/recover', auth: 'local-write', handler: action(({ id }) => service.recover(id)) },
    { method: 'POST', path: '/api/development/approve', auth: 'local-write', handler: action(({ id, headSha }) => service.approve(id, headSha)) },
    { method: 'POST', path: '/api/development/export', auth: 'local-write', handler: action(({ id }) => service.exportCandidate(id)) },
  ]);
}
