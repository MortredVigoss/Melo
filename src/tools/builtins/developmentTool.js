import { currentRequestContext } from '../../runtime/requestScope.js';
import { developmentRuntime } from '../../development/runtime.js';

export const developmentTool = {
  id: 'development_job', name: 'Development job', category: 'development', capability: ['readFiles', 'writeFiles', 'runCommands'], requiresPermission: true, needsWorkspace: false, concurrency: false,
  description: 'Inspect, start or stop a development job created by the user in the desktop task panel. Jobs use an isolated container and fixed verification policy; they never automatically merge, push or install. Cannot create or approve a job through this tool.',
  parametersSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'status', 'start', 'stop'] }, id: { type: 'string' } }, required: ['action'] },
  async run({ action, id }) {
    const context = currentRequestContext();
    if (!context?.capabilityScope || !context.home) throw new Error('Development capability scope missing');
    const service = developmentRuntime(context.home, context.env);
    let result;
    if (action === 'list') result = (await service.list()).filter(job => job.agentId === context.capabilityScope.agentId).map(({ id, goal, status }) => ({ id, goal, status }));
    else {
      const job = await service.read(id);
      if (job.agentId !== context.capabilityScope.agentId) throw new Error('This job belongs to another Agent');
      if (action === 'status') result = await service.details(id);
      else if (action === 'start') result = await service.start(id, await service.prepare(job, context.capabilityScope));
      else if (action === 'stop') result = await service.stop(id);
      else throw new Error('Invalid development action');
    }
    return { ok: true, output: JSON.stringify(result) };
  },
};
