import { createDevelopmentService } from './service.js';
import { createDevelopmentAgents, authorizeDevelopmentProfiles } from './agent.js';
import { loadState } from '../state/stateStore.js';
import { effectiveAgentProfile } from '../state/agentProfiles.js';
import { getResolvedConfig } from '../config.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';

const runtimes = new Map();
export function developmentRuntime(home, env) {
  if (!runtimes.has(home)) {
    const captured = { ...env };
    const service = createDevelopmentService({ home, env: captured, ...createDevelopmentAgents() });
    service.prepare = async (job, parentScope) => {
      const request = createRequestContext({ home, env: captured });
      return runWithRequestContext(request, async () => {
        const state = await loadState({ home });
        const profiles = Object.fromEntries(Object.keys(state.agentProfiles).map(id => [id, effectiveAgentProfile(state, id)]));
        const { builder, reviewer } = authorizeDevelopmentProfiles(profiles, job, parentScope);
        const config = await getResolvedConfig();
        return { home, env: captured, config, builder, reviewer, authorize: async candidate => authorizeDevelopmentProfiles(profiles, candidate, parentScope) };
      });
    };
    runtimes.set(home, service);
  }
  return runtimes.get(home);
}
export async function stopDevelopmentJobs() {
  await Promise.allSettled([...runtimes.values()].map(service => service.shutdown()));
}
