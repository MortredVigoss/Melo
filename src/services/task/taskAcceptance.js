import { summarizeUsage } from '../../runtime/usage.js';
// Evidence is produced from tool receipts, never inferred from confident prose.
export function buildTaskAcceptance(message = {}) {
  const tools = message.toolResults || [];
  const files = tools.filter(t => /file_(write|edit|move|delete)/.test(t.toolName));
  const commands = tools.filter(t => t.toolName === 'bash');
  const sources = tools.filter(t => /^(?:web_search|fetch_url)$/.test(t.toolName));
  const criteria = [{ id: 'result', label: '已核对交付内容符合任务要求', checked: false }];
  if (files.length) criteria.push({ id: 'files', label: '已检查文件改动与备份，可恢复范围符合预期', checked: false });
  if (commands.length) criteria.push({ id: 'commands', label: '已核对命令退出码与测试输出', checked: false });
  if (sources.length) criteria.push({ id: 'sources', label: '已核对来源、引用与尚未确认的结论', checked: false });
  return { criteria, team:message.metadata?.team || null, usage:message.metadata?.usage || summarizeUsage(message.metadata?.modelResponses || []), tools: tools.map(t => ({ ...t })), failures: tools.filter(t => t.ok === false).map(t => ({ name:t.toolName, error:t.errorCode || 'TOOL_FAILED' })), reviewedAt: null };
}
export function assertTaskAcceptable(task) {
  if (task.execution?.status !== 'review' || task.acceptance?.failures?.length) throw new Error('任务尚未通过执行检查，请先修复失败项。');
  if (!task.acceptance?.criteria?.length || task.acceptance.criteria.some(c => !c.checked)) throw new Error('请逐项核对验收清单。');
}
