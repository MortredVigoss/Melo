import {isAbsolute} from 'node:path';

export function missingWorkspaceResult(path) {
  if (typeof path === 'string' && isAbsolute(path)) return null;
  return {ok:false, error:'WORKSPACE_REQUIRED', output:'此操作需要明确的工作目录。', meta:{executionStarted:false}};
}
