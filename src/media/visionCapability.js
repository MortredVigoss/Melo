import { resolvedModelCapabilities } from '../../shared/agent/modelCapabilities.js';
// Kept as a compatibility API: unknown models are no longer guessed from their name.
export function modelSupportsVision(modelName = '', tested = null, connection = {}) {
  return resolvedModelCapabilities({ ...connection, visionTest: tested || connection.visionTest }, modelName).vision;
}
