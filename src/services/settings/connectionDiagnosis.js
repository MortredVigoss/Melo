export function connectionDiagnosis(error) {
  const text = String(error?.message || error || '').toLowerCase();
  if (/simulat|模拟/.test(text)) return { code: 'simulated', guidance: '关闭模拟响应后重新测试；模拟输出不计入连通性验证。' };
  if (/quota|credit|balance|billing|insufficient|额度|余额/.test(text)) return { code: 'quota', guidance: '检查此 API 账号的额度与账单；消费端订阅不等于 API 额度。' };
  if (/401|403|unauthor|forbidden|api.?key|认证|授权/.test(text)) return { code: 'authorization', guidance: '确认密钥属于当前服务地址，或重新完成对应平台授权。' };
  if (/404|model.*not|invalid.*model|unknown.*model|模型/.test(text)) return { code: 'model', guidance: '读取账号可用模型列表，检查模型 ID、区域和开通权限。' };
  if (/429|rate.limit/.test(text)) return { code: 'rate_limit', guidance: '服务触发速率限制，稍后重试或降低并发。' };
  if (/timeout|abort|timed.out/.test(text)) return { code: 'timeout', guidance: '请求超时；检查服务状态后重试。' };
  return { code: 'connection', guidance: '检查服务地址和网络；本地模型需先启动服务。' };
}
