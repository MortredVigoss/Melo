// v1-compatible remove-wins markers. No paths, permissions or executable text.
import { createHash } from 'node:crypto';
const safeId = id => typeof id === 'string' && !['__proto__', 'prototype', 'constructor'].includes(id) && /^[A-Za-z0-9_-]{1,180}$(?![\s\S])/.test(id);
export const projectDeletionId = id => `pld_${createHash('sha256').update(id).digest('hex')}`;
export function projectDeletionValue({ projectId, operationId, deletedAt }) {
  if (!safeId(projectId) || !safeId(operationId) || !Number.isFinite(Date.parse(deletedAt))) throw new Error('Invalid project deletion marker.');
  return {
    title: 'Deleted project', kind: 'project-lifecycle-v1', language: 'json', projectId: null, deleted: true,
    content: JSON.stringify({ version: 1, projectId, operationId, deletedAt }),
  };
}
export function projectDeletionMarkers(workspace) {
  const markers = new Map();
  for (const row of workspace?.records || []) {
    if (row.kind !== 'knowledge' || !row.id.startsWith('pld_')) continue;
    for (const version of row.versions || []) {
      const value = version.value;
      if (value?.kind !== 'project-lifecycle-v1' || value.deleted !== true || value.projectId != null || typeof value.content !== 'string' || value.content.length > 2000) throw new Error('Invalid immutable project deletion marker.');
      let marker;
      try { marker = JSON.parse(value.content); } catch { throw new Error('Invalid project deletion marker JSON.'); }
      if (marker?.version !== 1 || Object.keys(marker).some(key => !['version', 'projectId', 'operationId', 'deletedAt'].includes(key))) throw new Error('Invalid project deletion version.');
      projectDeletionValue(marker);
      if (row.id !== projectDeletionId(marker.projectId)) throw new Error('Project deletion identity mismatch.');
      const old = markers.get(marker.projectId);
      if (!old || marker.deletedAt < old.deletedAt) markers.set(marker.projectId, marker);
    }
  }
  return markers;
}
export function projectLifecycleWorkspace(workspace) {
  if (!workspace) return workspace;
  const removed = projectDeletionMarkers(workspace);
  if (!removed.size) return workspace;
  return { ...workspace, records: workspace.records.filter(row => row.kind !== 'project' || !removed.has(row.id)).map(row => {
    if (!['conversation', 'knowledge', 'memory'].includes(row.kind)) return row;
    return { ...row, versions: row.versions.map(version => {
      const value = version.value;
      if (!removed.has(value.projectId)) return version;
      if (row.kind === 'memory') return { ...version, value: { ...value, status: value.scope === 'project' && value.status === 'active' ? 'historical' : value.status } };
      return { ...version, value: { ...value, projectId: null } };
    }) };
  }) };
}
