// Host captures environment before invoking the portable budget policy.
import { resolveContextBudget as resolvePortableContextBudget } from '../../../shared/agent/contextBudget.js';
export { requiredPromptTokens, effectiveHistoryWindow, renderPromptSections, TURN_CONTEXT_HEADER, TURN_CONTEXT_USER_MARKER, attachTurnContext, attachTurnContextToMessages, fitRequestContext } from '../../../shared/agent/contextBudget.js';
export function resolveContextBudget(env = process.env, options = {}) { return resolvePortableContextBudget(env, options); }
