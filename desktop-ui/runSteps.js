// What the running reply is doing right now, shown inside the chat (the side
// panel keeps the full record). Same rules as RunProgress.steps on the phone:
// only real scene steps, running ones always kept, finished ones trimmed.
// Hand-maintained: the browser only sees scene operations (tool id + args),
// never the tool object, so the self-description fields in src/tools/tool.js
// (capability / needsWorkspace / uiModule / inputKeys / concurrency) cannot
// drive these labels. Add a label here when registering a tool the user sees.
const TOOL_NAMES = {
  file_read: '读取文件', file_write: '写入文件', file_edit: '修改文件', file_delete: '删除文件', file_move: '移动文件', file_mkdir: '新建文件夹',
  bash: '运行命令', glob: '查找文件', grep: '搜索代码', web_search: '联网搜索', native_web_search: '联网搜索', fetch_url: '读取网页',
  image: '生成图片', image_edit: '修改图片', delegate: '交给其他 Agent', search_history: '查找聊天记录',
};
const oneLine = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 90);

export function stepState(status) {
  if (['completed', 'done', 'succeeded'].includes(status)) return 'done';
  if (['failed', 'cancelled', 'error', 'interrupted'].includes(status)) return 'failed';
  return 'running';
}

export function sceneSteps(scene, limit = 6) {
  if (!scene) return [];
  const steps = [];
  for (const stage of scene.pipeline || []) {
    const detail = stage.channel === 'reasoning-summary' ? oneLine(String(stage.output || '').split('\n').filter(Boolean).at(-1)) : oneLine(stage.output || stage.input);
    steps.push({ id: `stage:${stage.id}`, title: stage.name || stage.id, detail, state: stepState(stage.status), at: stage.startedAt || '' });
  }
  for (const op of scene.operations || []) {
    const detail = oneLine(op.change?.path || op.command || op.query || op.input || op.resultSummary);
    steps.push({ id: `op:${op.id}`, title: TOOL_NAMES[op.name] || op.name || '工具', detail, state: stepState(op.status), at: op.startedAt || '' });
  }
  const ordered = steps.every(step => step.at) ? [...steps].sort((a, b) => a.at.localeCompare(b.at)) : steps;
  if (ordered.length <= limit) return ordered;
  const running = new Set(ordered.filter(step => step.state === 'running').map(step => step.id));
  const finished = new Set(ordered.filter(step => step.state !== 'running').slice(-Math.max(0, limit - running.size)).map(step => step.id));
  return ordered.filter(step => running.has(step.id) || finished.has(step.id));
}

export function renderRunSteps(steps, escapeHtml, translate = text => text) {
  if (!steps.length) return '';
  const icon = { running: '<span class="run-step-spinner" aria-hidden="true"></span>', done: '✓', failed: '✕' };
  return `<ol class="run-steps" aria-label="${escapeHtml(translate('正在进行的步骤'))}">${steps.map(step => `<li class="run-step is-${step.state}"><span class="run-step-icon">${icon[step.state]}</span><span class="run-step-title">${escapeHtml(translate(step.title))}</span>${step.detail ? `<span class="run-step-detail">${escapeHtml(step.detail)}</span>` : ''}</li>`).join('')}</ol>`;
}
