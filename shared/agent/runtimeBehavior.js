// Saved preferences and environment overrides share one typed registry.
export const RUNTIME_BEHAVIOR = Object.freeze([
  { key:'browserControl', env:'MELO_CDP_ENABLED', default:false, label:'浏览器操作工具' },
  { key:'toolChainHistory', env:'MELO_TOOL_CHAIN_HISTORY', default:false, label:'保留工具调用历史' },
  { key:'turnContextInSystem', env:'MELO_TURN_CONTEXT_IN_SYSTEM', default:false, label:'将本轮上下文放入系统提示' },
  { key:'offlineMemory', env:'MELO_OFFLINE_ONLY', default:false, label:'记忆处理仅使用本机服务' },
  { key:'mediaExtraction', env:'MELO_DISABLE_MEDIA', default:true, inverted:true, label:'提取附件内容' },
  { key:'externalWebReaders', env:'MELO_DISABLE_EXTERNAL_WEB_READERS', default:true, inverted:true, label:'允许外部网页读取服务' },
  { key:'toolTrace', env:'MELO_TOOL_TRACE_ALWAYS', default:false, label:'显示成功工具记录' },
]);
export function booleanSetting(value) {
  if (value === true || value === 1 || /^(?:1|true)$/i.test(String(value))) return true;
  if (value === false || value === 0 || /^(?:0|false)$/i.test(String(value))) return false;
  return null;
}
export function normalizeBehavior(input = {}, legacy = {}) {
  return Object.fromEntries(RUNTIME_BEHAVIOR.map(item => [item.key,
    typeof input?.[item.key] === 'boolean' ? input[item.key]
      : item.key === 'toolChainHistory' && legacy.toolChainHistory === true ? true : item.default]));
}
export function resolveBehavior(config = {}, env = {}) {
  const saved = normalizeBehavior(config.behavior, config);
  return Object.fromEntries(RUNTIME_BEHAVIOR.map(item => {
    const override = booleanSetting(env[item.env]);
    return [item.key, { saved: saved[item.key], value: override === null ? saved[item.key] : item.inverted ? !override : override,
      source: override === null ? 'config' : 'environment', variable: item.env }];
  }));
}
export function behaviorEnvironment(config = {}, env = {}) {
  const resolved = resolveBehavior(config, env);
  return Object.assign({}, env, Object.fromEntries(RUNTIME_BEHAVIOR.map(item =>
    [item.env, (item.inverted ? !resolved[item.key].value : resolved[item.key].value) ? '1' : '0'])));
}

export function toolCallingOverride(env = {}) {
  const raw = env.MELO_FUNCTION_CALLING;
  if (['auto','native','legacy'].includes(raw)) return raw;
  const value = booleanSetting(raw);
  if (value !== null) return value ? 'native' : 'legacy';
  return '';
}
