import {projectWorkspaceStatus,workspaceError} from '../workspace/workspacePolicy.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { currentRequestContext, runWithRequestContext } from '../../runtime/requestScope.js';
// New projects receive independent workspace folders under the captured Melo home.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { nowIso } from '../../shared/helpers.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { findProjectById } from '../../state/stateLookups.js';
import { getDesktopBootstrap } from '../desktop/bootstrap.js';
import { validateConversationSelection } from '../chat/conversationSelection.js';
// `normalizeProject` here is the 1-arg wrapper from stateHydration.js
// (which binds sanitizeWorkspacePath / fallbackWorkspaceRoot /
// defaultProjectTime to the 2-arg version in projectService.js). Same
// import path desktopStore.js uses.
import { normalizeProject } from '../../state/stateHydration.js';
import { validateTeamPlan } from '../../agents/team.js';
import { allAgentIdsFromProfiles } from '../../domain/agent/agentLibrary.js';

export async function createProject({ name, summary, instructions, tag, workspacePath }) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => createProject(...arguments));
  const id = randomUUID();
  const projectPath = workspacePath?.trim() || join(currentRequestContext().home, 'workspaces', id);
  if (!workspacePath?.trim()) await mkdir(projectPath, { recursive:true, mode:0o700 });
  await updateStateAtomically(state => {
    const timestamp = nowIso();
    const project = normalizeProject({
      id,
      name: name?.trim() || '新项目',
      summary: summary?.trim() || '',
      instructions:
        instructions?.trim() ||
        '',
      tag: tag?.trim() || '项目',
      workspacePath: projectPath,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    state.projects.unshift(project);
    state.settings.selectedProjectId = project.id;
    state.settings.activeView = 'projects';
    state.settings.selectedFilePath = null;
    return state;
  });
  return getDesktopBootstrap();
}

export async function updateProject(projectId, patch) {
  if (!currentRequestContext()) return runWithRequestContext(createRequestContext(), () => updateProject(...arguments));
  await updateStateAtomically(async state => {
    const project = findProjectById(state, projectId);
    if (!project) {
      throw new Error('Project not found.');
    }
    if (Object.hasOwn(patch, 'knowledgeIds')) {
      validateConversationSelection({contextArtifactIds:patch.knowledgeIds}, state, {});
    }

    const safePatch={...patch};
    delete safePatch.workspaceConfirmation;delete safePatch.confirmWorkspace;
    const agentIds=allAgentIdsFromProfiles(state.agentProfiles);
    if (Object.hasOwn(patch,'defaultAgentId') && patch.defaultAgentId && !agentIds.includes(patch.defaultAgentId)) throw new Error('默认 Agent 不存在。');
    if (Object.hasOwn(patch,'teamPlan') && patch.teamPlan) {
      const plan=validateTeamPlan(patch.teamPlan);
      const missing=plan.members.filter(id=>!agentIds.includes(id));
      if (missing.length) throw new Error(`团队成员 Agent 不存在：${missing.join('、')}`);
      safePatch.teamPlan={templateId:plan.templateId||'research-build-review',members:plan.members};
    }
    if (patch.confirmWorkspace===true) {
      const candidate=normalizeProject({...project,...safePatch});
      const status=await projectWorkspaceStatus(candidate);
      if (!status.exists) throw workspaceError('WORKSPACE_UNAVAILABLE','请先选择存在的项目目录。');
      safePatch.workspaceConfirmation=status.identity;
    }
    Object.assign(project, normalizeProject({
      ...project,
      ...safePatch,
      id: project.id,
      createdAt: project.createdAt,
      updatedAt: nowIso(),
    }));

    return state;
  });
  return getDesktopBootstrap();
}
