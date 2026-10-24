import { runtimeMessage } from '../../shared/agent/runtimeMessages.js';
import { currentRequestContext } from '../runtime/requestScope.js';
import {isAbsolute} from 'node:path';

export function missingWorkspaceResult(path, locale = currentRequestContext()?.config?.replyLanguage || 'zh') {
  if (typeof path === 'string' && isAbsolute(path)) return null;
  return {ok:false, error:'WORKSPACE_REQUIRED', output:runtimeMessage('workspaceRequired', locale), meta:{executionStarted:false}};
}
