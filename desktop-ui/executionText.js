// What the desktop calls the things a run recorded (agent audit 2026-11-10).
// The chat's live steps, the tool pills, the task space and the execution
// detail each printed what the record holds: tool ids (`fetch_url`,
// `[agent:d1] web_search`, `load_tools`, `mcp:server:tool`), the English
// fallback of a stage's name, the reason code a stop or delivery stage was
// written with (`REPEATED_TOOL_FAILURE`, `LIMIT_DELIVERED`), "failed" for a
// call that was never allowed to run, and "interrupted" for a member that
// handed back on its own. One table each, shown in the interface language.
// Hand-maintained: the browser sees scene records (ids and codes), never the
// tool objects or the core's reason tables. executionText.test.js keeps every
// label in the catalog.
import { t, runtimeStageName, runtimeStageOutput } from './i18n.js';

// ── Tools ───────────────────────────────────────────────────────────────
export const TOOL_NAMES = Object.freeze({
  file_read: '读取文件', file_write: '写入文件', file_edit: '修改文件', file_delete: '删除文件', file_move: '移动文件', file_mkdir: '新建文件夹',
  bash: '运行命令', glob: '查找文件', grep: '搜索代码', web_search: '联网搜索', native_web_search: '联网搜索', fetch_url: '读取网页', web_screenshot: '网页截图',
  image: '生成图片', image_edit: '修改图片', native_image_generation: '生成图片', delegate: '交给其他 Agent', search_history: '查找对话记录', read_history: '读取对话原文', calculator: '计算',
  load_tools: '加载工具说明', route_task: '分派给成员', task_progress: '更新任务进度', knowledge: '知识库', translate: '翻译', clipboard: '剪贴板', reminder: '提醒',
  device_location: '本机定位', pdf: 'PDF 文档', xlsx: '表格文件', media_info: '读取媒体信息', media_api: '媒体服务',
  browser_open: '打开网页', browser_snapshot: '读取页面内容', browser_click: '点击页面', browser_fill: '填写页面', browser_wait_for: '等待页面', browser_close: '关闭页面',
});
// A member's or a skill's call arrives as `[agent:d1] web_search` / `[skill:id] file_read`.
const SCOPED = /^\[(agent|skill):[^\]]{1,80}\]\s*(.+)$/;
const MCP = /^mcp(?::|__)([A-Za-z0-9_-]+?)(?::|__)(.+)$/;
export const isToolId = name => typeof name === 'string' && (Object.hasOwn(TOOL_NAMES, name) || SCOPED.test(name) || MCP.test(name) || name.startsWith('skill:'));
export function toolName(raw) {
  const name = String(raw ?? '').trim();
  const scoped = SCOPED.exec(name);
  if (scoped) return t(scoped[1] === 'agent' ? '成员 · {tool}' : '技能 · {tool}', { tool: toolName(scoped[2]) });
  if (Object.hasOwn(TOOL_NAMES, name)) return t(TOOL_NAMES[name]);
  const mcp = MCP.exec(name);
  if (mcp) return `${mcp[2]} · ${mcp[1]}`;
  if (name.startsWith('skill:')) return t('技能 · {tool}', { tool: name.slice(6) });
  return name || t('工具');
}

