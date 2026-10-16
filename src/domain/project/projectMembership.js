export function creationProjectId(state,{projectId,chatId,operation='create'}) {
  if (projectId!==undefined && projectId!==null) requireProject(state,projectId);
  if (projectId===undefined) console.warn(`[project] ${operation}: projectId omitted; using explicit chat membership or no project.`);
  if (chatId!=null) {
    const chat=state.chats.find(c=>c.id===chatId);
    if (!chat) throw new Error('Chat not found.');
    projectId=chat.projectId || null;
  }
  if (projectId!=null) requireProject(state,projectId);
  return projectId || null;
}
function requireProject(state,id) {
  const project=state.projects.find(p=>p.id===id && !p.deletedAt && !p.deleted);
  if (!project) throw new Error('项目不存在或已删除。');
  if (project.archived) throw new Error('请先恢复此项目，再创建新的项目内容。');
  return project;
}
