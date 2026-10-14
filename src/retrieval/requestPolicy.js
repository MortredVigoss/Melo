import { extractTextUrls } from '../media/textUrls.js';

// Mask quoted data without changing offsets used to extract command arguments.
export function maskQuotedText(value = '') {
  return String(value).replace(/```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」/gu, match => ' '.repeat(match.length));
}

const NEGATED_ACTION = /(?:不要|不用|不必|无需|禁止|别|不需要)[^。！？;；\n]{0,20}(?:搜|查找|检索|运行|执行|调用|构建|联网|上网|打开|访问)|\b(?:do not|don['’]t|never|without|no need to)\s+(?:\w+\s+){0,3}(?:search|find|grep|run|execute|call|build|browse|fetch|open|access)\b/iu;
const SEARCH_DENIAL = /(?:不要|不用|不必|无需|禁止|别|不需要)[^。！？;；\n]{0,20}(?:搜|查找|检索)|\b(?:do not|don['’]t|never|without|no need to)\s+(?:\w+\s+){0,3}(?:search|find|google|look up)\b/iu;
const NETWORK_DENIAL = /(?:不要|不用|不必|无需|禁止|别|不需要)\s*(?:再|去|调用)?\s*(?:联网|上网|浏览网页|访问网络|打开(?:链接|网址|网页)?|访问|读取(?:链接|网址|网页))|\b(?:do not|don['’]t|never|without)\s+(?:browse|go online|access|fetch|open|read)\b/iu;
const CONTEXT_ONLY = /(?:仅|只)(?:凭|根据|依据|基于|使用).{0,16}(?:对话|上下文|基础知识|已给出的文字|提供的文本|提供的正文)|\b(?:only (?:use|using)|based only on)\s+(?:(?:this|our)\s+(?:chat|conversation|text)|the (?:provided|supplied)\s+(?:text|transcript))\b/iu;
const LOCAL_SEARCH = /^(?:(?:please|can you|could you)\s+)?(?:rg|grep|ripgrep)\b|\b(?:search|find)\s+(?:the |this )?(?:workspace|repo(?:sitory)?|codebase|local files)\b|\b(?:search|find)\b[^\n]*\b(?:in|within)\s+(?:the |this )?(?:workspace|repo(?:sitory)?|codebase)\b|(?:在|从|对)(?:当前|这个|本地)?(?:工作区|仓库|项目|代码库|本地文件)[^。！？\n]{0,16}(?:搜|查找|检索)|(?:搜索|查找|检索)(?:当前|这个|本地)?(?:工作区|仓库|代码库)/iu;

export function hasNegatedAction(text = '') {
  return NEGATED_ACTION.test(maskQuotedText(text));
}

export function isExplicitLocalSearch(text = '') {
  const instruction = maskQuotedText(text);
  return !NEGATED_ACTION.test(instruction) && LOCAL_SEARCH.test(instruction);
}

export function getRequestNetworkPolicy(text = '') {
  const instruction = maskQuotedText(text);
  const contextOnly = CONTEXT_ONLY.test(instruction);
  const fetchForbidden = NETWORK_DENIAL.test(instruction) || contextOnly;
  return {
    instruction,
    contextOnly,
    fetchForbidden,
    searchForbidden: fetchForbidden || SEARCH_DENIAL.test(instruction),
    localSearch: isExplicitLocalSearch(text),
  };
}

// A quoted URL is data unless the surrounding instruction asks to use it.
// Bare links keep the existing paste-to-read behavior.
export function requestUrls(text = '') {
  const policy = getRequestNetworkPolicy(text);
  if (policy.fetchForbidden) return [];
  const explicitRead = /(?:^|[，。；！？\n]\s*)(?:请帮我|帮我|麻烦|请)?\s*(?:打开|访问|读取|浏览)|(?:打开|访问|读取|读一下|总结|概括|浏览|解析|提取|查看|分析)(?:.{0,16})(?:链接|网址|网页|页面|文章)|(?:打开|访问|读取|总结|浏览)[\s，。！？.!?]*$|(?:^|[.!?;\n]\s*)(?:(?:please|can you|could you)\s+)*(?:open|visit|read|fetch|summari[sz]e|browse|extract|analy[sz]e)\b/iu.test(policy.instruction.trim());
  if (isTranslationRequest(text) && !explicitRead) return [];
  return extractTextUrls(explicitRead ? text : policy.instruction);
}

export function isExplicitActionRequest(text = '') {
  const instruction = maskQuotedText(text).trim();
  if (NEGATED_ACTION.test(instruction)) return false;
  return /^(?:(?:please|can you|could you|would you)\s+)*(?:run|execute|show|list|invoke|call|use|search|find|rg|grep|ripgrep)\b|^(?:请|麻烦|帮我|请帮我)?\s*(?:运行|执行|查看|列出|显示|调用|使用|在|从|搜索|查找|检索)|^(?:git status|npm run build|pwd|ls)\s*[.!。！]?$/iu.test(instruction);
}

export function isTranslationRequest(text = '') {
  const instruction = maskQuotedText(text);
  if (/函数|程序|编写|实现|\b(?:code|function|implement|app|api|service)\b/iu.test(instruction)) return false;
  return /(?:翻译|译成|\btranslat(?:e|ion)\b)/iu.test(instruction);
}

const EXTERNAL_TASK = /https?:\/\/|\b(?:file|pdf|docx|xlsx|csv|workspace|repo|browser|tool|save|send|email|post|publish|calendar|upload|download|execute|run|remind|schedule|image|video|audio)\b|文件|附件|图片|截图|视频|音频|语音|浏览器|工具|工作区|仓库|保存|发送|发给|发到|导出|邮件|日历|上传|下载|运行|执行|生成|提醒|定时/iu;
const FOLLOW_UP = /^(?:ok|okay|yes|sure|continue|go ahead|好|好的|是|对|继续|再说说)[\s!.?。！？]*$/iu;

export function requiresSkillToolContext(skills = [], text = '') {
  const query = String(text).toLowerCase();
  return skills.some(skill => {
    // User-selected custom workflows remain authoritative. Built-ins are
    // available by default, not mandatory for every standalone calculation.
    if (skill.source !== 'built-in') return true;
    const needles = [skill.id, skill.name, ...(skill.triggers || [])];
    return needles.some(value => typeof value === 'string' && value.trim().length >= 2 && query.includes(value.trim().toLowerCase()));
  });
}

export function selectToolContextPolicy({ text = '', chat, searchPlan, hasExecutableSkills = false, highRisk = false } = {}) {
  const policy = getRequestNetworkPolicy(text);
  const full = { mode: 'full', reason: 'task-may-need-tools' };
  if (hasExecutableSkills || highRisk || searchPlan?.route !== 'none' || FOLLOW_UP.test(text.trim())) return full;
  const latestUser = (chat?.messages || []).findLast(message => message?.role === 'user');
  if (latestUser?.attachments?.length || EXTERNAL_TASK.test(policy.instruction) || /https?:\/\//iu.test(text)) return full;
  // Only high-confidence self-contained requests take the lean path. Unknown
  // tasks and short confirmations retain the normal tool/permission pipeline.
  const arithmetic = text.length <= 160 && /\d\s*(?:[+*×÷/−-]|乘以?|除以?|加|减)\s*-?\d/u.test(text) &&
    /^[\d\s.,，。?？!！:：=()+*×÷/−%\-乘以除加减等于多少请帮我计算结果只回答数字]+$/u.test(text);
  const translation = text.length <= 1400 && isTranslationRequest(text);
  const explicitQuestion = /[?？]|多少|是否|能否|能确定|能确认|是什么|\b(?:what|when|why|how|is|are|can)\b/iu.test(policy.instruction);
  if (arithmetic || translation || (policy.contextOnly && text.length <= 1800) || (policy.searchForbidden && explicitQuestion && text.length <= 600)) {
    return { mode: 'none', reason: arithmetic ? 'simple-arithmetic' : translation ? 'supplied-text-translation' : 'explicit-context-only' };
  }
  return full;
}
