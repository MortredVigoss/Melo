import { randomUUID } from 'node:crypto';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { committedRevision, diffRecords, recordSnapshot } from '../../state/commitReceipt.js';
import { deleteProjectState, restoreProjectState } from '../../domain/project/projectLifecycle.js';

export async function changeProjectLifecycle({ projectId, action, operationId } = {}) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => changeProjectLifecycle(...arguments));
  if (!['delete', 'restore'].includes(action) || typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,180}$(?![\s\S])/.test(operationId)) {
    throw Object.assign(new Error('项目操作需要有效的动作和操作 ID。'), { statusCode: 400 });
  }
  const timestamp = new Date().toISOString(), replacementId = randomUUID(), device = randomUUID();
  let before, resultId, operation;
  const committed = await updateStateAtomically(state => {
    before = recordSnapshot(state.projects);
    if (action === 'delete') {
      operation = deleteProjectState(state, { projectId, operationId, timestamp, device }); resultId = projectId;
    } else {
      resultId = restoreProjectState(state, { projectId, operationId, replacementId, timestamp }).id;
      operation = state.projects.find(row => row.id === projectId).lifecycle;
    }
    return state;
  });
  return { project: committed.projects.find(row => row.id === resultId), operation, revision: committedRevision(committed), ...diffRecords(before, committed.projects) };
}