// ── Stages ──────────────────────────────────────────────────────────────
// Reason codes the host writes as the output of its stop, limit-delivery and
// delivery-check stages.
export const RUN_REASONS = Object.freeze({
  LIMIT_DELIVERED: '已按上限整理并交付', ANSWER_DELIVERED: '回答已送达', NO_FINAL_ANSWER: '没有给出最终回答',
  ROUND_LIMIT: '已达轮数上限', BUDGET_EXHAUSTED: '运行预算已用完', DEADLINE_EXCEEDED: '已到时间上限', TASK_EVALUATION_LIMIT: '任务评估次数已用完',
  REPEATED_TOOL_FAILURE: '工具连续几轮失败', REPEATED_DEVICE_FAILURE: '设备操作连续失败', NO_PROGRESS: '连续几轮没有新进展', REPEATED_TASK: '重复分派了同一项任务',
  PENDING_EFFECT: '上一步操作的结果还没有确认', CANCELLED: '已取消', ABORTED: '已取消', REQUEST_FAILED: '模型请求失败',
  GOAL_CHECK_LIMIT: '核对次数已用完', GOAL_CHECK_CONTEXT: '核对内容超出了模型上下文', GOAL_CHECK_BUDGET: '预算不够，没有核对', GOAL_CHECK_TRUNCATED: '核对结果被截断',
  GOAL_CHECK_UNAVAILABLE: '核验没有返回结果', GOAL_CHECK_INVALID: '核验结果无效', GOAL_EVIDENCE_INVALID: '核验引用了无效证据', GOAL_UNAVAILABLE: '核验未能完成',
  GOAL_COVERAGE_MISSING: '有要求缺少证据', GOAL_INCOMPLETE: '还有要求没完成', GOAL_CORRECTION_LIMIT: '补证次数已用完', GOAL_NO_NEXT_STEP: '没有可做的下一步',
  GOAL_NEEDS_USER: '需要你提供信息', GOAL_DELIVERY_SUPPORTED: '每项要求都有证据', SELF_CONTAINED_ANSWER: '不需要外部证据的回答',
});
export const reasonText = code => Object.hasOwn(RUN_REASONS, code) ? t(RUN_REASONS[code]) : '';
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const LIMIT_DELIVERY = /(^|:)limit:delivery$/;
const REASON_STAGES = /(^|:)(core:stop|limit:delivery|goal-check:\d+)$/;

// A stage or a call by its name in the interface language. The stage written
// when a run is wrapped up at its limit carries the delivery check's name.
export function stageName(item) {
  if (LIMIT_DELIVERY.test(String(item?.id || ''))) return `${item.actorName ? `${item.actorName} · ` : ''}${t('整理已确认的内容')}`;
  if (!item?.messageId && isToolId(item?.name)) return toolName(item.name);
  return runtimeStageName(item);
}
export function stageOutput(item) {
  const output = runtimeStageOutput(item);
  return CODE.test(output) && REASON_STAGES.test(String(item?.id || '')) ? reasonText(output) || output : output;
}

// ── Calls that did not run ──────────────────────────────────────────────
// A refused, expired or skipped call is not a failed tool.
export const CALL_OUTCOMES = Object.freeze({
  PERMISSION_DENIED: '未获许可，没有执行', PERMISSION_NO_SURFACE: '无法询问许可，没有执行', CAPABILITY_DENIED: '能力没有开启，没有执行',
  TOOL_NOT_LOADED: '工具说明还没加载，没有执行', UNKNOWN_TOOL: '没有这个工具', INVALID_ARGS: '参数无效，没有执行', INVALID_TOOL_ARGUMENTS: '参数无效，没有执行',
  ALREADY_EXECUTED: '已经执行过，没有重复', ROUTE_DENIED: '这次不能分派', DELEGATION_DENIED: '不允许委派',
  BUDGET_EXHAUSTED: '运行预算已用完', TOOL_TIMEOUT: '执行超时',
});
export function callOutcome(call) {
  const code = String(call?.errorCode || call?.code || '');
  if (!Object.hasOwn(CALL_OUTCOMES, code) || ['completed', 'done', 'succeeded', 'ok', 'running', 'queued', 'waiting'].includes(call?.status)) return '';
  return t(CALL_OUTCOMES[code]);
}
export const callStatus = (call, fallback = '') => callOutcome(call) || fallback;

// ── Members ─────────────────────────────────────────────────────────────
// What a member's hand-off recorded. Only a member that was cut off is "interrupted".
export const MEMBER_HANDOFFS = Object.freeze({ observed: '已交回', unverified: '已交回 · 没有核实到内容', partial: '没做完 · 已交回' });
export function memberState(member, fallback = '') {
  if (member?.running) return t('进行中');
  return Object.hasOwn(MEMBER_HANDOFFS, member?.handoff) ? t(MEMBER_HANDOFFS[member.handoff]) : fallback;
}
