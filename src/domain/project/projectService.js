// ─── Project service ─────────────────────────────────────────────────────────
// Pure shape + view-model helpers for the "projects" slice of state —
// workspaces that group chats and artifacts. The create/update/delete
// mutations stay in desktopStore until the Phase 10 state split; this
// module only owns canonicalization + UI decoration.
//
// This module owns:
//   - normalizeProject(raw, { sanitizeWorkspacePath, fallbackWorkspaceRoot,
//     defaultProjectTime }) — shape-coerce one project record. The three
//     named deps are passed in so the module does not depend on APP_ROOT
//     or the workspace-file module directly; callers wrap this with a
//     thin closure that binds their env.
//   - summarizeProject(project, chats, artifacts) — decorate with the
//     relational counts + a human `updatedLabel` built from the most
//     recent of project/chat/artifact timestamps. Pure view-model.
//
// Extracted from desktopStore.js in the Phase 9c refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — only imports shared
// helpers + node:crypto.

import { randomUUID } from 'node:crypto';
import { coerceIso, formatUpdatedAt } from '../../shared/helpers.js';

const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PROJECT_TEAM_TEMPLATES = new Set(['research-build-review', 'parallel-research', 'review-loop']);
// Shape only; membership and authorization are checked when saving and again when running.
export function normalizeProjectTeamPlan(plan) {
  if (!plan || typeof plan !== 'object' || !PROJECT_TEAM_TEMPLATES.has(plan.templateId)) return null;
  const members = Array.isArray(plan.members) ? [...new Set(plan.members.filter(id => typeof id === 'string' && AGENT_ID.test(id)))].slice(0, 8) : [];
  return members.length ? { templateId: plan.templateId, members } : null;
}

/**
 * Canonicalize a raw project record.
 *
 * @param {object} project — raw record (possibly partial, possibly legacy)
 * @param {object} deps
 * @param {(rawPath: string) => string} deps.sanitizeWorkspacePath —
 *   project workspace-path sanitizer, pre-bound to the caller's APP_ROOT.
 * @param {string} deps.fallbackWorkspaceRoot — root to fall back to when
 *   the incoming project has no workspacePath.
 * @param {string} deps.defaultProjectTime — ISO string used for missing
 *   createdAt/updatedAt fields. The desktopStore computes this as
 *   "one day ago" so new blobs sort below existing projects.
 */
export function normalizeProject(project, deps) {
  const { sanitizeWorkspacePath, defaultProjectTime } = deps;
  return {
    id: project?.id || randomUUID(),
    name: project?.name || 'Untitled project',
    archived: project?.archived === true,
    knowledgeIds: Array.isArray(project?.knowledgeIds) ? [...new Set(project.knowledgeIds.filter(id=>typeof id==='string'))] : [],
    summary: typeof project?.summary === 'string' ? project.summary : '',
    tag: project?.tag || 'Project',
    instructions:
      typeof project?.instructions === 'string' ? project.instructions :
      '',
    workspacePath: project?.workspacePath ? sanitizeWorkspacePath(project.workspacePath) : '',
    // Desktop-only defaults; not part of the sync payload.
    defaultAgentId: typeof project?.defaultAgentId === 'string' && AGENT_ID.test(project.defaultAgentId) ? project.defaultAgentId : '',
    teamPlan: normalizeProjectTeamPlan(project?.teamPlan),
    ...(project?.deleted === true ? {deleted:true} : {}),
    ...(project?.deletedAt ? {deletedAt:project.deletedAt} : {}),
    ...(project?.lifecycle && typeof project.lifecycle === 'object' ? { lifecycle: structuredClone(project.lifecycle) } : {}),
    ...(project?.workspaceConfirmation?.path ? {workspaceConfirmation:{...project.workspaceConfirmation}} : {}),
    createdAt: coerceIso(project?.createdAt, defaultProjectTime),
    updatedAt: coerceIso(project?.updatedAt, defaultProjectTime),
  };
}

/**
 * Decorate a project with relational counts + a human updatedLabel.
 * The updatedLabel prefers the most recent of project.updatedAt, the
 * newest related chat, and the newest related artifact so the UI list
 * reflects activity inside the project, not just name changes.
 */
export function summarizeProject(project, chats, artifacts) {
  const relatedChats = chats.filter(chat => chat.projectId === project.id);
  const relatedArtifacts = artifacts.filter(artifact => !artifact.deletedAt && (artifact.projectId === project.id || project.knowledgeIds?.includes(artifact.id)));
  const latestActivity = [
    project.updatedAt,
    relatedChats[0]?.updatedAt,
    relatedArtifacts[0]?.createdAt,
  ]
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || project.updatedAt;

  return {
    ...project,
    summary: projectText(project.summary),
    instructions: projectText(project.instructions),
    updatedLabel: formatUpdatedAt(latestActivity),
    chatCount: relatedChats.length,
    artifactCount: relatedArtifacts.length,
  };
}

const LEGACY_PROJECT_TEXT=new Set(['归拢相关对话、资料与目标。','A local Melo project.','Keep this project focused, actionable, and easy to continue later.']);
export const projectText=value=>typeof value==='string' && !LEGACY_PROJECT_TEXT.has(value)?value:'';
