export const developmentStatus = {
  preparing: '准备中', created: '待开始', implementing: '实施中', testing: '验证中', reviewing: '审查中', awaiting_review: '待人工核对', awaiting_merge: '待合并', blocked: '受阻', cancelled: '已停止', interrupted: '已中断',
};
export function developmentCheckpoint(job) {
  return {
    id: job.id, title: `开发作业 · ${job.goal}`.slice(0, 500),
    status: ['implementing', 'testing', 'reviewing'].includes(job.status) ? 'running' : ['awaiting_merge', 'awaiting_review'].includes(job.status) ? 'review' : job.status === 'created' ? 'todo' : 'blocked',
    owner: job.agentId, revision: job.revision, sourceDevice: 'desktop', updatedAt: job.updatedAt, chatId: null, needsApproval: ['awaiting_review', 'awaiting_merge'].includes(job.status),
    checkpoint: [
      `开发作业：${job.id}`, `阶段：${developmentStatus[job.status] || job.status}`,
      `基线：${job.baseSha}`, `候选：${job.headSha || '尚未生成'}`,
      `隔离：Linux 容器 / 断网 / 独立文件与数据`,
      `验证：${job.tests?.filter(test => test.status === 'passed').length || 0}/${job.commands.length}`,
      ...(job.tests || []).map(test => `${test.argv.join(' ')} → ${test.status} (${test.exitCode ?? '?'})`),
      `审查：${job.review?.verdict || '尚未完成'}`, job.review?.summary || '', job.error || '',
      '尚未合并、推送或安装；原生 Mac/iPhone 验收未执行。手机显示最近同步状态，权限与合并在执行设备处理。',
    ].filter(Boolean).join('\n').slice(0, 12000),
  };
}
export function withDevelopmentCheckpoints(tasks, checkpoints) {
  // The desktop's persisted controller state is authoritative. Sync cannot
  // invent, approve or overwrite a local development job with a newer clock.
  return [...(tasks || []).filter(task => !task.id.startsWith('dev_')), ...checkpoints];
}
