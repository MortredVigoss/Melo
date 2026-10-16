import {realpath,stat} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {PROJECT_DIR} from '../../runtime/paths.js';

export const workspaceError=(code,message)=>Object.assign(new Error(message),{code,statusCode:409});
export async function projectWorkspaceStatus(project) {
  const path=project?.workspacePath;
  if (!path || !isAbsolute(path)) return {rootPath:null,missing:true};
  const canonical=await realpath(path).catch(()=>resolve(path));
  const app=await realpath(PROJECT_DIR).catch(()=>PROJECT_DIR);
  const info=await stat(path).catch(()=>null);
  const identity={path:canonical,device:String(info?.dev ?? ''),inode:String(info?.ino ?? '')};
  const confirmed=project.workspaceConfirmation;
  const requiresConfirmation=canonical===app && (!info || !confirmed || Object.keys(identity).some(k=>confirmed[k]!==identity[k]));
  return {rootPath:requiresConfirmation?null:path,requiresConfirmation,identity,exists:!!info?.isDirectory()};
}
export async function requireProjectWorkspace(project) {
  if (!project || project.deletedAt || project.deleted) throw workspaceError('WORKSPACE_UNAVAILABLE','项目工作目录不可用，请重新选择。');
  const status=await projectWorkspaceStatus(project);
  if (status.requiresConfirmation) throw workspaceError('WORKSPACE_CONFIRMATION_REQUIRED','此旧项目指向 Melo 程序目录。请在项目设置确认或重新选择工作目录，然后重新发起操作。');
  if (!status.rootPath) throw workspaceError('WORKSPACE_REQUIRED','请先为项目选择工作目录。');
  return status.rootPath;
}
export function requireWorkspacePath(path) {
  if (!path || typeof path!=='string' || !isAbsolute(path)) throw workspaceError('WORKSPACE_REQUIRED','此操作需要明确的工作目录。');
  return path;
}
