# 工具调用 · 长对话 · 跨线程记忆：设计审计与方案（2026-10-17，Claude）

基线：master `6adc270`（今天上午的审计修复已全部落地）。本文是**设计层**审计：不再找 bug（那一轮见 `docs/architecture-agent-context-audit-20261017.md`），而是评估三条链路的设计是否撑得住"长对话 + 多工具 + 多线程"的使用方式，并给出可选方案，**等用户选择后再实施**。三路只读扫描（工具调用 / 长对话 / 跨线程记忆），每条结论都带 `file:line`，数字来自仓库自带估算器或沙箱只读模拟，标「待核」的需要在用户机器实测。

---

## 0. 一页摘要：三条链路的核心判断

| 链路 | 今天的设计一句话 | 最大的结构性问题 | 推荐方向 |
|---|---|---|---|
| **工具调用** | 30 个工具按 Agent 能力过滤后，每轮再按搜索路由增删 2–8 个，原生 function calling（Codex/OpenAI）或 XML 文本协议（其它供应商）；执行器有能力/审批/超时三道门；工具轨迹只活在当轮 | ① 工具数组逐轮变 → 8–13k token 的定义段 + 整段历史每轮脱离前缀缓存；② 结果没有统一 envelope，模型分不清"搜不到"和"服务坏了"；③ 只有次数上限，没有总时限/总用量；④ 非 OpenAI 供应商被迫走 8.5k token 的 XML 规格且不进缓存 | 先统一结果 envelope + 工具集按 Agent 固定（2.5 人日），再加 RunBudget，再做调用记录与回放，最后做协议适配器让 Anthropic/本地模型也有原生工具 |
| **长对话** | 160k 预算、114k 滑动窗口、满了同步压最旧 45k 成一段 6 段式摘要（单槽覆盖、代际再压）；线程文件全量 pretty JSON 含内联 base64 图，每条消息整文件重写；UI 全量重建 | ① 存储/传输/渲染都是"全量"——500 轮带图对话每轮写盘回传几十 MB、渲染线性变慢；② 摘要代际有损、无结构、用户看不见也改不了；③ 掉出窗口的原文没有"读回整段"的路径；④ 手机无摘要且协议带不过去 | 不采用原版 1B"重排历史"，改为 **1D：固定近窗 + 账本式话题卡 + `read_history` 读回 + 话题摘录放 turn 段**，与今天的缓存布局兼容；先做附件外置 + UI 只渲染最近 60 条 + 压缩后台化 |
| **跨线程记忆** | 五族命名空间（chat/project/agent/user:local/speaker），自动事实恒为 chat 作用域，共享只靠用户手动改范围，读取靠 6 席相关度 + Hot Attic 碰运气；远程受众靠 JS 层隔离 | ① 同一项目第二条对话从零开始（对话 1 的结论不跨对话）；② "改成个人"后并不是每次都带；③ dreaming 的晋升对提示没有实际作用；④ 用户没有"这条很重要 / 这是决定"的开关 | **2A 剩余 + 2B**：先给可见性与 category/pinned 编辑（2 人日），再做"项目记忆本 + 个人档案"放进稳定前缀（6 人日），2C 只保留为显式 `search_history scope=all` |

三条线有交叉依赖（见 §5 路线图）：`read_history` 工具复用 P0-3 的受众隔离；话题卡与项目记忆本都放在今天新建的 `placement:'system'` 稳定前缀；RunBudget 同时约束工具循环与压缩调用。

**需要用户拍板的 6 个决定**（§6 有完整清单）：
1. 工具集是否按 Agent 固定（多 0.7–2.7k token/轮，换前缀缓存命中）；
2. 长对话走 1D 还是原版 1B；近窗收回到 48–64k 还是保持 114k；
3. 项目记忆本的自动行是否默认进提示（带 `[auto]` 标记）还是仅提议；
4. 附件外置（线程文件瘦身）是否先做——它改消息存储格式；
5. Anthropic/本地模型的原生工具支持要不要做（3 人日）；
6. 手机端：先同步桌面摘要（协议加字段）还是手机自己摘要。

---

## 1. 工具调用

### 1.1 当前设计图

```
prepare (chatExecutionRunner.js:439-462)
  getAllTools()[30] ─filterMcpToolsForAgent─▶ filterToolsForSearchPlan(searchPlan)   ← 逐轮：±web_search/fetch_url/browser_*
      ─▶ toolsForCapabilityScope(…+skillTools, capabilityScope)                       ← 按 Agent 能力（READ/WRITE/NETWORK 映射）
      ─▶ delegate 仅当 canDelegate&&targets ─▶ promptTools / visibleToolIds
  selectToolContextPolicy → mode:'none'（算术/翻译/纯上下文）时 promptTools=[]
  createFunctionCallingSession(config, promptTools)  ← native?（Codex / Responses / api.openai.com）: legacy XML
  toolsPrompt = 搜索路由文案 + (native ? 240 tok 说明 : 8.5k tok XML 规格) → 'tools' 段 placement:'turn'（systemPrompt.js:244）

invoke-model (:634-918)  for iteration < 10:
  takeSupplements → user 消息(isSupplement)
  fitRequestContext(...)  [CONTEXT_BUDGET_EXCEEDED → compactToolChain(保留最近 2, 600 字) 重试一次]
  createReply({functionTools, nativeWebSearch?, nativeImageGen?, prompt_cache_key})
     openai.js:1096-1104：tools = [web_search?, image_generation?, ...functionTools]   ← 原生工具插在**头部**
  parse → ≤32 调用、call_id 去重、schema 校验；repeatGuard（同指纹失败 2 次本地拒绝）
  executeToolCalls（isConcurrencySafe 分组、4 worker；串行工具先 flush）
     executeTool：环境 capabilityScope 缺失即拒 → scopeAllowsTool → workspaceForTool → operationScope
       runObservedTool：requiresPermission → permissions.js(120s / NO_SURFACE) → tool:before(有界) → 60s 超时 → tool.run
         [bash/file_*/image 内部再过 fileSafetyGate._prompt(120s，无 emitter 仍等)]
         normalize {ok,output,error,meta,evidenceTrail?} → tool:after(有界)
  append：function_call_output {ok, output≤8000 字, error≤500, evidenceTrail≤20}
  SSE：tool_calls_start(原始 args) / tool_output / tool_calls_done(output≤500,errorCode) / execution_event(白名单键,≤2200)
  persist：assistantMessage.toolResults = {toolCallId,toolName,ok,errorCode?,evidenceTrail?,path?,exitCode?}（无 args/output）
  跨轮：loopMessages 丢弃，下一轮模型只见最终 prose（functionCalling.js:239-240）
```

**每轮工具定义大小**（原生，Codex Responses；沙箱用 stub 加载真实 registry 后以仓库估算器计）：

| 场景 | 工具数 | JSON 字符 | est token | fitter 预留（×4/3） |
|---|---|---|---|---|
| 全部 registry | 30 | 40,267 | 10,125 | 13,500 |
| main Agent 推荐能力 | 29 | 39,795 | 10,007 | 13,343 |
| 路由 none / codex-native（典型） | 21 | 32,087 | 8,073 | 10,764 |
| 路由 fetch-url | 22 | 33,636 | 8,460 | 11,280 |
| toolContextPolicy none | 0 | 0 | 0 | 0 |

最大单项：`pdf` ≈2.1k tok（**strict:false**）、`image` 0.8k、`xlsx` 0.3k（strict:false）。legacy XML 规格 ≈8.5k tok，放在逐轮尾部（不进缓存前缀）。

### 1.2 设计缺口（按影响）

| # | 缺口 | 证据 | 为什么是设计问题 | 影响 |
|---|---|---|---|---|
| T1 P0 | 工具数组逐轮变化，前缀缓存每轮被打断 | `chatExecutionRunner.js:452-453`；`searchRouter.js:236-245`；`openai.js:1096-1104`（原生工具插头部）；`:1107-1109`（image 时 instructions 追加规则）；`requestPolicy.js:72-88` mode none 清空 | 工具 schema 在 Responses 缓存前缀里（instructions 之后、input 之前）；相邻两轮路由不同就整段脱落；原生工具插头部把整个 functionTools 段位移 | 每轮 10–13k token 重复计费 + 首 token 延迟（待核：对比执行详情 cached tokens） |
| T2 P0 | 结果回流无统一 envelope | `web_search` 空结果 `ok:false,error:'SEARCH_FAILED'`（`webSearchTool.js:2371-2378`）与供应商挂掉同码；`grep/glob/search_history` 空结果 `ok:true`；`bash` 非零退出 `error:'Exit code 1'`（`bashTool.js:354`）；`fileEditTool.js:188,220,322,443` 用 `err.message` 当 error；`'DENIED'` vs `PERMISSION_DENIED`；`deriveUnifiedErrorCode` 只写持久化/SSE、不改模型可见文本（`toolResultProjection.js:28-38`） | `tool.js` 合约只定 `ok/output/error?/meta?`，没有错误枚举与"空结果"语义；repeatGuard 用 error 文本做指纹，带路径的消息识别不出重复 | 模型分不清"搜不到"与"服务坏了"，常见换词重搜 3 次；UI errorCode 与模型看到的不是一回事 |
| T3 P1 | 只有次数上限，没有总时限/总用量 | `MAX_TOOL_ITERATIONS=10`（`:634`）；模型 600s/次；工具 60/180/920s；审批 120s；用量只在 finalize 汇总（`:1045-1047`）；成员有 `maxTokens`，主对话没有 | 7 个常量互不感知（理论上限 >6 小时）；子预算不从父剩余派生 | 无法向用户承诺"最多 N 分钟 / N token"，取消是唯一出口 |
| T4 P1 | 工具链不进跨轮历史；取消的轮次整条轨迹消失 | `functionCalling.js:239-240`；`sendChatMessage.js:128-141` 取消路径不落助手消息；`toolResults` 无 args/output | 刻意取舍（省 token、防协议数据跨 chat 泄漏），但没有替代通道 | 多轮工程任务重复读文件/重复搜索；取消后"继续"从零开始；摘要也看不到工具事实 |
| T5 P1 | 审批面不一致 | 工具级 `permissions.js:131-135` 立即拒；路径级 `fileSafetyGate.js:158-213` 无 emitter 仍等 120s；bash/file_read/image `requiresPermission:false` 直接进 gate | 两套 gate 各自实现等待/超时，没有统一的 `permissionSurface` 属性 | 远程渠道（恢复后）带写入的 bash 仍会挂 2 分钟（待核） |
| T6 P1 | 两条协议并存，非 OpenAI 供应商只能走 XML | `functionCalling.js:6-12`；chat-completions 无 `tools`（`openai.js:1386-1415`）；`anthropic.js:76` 收到 `tool_use` 直接抛错、请求体无 tools；XML 规格在逐轮尾部、Anthropic 两个 cache_control 之后 | 函数调用抽象停在二元 `native` 开关，没有协议适配层；本地模型上下文最小（24k）却承担最大工具段（8.5k） | 切到 Anthropic/本地后工具可用性与成功率下降，缓存收益归零 |
| T7 P2 | 三套投影互不一致，没有可回放的"模型实际看到的 I/O" | `tool_calls_start` 发原始 args（未脱敏，`:750-755`）；`execution_event` 白名单键脱敏 ≤1000；`tool_calls_done` ≤500；模型看到的 8000 字 JSON 不落盘；ledger 仅 task 模式 | 没有单一 invocation record | 无法回放一轮复现模型决策；SSE 可能把敏感 args 发到前端 |
| T8 P2 | 加新工具改 7–9 处；MCP 连接改全局 registry | `registry.js:17-59`、`capabilities.js:28-55`、`toolWorkspace.js:14`、`executionScene.js:39-46`、`executionObservation.js:9`、`runSteps.js:5`、`team.js:19`、`searchRouter.js:30`、`operationLedger.js:9-15`；`manager.js:184/218` | 工具的能力归属/是否需工作区/UI 模块/输入摘要键是工具静态属性，却散在 6 张外部表 | MCP 连接/断开让所有聊天工具集同时变（也打缓存）；模型看到 `melo_..._<hash>` 混淆名 |
| T9 P2 | `isConcurrencySafe` 是静态布尔；ledger 据此跳过回执 | `pdfTool.js:509-510`、`xlsxTool.js:42`、`imageTool.js:153` 为 true 但有 write 动作；`operationLedger.js:13` | 能力判定已按 args.action，并发判定没有 | task 模式两个 `pdf write` 可并行写同一路径且无回执 |
| T10 P2 | pdf/xlsx schema 不满足 strict 子集 | `functionSchema.js:114-115` | 最贵的两个工具没有 strict 校验 | 模型漏字段只在后端 parse 报错，多耗一轮 |

### 1.3 方案

**T-A 工具集稳定化（对 T1）**

| 方案 | 做法 | 文件 | 权衡 | 人日 | 验证 |
|---|---|---|---|---|---|
| **A1 按 Agent 固定（推荐）** | `promptTools = toolsForCapabilityScope(all+skills)`，去掉 `filterToolsForSearchPlan`；searchPlan 只影响路由文案与 `nativeWebSearchEnabled`；原生 `web_search`/`image_generation` 追加在 functionTools **之后**；`delegate` 固定存在、无目标时 `DELEGATION_DENIED`；`IMAGE_INTENT_RULES` 移入 turn 段 | `chatExecutionRunner.js:451-455,637-639`、`openai.js:1096-1109`、`searchRouter.js:236`、`subAgent.js:139` | 每轮多 2–8 个工具（+0.7–2.7k tok）换前缀稳定；codex-native 轮可能误用 web_search（靠路由提示约束） | 1 | 同一对话 10 轮交替本地/联网问题，执行详情 `cached` 中位数 >60%；searchRouter 测试改断言为提示文案 |
| A2 稳定核心 + 只增不减的扩展组 | 核心组固定；browser_*/pdf/xlsx/media/mcp 按需激活后保留到对话结束（存 `chat.toolGroupsActivated`） | 同上 + state 字段 | 复杂；首次激活仍打一次缓存 | 2 | 同上 + 激活后不脱落 |
| A3 最小修（只修头部插入与 instructions 漂移） | 原生工具后置；IMAGE_INTENT_RULES 入 turn 段 | `openai.js:1103-1109` | 路由 ±2 工具仍打缓存 | 0.3 | tools 顺序快照 |

**T-B 结果 envelope 统一（对 T2、T10）**

| 方案 | 做法 | 文件 | 权衡 | 人日 | 验证 |
|---|---|---|---|---|---|
| **B1 执行器出口统一（推荐）** | 定义 `ToolErrorCode` 枚举（INVALID_ARGS / NOT_FOUND / NO_RESULTS / PERMISSION_DENIED / CAPABILITY_DENIED / TIMEOUT / ABORTED / NETWORK / PROVIDER_DOWN / EXIT_NONZERO / UNKNOWN）；executor normalize 时映射（含 SearchTask 8 码、`DENIED`、`Exit code N→EXIT_NONZERO+meta.exitCode`），未知进 `meta.detail`；新增 `status:'ok'|'empty'|'error'`，空结果工具统一 `ok:true,status:'empty'`；`toolOutput()`/`formatToolResult()` 输出 `{ok,status,code,output,hint?}`；原生说明加一句三态解释；repeatGuard 指纹改用 code | `tool.js`、`executor.js:207-222`、`functionCalling.js:187-198`、`parser.js:182-207`、`toolResultProjection.js`、`webSearchTool.js:2371`、`bashTool.js:354`、`fileEditTool.js`×4、`systemPrompt.js:55-63`、`repeatGuard.js` | 改模型可见文本 → 全部 function-calling 集成测试要跑；成员 `failedTools` 统计会变好 | 1.5 | 新 `executor.envelope.test.js` 对 30 个工具伪造各类错误断言 code ∈ 枚举；fixture 模型下空搜索不再换词重搜 3 次 |
| B2 只在工具内逐个规范 | 23 个 builtins 各改 | — | 无强制，新工具又漂移 | 2 | 同上 |
| B3 顺带修 strict | pdf/xlsx 拆按 action 的子工具或字段改可空必填 | `pdfTool.js`、`xlsxTool.js`、`capabilities.js` | 工具数 +1–2；pdf 描述可缩 1k | 1 | `compileFunctionTool(pdf).definition.strict===true` |

**T-C 总时限 / 总用量 RunBudget（对 T3）**

| 方案 | 做法 | 文件 | 权衡 | 人日 | 验证 |
|---|---|---|---|---|---|
| **C1 挂在 requestContext（推荐）** | `budget:{deadlineAt,maxInputTokens,maxToolCalls,used}`（默认桌面 20 min / 400k 输入 / 120 次；env 可覆盖）；每次 `createReply` 前检查并把 `min(600s, remaining)` 作为请求超时，`onProviderResponse` 累加；工具超时 `min(tool.timeout, remaining)`；成员/技能 `narrowBudget` 取 min；超限返回显式 `BUDGET_EXHAUSTED` 回复 + 执行事件 | `runtime/requestContext.js`、`chatExecutionRunner.js:672-738`、`executor.js:180-186`、`subAgent.js:195-203`、`skillExecutor.js:214-228`、`delegate.js:22`、`team.js:88-107` | 与 team 现有 budgetTimer 合并；供应商不返回 usage 时退化为估算 | 2 | 虚拟时钟：deadline 60s、第 2 轮模型挂 → 61s 终止 run=failed/BUDGET；成员 timeoutMs ≤ 父剩余 |
| C2 只加轮次级总时限 | AbortController 包主循环 | `:634` 附近 | 不覆盖用量 | 0.5 | 同上第一条 |
| C3 用户可见预算 | 在 C1 上把 `budget.used` 推到执行面板 | `executionPanel.js`、`executionScene.js` | 纯展示 | 0.5 | 浏览器快照 |

**T-D 调用记录与回放（对 T7、T4）**

| 方案 | 做法 | 文件 | 权衡 | 人日 | 验证 |
|---|---|---|---|---|---|
| **D1 单一 ToolInvocationRecord + 三投影（推荐）** | 执行器生成 `{runId,iteration,callId,toolId,argsRedacted,argsHash,resultEnvelope,modelFacingOutput≤8000,startedAt,finishedAt,parallelGroup}` 追加写 `desktop/execution-scenes/<runId>.tools.jsonl`（0o600）；`tool_calls_start` 改发脱敏 args；observeTool/toolResults/tool_calls_done 都从 record 投影 | `executor.js:64-93`、`executionObservation.js`、`chatExecutionRunner.js:750-879`、`executionScenes.js`、`toolResultProjection.js`、UI `activeToolCallsStrip.js` | 磁盘增长（每轮 ≤32×8KB），跟 scenes 同过期策略 | 2 | 一轮 3 次调用后 jsonl 3 行且 `modelFacingOutput` 与 `functionCallOutputs[i].output` 字节一致；`tool_calls_start` 无明文密钥 |
| **D2 回放（在 D1 上）** | 取消/失败轮把工具轨迹摘要（工具名+args 摘要+status，≤600 字）作为 `kind:'tool-trace'` 的**文本**助手消息落入 chat，进入下一轮历史与压缩输入；成功轮可选 | `sendChatMessage.js:128-141`、`chatExecutionRunner.js:900-918`、`contextCompact.js` | 历史每工具轮 +≤600 字；纯文本无 call_id，跨 chat 泄漏为零 | 1 | 取消后发"继续"，下一轮 prompt 含上一轮读过的文件名；memory-isolation 不回归 |
| D3 只做 UI 侧 | 执行详情展示 toolResults 全量 + args 摘要 | `messageToolResults.js` | 不解决回放 | 0.5 | 浏览器测试 |

**T-E Anthropic / 本地模型工具支持（对 T6）**

| 方案 | 做法 | 文件 | 权衡 | 人日 | 验证 |
|---|---|---|---|---|---|
| **E1 协议适配器层（推荐，排最后）** | `native` 改 `protocol:'responses'|'chat-completions'|'anthropic'|'xml'`；Anthropic 请求体支持 `tools[{name,description,input_schema}]`、解析 `tool_use`、回流 `tool_result`（cache_control 放 tools 后/system 末）；chat-completions 加 `tools/tool_calls/tool role`（DeepSeek/Qwen/Ollama 均支持）；definitions 按协议生成；`loopMessages` 改协议中立中间表示 `{role,text,toolCalls[],toolResults[]}` | `functionCalling.js:175-181,241-298`、`functionSchema.js`、`providers/anthropic.js:24-104`、`openai.js:1386-1415`、`contextBudget.js:121` | 三条协议消息形状不同；本地模型质量参差，保留 `toolCalling:'legacy'` | 3 | 三协议各一套 fixture 集成测试；Anthropic 10 轮 `cache_read_input_tokens>0` |
| E2 XML 规格进稳定前缀并瘦身 | `instruction('tools',…,'system')`；去示例只列必填（8.5k→≈4k） | `systemPrompt.js:244`、`tools/systemPrompt.js:83-106` | 仍无 strict；但 Anthropic 缓存立即生效 | 0.5 | token 对比；parser 测试 |
| E3 本地模型精选小工具集 | authMode local 只暴露 file_read/grep/glob/bash/web_search/fetch_url（≈2.3k tok） | `chatExecutionRunner.js:453` 增 `selectToolTier` | 功能缩水但 24k 窗口可用 | 0.5 | `toolTokens<3k` |

**T-F 审批面与扩展性（对 T5、T8、T9）——小项**
- F1 `requestContext.permissionSurface ∈ {'sse','headless','none'}` 定一次，`permissions.js` 与 `fileSafetyGate._prompt` 都读它，`'none'` 同样抛 `PERMISSION_NO_SURFACE`；远程渠道再过滤需审批/需 gate 的工具并在 channel 提示声明。0.5 人日。
- F2 工具自描述：`tool.js` 增 `capability`、`needsWorkspace`、`uiModule`、`inputKeys`、`concurrency: boolean|(args)=>boolean`，6 张外部表改为兜底。1.5 人日；验证：新 fixture 工具只注册一处即过能力/工作区/UI 模块测试；`pdf write` 不再并行。
- F3 MCP 注册隔离：独立 `mcpRegistry`，prepare 时按 Agent 白名单合并；函数名用可读 `mcp__server__tool`，超 64 字才哈希。1 人日。

**推荐路线（工具线）**：B1 + A1（2.5 人日，改一处出口全链受益，也是后面一切的前提）→ C1 + F1（2.5）→ D1 + D2（3）→ E1（3，但在 B1 时就把 `loopMessages` 中间表示定成协议中立，避免返工；短期只要 Anthropic 能用则先做 E2）。F2/F3 按需插队。合计 11–12 人日。

---

## 2. 长对话

### 2.1 一条长对话的生命周期（桌面、云端模型、中文；数字为沙箱只读模拟）

1. 每条用户消息直接 push 进 `chat.messages`，图片以 base64 data URL 原样存在 `attachments[].url`（前端只在 >6MB 或 >4096px 时缩图，仍是 data URL）。
2. 每轮：预算 160k / 预留 8k / 输入上限 152k / 窗口 114k；`buildModelMessagesFromChat` 从压缩边界之后按 114k est 装窗，历史轮剥富媒体。
3. 窗内（文本 ~530 est tok/轮 → 约前 200 轮）：每轮发 = 稳定前缀 + 全部历史原文；frames/scenes 召回不排除窗内（可重复）。
4. 第 ~215 轮：pending ≥114k → **同步**调用摘要模型（无执行事件，用户只见"思考中"），只压最旧 45k est（≈84 轮），摘要截 6000 tok，窗口回落到 ~69k。
5. 之后每 ~84 轮重复：`previousSummary` 截 5000 tok 后与新 45k 转录一起再摘要，单槽覆盖、无版本。
6. 每 4 个助手轮抽事实（最近 12 条 ×1600 字），存 80 注入 12。
7. 后台 worker：每条消息使 checkpointId 变化 → 整段重建该聊天的 prompt/frame/scene 条目。
8. 每次写状态：整个 `messages` + derived 序列化、sha256、pretty JSON 原子写 `desktop/threads/<chatId>--<sha>.json`，一轮两次。
9. 每次响应：`activeChat` 整对象（含 base64 图、modelResponses、memoryUsage）回传前端并 JSON.stringify+sha256。
10. 前端：delta 走快路径；其余事件整页重建，`renderMessageList` 遍历全部消息，`<img src="data:…">` 内联；无虚拟化/分页。
11. 冷启动：顺序读取每个聊天的全文件进内存。
12. 手机：同步只带 `{id,role,content,createdAt}`，协议丢弃其它字段；发送取最近 ≤60 条 / 48KB，无摘要。

**500 轮、含工具与图片的对话**：内存全量；每轮输入 est 在 69k–114k 之间锯齿（真实 o200k 中文约 50–85k）；文本 4 次摘要（第 215/299/383/467 轮）、带图 7 次（第 141 轮起每 55 轮），每次是一个 45k 输入的同步模型调用；线程文件纯文本 ≈2.5MB pretty，带 50 张 1.5MB 图 ≈ **75MB，每条消息重写一次**；UI 每次非 delta 渲染重建 1000 条消息 HTML。

**A→B→C→A**：窗内严格时间序全发（能答对、贵）；A 掉出边界后只剩摘要几句 + 按当前消息文本相关度召回的 ≤12 条 180 字片段（"回到刚才那个"这种无关键词的指代召回不到）+ 模型自觉调 `search_history`（FTS 片段仅 32 词元，助手消息只索引前 2000 字）；**没有任何读回整段原文的工具**。唯一的"话题"结构是 frames，只用于召回不用于装配。

### 2.2 设计缺口（按影响）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| L1 | 线程文件 = 全量消息 + 内联 base64 图，每条消息整文件重写；冷启动全量进内存；`activeChat` 每次响应整体回传 | `chatPersistence.js:32-37`、`checkpointer.js:160-164`、`storage.js:6`、`stateHydration.js:440-458`、`bootstrap.js:364`、`bootstrapTransport.js:20-22` | 长对话变慢的首因 |
| L2 | UI 无虚拟化，全消息重建 + data URL 内联 | `app.js:7137-7164`、`attachmentCards.js:137`、`:10702-10705` | 渲染线性变慢 |
| L3 | 每轮历史 69k–114k 锯齿：窗口拉大后压缩只削 45k | `contextBudget.js:24,38`、`contextCompact.js:52` | 平均每轮 ~90k est 历史（缓存命中也付 cached 价）；注意力被旧话题稀释 |
| L4 | 压缩同步阻塞当轮且无提示 | `chatExecutionRunner.js:415-418,345-379` | 每 55–84 轮一次 15–60s 空等 |
| L5 | 摘要代际衰减 + 单槽覆盖 + **`upgradeDegradedCompact` 不传 `previousSummary`**（今天引入的 bug） | `contextCompact.js:206,224`、`derivedState.js:20-22`、`chatExecutionRunner.js:397` | 回到早期话题答不准；降级恢复后反而丢早期摘要 |
| L6 | 无"读回原文"能力 | `agentMemoryContext.js:20,83,130-134`、`conversationIndex.js:375` | 摘要与原文无法真正联动 |
| L7 | 话题无感知，装配严格时间序 | `messageBuilder.js:550-553` | B、C 全文陪跑；A 掉出窗口即失忆 |
| L8 | 工具输出不进历史，也不进摘要 | `chatExecutionRunner.js:882-893`、`toolResultProjection.js:70-80`；压缩转录只含 user/assistant 文本 | "继续刚才那个文件"要重跑工具 |
| L9 | 零用户控制：无手动压缩/固定/拆分；`compactSummary` 桌面和 iOS 都不渲染 | grep `app.js`、`chatRoutes.js`、`chatMutations.js` | 用户不知道模型"记得什么" |
| L10 | 手机无摘要且协议带不过去 | `ConversationHistory.swift:6-8`、`protocol.js:13-21`（`validateSnapshot` 丢弃新增 chat 字段） | 两端对同一对话"记得的不一样" |

次要：session facts `slice(-80)` 不分类别；frames 召回不排除窗内；派生索引每条消息整聊天重建；桌面把补充内容追加进用户消息 `content`（`sendChatMessage.js:469-471`）而 `mergeSnapshots` 对同 id 不同内容抛 409——若已同步到手机会冲突（待核）。

### 2.3 方案

**对 `context-memory-plan` 1A / 1B / 1C 的评估**

| 方案 | 评估 | 人日 |
|---|---|---|
| 1A 现状加小修（手机补摘要） | 只解决手机，不解决桌面 L1–L9；两端各自摘要会分叉 | 2–3 |
| 1B 话题分段（文档原推荐） | 方向正确（"回到 A 拿回 A 原文"是真需求），但原写法三处硬伤：逐消息分类器在关键路径上，错分即丢上下文；把 B/C 从 `messages[]` 过滤/重排会让每次切话题前缀缓存必失效，**与今天刚落地的缓存布局冲突**；"最近 3 轮原样"对工具驱动的跟进不够 | 4–5（按下面改法） |
| 1C 按需检索 | Melo 已半做（prompts/frames/scenes 召回 + search_history），缺"读回整段"与足够近窗保证；单独做有隐含指代风险 | 1（作补件） |

**推荐 1D = 固定近窗 + 账本式话题卡 + 原文读回 + 话题摘录进 turn 段**（吸收 1B 的话题卡与 1C 的检索，**永不改动 `messages[]` 的顺序与集合**，因此与稳定前缀 / turn 段布局兼容）：

| 步骤 | 做法 | 文件 | 人日 |
|---|---|---|---|
| 1D-1 近窗收回 + 后台预压缩 | `HISTORY_WINDOW_SHARE` 可配（建议 0.3–0.4 → 近窗 48–64k）；post-turn 任务在 pending >70% 窗口时压缩，边界下一轮生效；当轮阻塞仅兜底并发 `compact:running` 事件 | `contextBudget.js`、`chatExecutionRunner.js:329-423`、`sendChatMessage.js` post-turn、`derivedState.js` | 1.5 |
| 1D-2 账本式摘要 | `compactSummary` → 结构化 `compactLedger={goals,decisions[],open[],cards:[{id,title,summary,fromMessageId,toMessageId,at}]}`，每次压缩只追加/更新卡，不再把旧摘要整体喂回再压；渲染按时间列卡，超 6000 tok 时最旧卡只留一行标题；chunk 边界优先用 frames 边界；**修 `upgradeDegradedCompact` 传 `previousSummary`**；旧 `compactSummary` 迁移为一张历史卡 | `contextCompact.js`、`derivedState.js`、`chatThreadContext.js:106-141`、`systemPrompt.js:240` | 2 |
| 1D-3 `read_history` 工具 | 按 `chatId + messageId 范围 / cardId` 返回原文（≤8k tok），受众/项目隔离复用 P0-3 | 新 `src/tools/builtins/readHistoryTool.js`、`capabilities.js`、registry | 1 |
| 1D-4 话题摘录进 turn 段 | 召回组新增 `cards`：按当前消息相关度 + 最近切换的话题取 2–3 张卡对应原文摘录（每卡 ≤1500 tok），作为 reference 段（prio 85，maxTokens 4000，placement turn） | `agentMemoryContext.js`、`systemPrompt.js:248-250` | 1 |
| 1D-5 工具事实进摘要 | 压缩转录加入 `toolResults` 的工具名与 ≤200 字结论（`projectToolResultForPersist` 多存 `summary`） | `toolResultProjection.js`、`contextCompact.js` | 0.5 |

风险：近窗收小后对"60 轮前"的即时引用依赖召回/读回，需用例集；账本格式迁移。
验证与指标：每轮 `inputTokens`/`cached` 从 `metadata.modelResponses.usage` 取（执行详情已显示）；目标 500 轮文本对话平均每轮输入 ≤45k est；压缩不阻塞（P95 首 token 不因压缩轮上升）；"回到 A"问答集（10 例，A 在 100+ 轮前）命中 ≥8/10；标识符保留率（源片段里的数字/路径/ID 出现在卡中）≥90%。

**摘要质量与可回溯（独立项，1.5 人日）**：提示词加"每个话题一张卡，含标题/结论/未决/涉及消息编号；逐字保留数字、路径、标识符、用户纠正；不复述旧卡"，转录逐条加 `[#messageId]`；云端摘要也过 `auditSummary`，不达标标 `partial` 下一轮重试；`compactHistory[]` 版本化，UI 可查看/编辑卡，`userEdited` 不被覆盖。

**UI 长线程性能（独立项）**：
1. 只渲染最近 60 条 + 顶部"加载更早"（IntersectionObserver），按 `data-message-id` 键控复用节点。2 人日。
2. **附件外置**：发送时 data URL 落盘 `<home>/desktop/attachments/<id>`，消息存 `/api/media/attachments/<id>` + 缩略图，`messageToModelContent` 发送时再读回；顺带让 `activeChat`/线程文件/手机同步瘦身。2–3 人日。**改消息存储格式，需迁移。**
3. bootstrap 的 `activeChat` 改为最近 60 条 + `messageCount`，旧消息走 `/api/chats/:id/messages?before=`。1.5 人日。
4. 结构性（后排）：线程文件拆 head + append-only JSONL，冷启动只读 head。4–5 人日。
指标：1000 条消息 `render()` ≤50ms；写盘字节/轮；启动时间。

**手机对齐（独立项，2–3 人日 + 手机自摘要 2）**：在 workspace `conversation` 记录（`workspaceProtocol.js:62`，带 clock）增加可选 `compact:{boundaryMessageId,compactedCount,source,at,cards[]|summary}`，`compactedCount` 单调大者胜；手机 `recentTurns` 只取边界后消息，指令前加摘要（≤8KB）；桌面为主摘要方，手机离线超窗可做本地摘要并写回。验证：桌面压缩后手机下一轮输入含摘要；`crossPlatformContracts.test.js` 加断言。

**推荐路线（长对话线）**：先止血不改语义（附件外置 + UI 只渲染最近 60 条 + 压缩后台化 + 修 `upgradeDegradedCompact`，≈5 人日）→ 账本式话题卡 + `read_history`（≈4）→ 近窗收回 + 话题摘录进 turn 段 + 协议带 compact 同步手机（≈4–5）。1A 的手机自摘要作为协议同步之后的离线兜底。

---

## 3. 跨线程记忆

### 3.1 记忆矩阵（命名空间 × 种类 × 受众）

读取侧每轮查询的命名空间固定为 `[user:local(仅本地), chat:{id}, project:{id}, agent:{id}]` + `speaker:*`（`agentMemoryContext.js:44-47`）。

| 命名空间 | kind | 谁写 / 何时 | 自动读进提示？ | 名额 / 排序 | 受众 |
|---|---|---|---|---|---|
| `chat:{id}` | `prompt`（原文，助手截 2000 字） | 每次快照自动 | 是，**只限当前对话**（`accept:local`） | tiered scene 3 / frame 8 / content 12；RRF 后 MMR；排除窗内消息 | 本地/远程各自 |
| `chat:{id}` | `frame` / `scene` | 快照自动 | 是，仅当前对话 | 同上 | 同上 |
| `chat:{id}` | `session-fact`（scope=chat 默认） | 每 4 助手轮 LLM+规则抽取 | 是：session-memory 段，只取本对话来源 | 12 条，correction>decision>user_preference>project_context>technical_detail，再按时间；检查点 80 | 本地/远程均抽取 |
| `project:{pid}` | `session-fact`（scope=project） | **只手动**（记忆页 / 手机改范围） | corrections 组 6 席（相关度）或 Hot Attic | — | 仅本地 |
| `agent:{aid}` | `session-fact`（scope=agent） | 只手动 | 同上 | — | 仅本地 |
| `user:local` | `session-fact`（scope=personal） | 只手动 | 同上 | — | 仅本地 |
| `agent:{aid}` | `verification-correction` | 自我校验 CORRECTED 时自动（今天起 scope=agent） | corrections 组 6 席 / Hot Attic | — | 本地 |
| `project:{pid}` | `prompt`（同一消息第二份） | 快照自动（`snapshotBuilder.js:152-154`） | **否**：读路径 `accept:local` 过滤掉，无其他读者 | — | — |
| owner 命名空间 | `task` / `approval` | 变更时自动 | 是（`localOrProject`） | 各 6 席 | 项目内所有对话 |
| `speaker:{source}:{agent}:{sender}` | `fact` | 远程用户消息快照自动 | 是，但要求同 chatId → 只在原对话 | 8 / 10；≥6 条压档案 | 远程 |
| `agent:{aid}` | `identity` | 快照自动 | **否**（今天起），只供 dreaming 去重 | — | — |
| 知识索引 | `knowledge_chunks` | 知识 artifact 变更 | 是，按 `project.knowledgeIds ∪ chat.contextArtifactIds` | 8 块 ×1200 字 | 本地 |
| 对话索引 + `message_scope` | 全文 | 每轮 | 否，模型按需调 `search_history`（受众+项目 SQL 层过滤） | 8 条 | SQL 层 |

**设定而非记忆**（每轮进稳定前缀）：Agent 人设 `instructions`、项目覆盖人设、项目 `name/summary/workspacePath/instructions`、模式、能力、`contextSources` 开关、对话压缩摘要。

### 3.2 四个场景今天的真实行为

**a) 同一项目两条对话，对话 1 定方案，对话 2 问"按之前的方案"**：对话 1 的原文/frame/scene 虽写进 `project:P`，读取侧 `accept:local` 只收本对话 → 对话 2 记忆段没有对话 1 任何原文；对话 1 抽出的 decision 事实 scope=chat → 对话 2 看不到。唯一自动通道是模型主动调 `search_history`（且 Agent 需开 `knowledgeMemory`）。用户若在记忆页把那条 decision 改成"此项目"，因 category=decision 进 Hot Attic 每轮可见——前提是它在该命名空间集合**最近更新的 32 行**内。**结论：默认不知道。**

**b) 同一 Agent 跨项目**：`project:P` 不在查询集合；`agent:A` 保留自纠错、手动 agent 事实、owner=A 任务，但只靠 6 席相关度或 Hot Attic，不是每轮必带。项目覆盖人设是整体替换快照，记忆 agentId 不变。

**c) 用户把一条改成"个人"，新对话是否每次都带**：写入 `user:local`；新对话 session-memory 段不含它（来源 chatId 不同）；只能走 corrections 6 席或 Hot Attic。Hot 条件：category∈{correction,decision} 或 pinned（无 UI 可设）或 useCount≥5 且 14 天内用过 → 一条 `user_preference` 要先被相关度召回 5 次才变 hot，闲置 14 天又掉回。**不是每次都带，且随时间衰减。**

**d) 远程群聊（已归档）与桌面私聊**：远程事实 namespace 恒为 `chat:{id}`、audience=remote；`factPolicy.js:36-42` 双重拦截 → 远程永不继承桌面 personal/project/agent 事实，桌面也不读远程事实。但查询集合仍含 `agent:A`，隔离只在 JS `canRecallMemory`；`activeMemorySQL` 不含 audience。

### 3.3 设计缺口（按影响）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| M1 | 项目内的结论不跨对话 | `agentMemoryContext.js:49-50,55,83`；`factRecords.js:31`；`project:` 下 prompt 副本无人读 | 同项目第二条对话从零开始；每条项目消息写两份行只增体积 |
| M2 | 共享范围事实没有稳定入口，靠 6 席相关度 + Hot Attic 碰运气 | `agentMemoryContext.js:54`；Hot 候选池只有最近 32 行（`attic.js:137` + `store.js:708`） | 场景 c"每次都带"不成立 |
| M3 | dreaming 的晋升门不影响注入 | `injectHotAttic` 每轮重新 `evaluateAtticLevel`（`attic.js:143-148`），存储的 `metadata.attic` 仅兜底；`recallMemoriesTiered` 的 `atticLevels` 未传 → Warm 层生产无读者 | gates、sweep Phase 1 只改元数据与日记 |
| M4 | 用户无法表达"这条很重要 / 这是决定" | 记忆页只能改 text/scope/forgotten（`factRecords.js:76-93`）；`category` 不可改、`pinned` 无 API/UI | 让事实常驻的两个开关都碰不到 |
| M5 | 记忆使用可见性弱 | `memoryUsage` 持久化在消息 metadata，但桌面只在"知识→记忆"页列最近 10 轮；聊天气泡内无"本回答用了哪条记忆"；无"记到项目/记成个人"一键 | 用户不信任也无法纠正 |
| M6 | 反馈信号只有正向且等于"进了提示" | `outcome='used'`=进入 promptText；无"模型是否采用""用户是否纠正"；`memory_hits` 每轮记录所有候选（limit×4）→ hits 膨胀 | gate 的 recall 分量偏高 |
| M7 | 远程受众边界一半在 JS | namespaces 对远程仍含 `agent:A`；audience 只在 `canRecallMemory`；回退路径 `agentMemoryContext.js:140-152` 只对 prompt 行调 accept；无"远程不渲染 audience=local"属性测试 | 新 kind 漏走即泄漏 |
| M8 | speaker 事实 id 不含 chatId，但读取要求同 chatId | `snapshotBuilder.js:210` vs `factPolicy.js:44` | 同一发言人在两个远程对话的同类事实互相覆盖（待核） |
| M9 | 项目范围事实耦合在来源对话；无 project 级记忆文档 | `factRecords.js:85`；`projectContext.js` 只渲染用户手写字段 | 对话换项目/项目删除后事实挂空 |
| M10 | 跨设备冲突不可见 | `mobileSyncConflict` 行被 `activeMemorySQL` 排除，记忆页显示"已失效"；手机规则抽取与桌面 LLM 抽取措辞不同，只按文本去重 | 用户不知道有冲突 |

### 3.4 方案

**对 2A / 2B / 2C 的评估**

| 方案 | 今天还剩什么 | 评价 |
|---|---|---|
| 2A 收紧现状 | `search_history` 隔离已做；剩"记到项目/记成个人"一键、回复旁显示所用记忆 | 必做基础（M4/M5），不解决场景 a/c。≈1.5 人日 |
| **2B 个人档案 + 项目记忆本** | 全部未做 | **推荐**。今天的 `placement:'system'` + project 段 prio 105 正好是它的位置：记忆本只在事实变化时变（每 4 轮至多一次），缓存失效频率远低于逐轮召回；直接替代 M1/M2 的"靠 6 席相关度" |
| 2C 全自动语义记忆 | — | 不推荐为默认：等于去掉 `accept:local` 让 `project:` prompt 副本参与召回——逐轮必变、无法解释、私聊内容可能进项目。保留为显式动作（`search_history scope=all` 已有） |

**项目记忆本（Project Memory Book）规则草案**
- 定位：项目内所有对话、所有 Agent 共享的"约定/决定/进展"小块；是记忆（可追溯、可失效），不是设定（设定仍是 `project.instructions`）。
- 数据结构：不建新表，复用 `memories` 的 `session-fact` 行：`namespace=project:{pid}`、`scope='project'`、`audience='local'`；新增 `metadata.bookStatus ∈ {auto,confirmed,user}`、`metadata.section ∈ {goal,convention,decision,progress,todo,file}`（由 category 映射，用户可改）；保留 `sourceChatId/sourceMessageId/subjectKey/validTo`。记忆页、forget/restore、portable sync、dreaming merge/supersede 零改动复用。
- 写入：① 自动——`reconcileChatFacts` 对"本对话有 projectId 且 category∈{decision,project_context}"的新事实额外写一条 `bookStatus='auto'` 的 project 行（id 加 `book:` 前缀），这是对"自动事实恒为 chat"契约的唯一例外，且只对本地对话；② 手动——记忆页/回复旁"记到项目"→ scope 改 project、`confirmed`；③ 手写——项目页"记忆本"编辑器 → `user`、`userEdited=true`。
- 合并与冲突：同 `subjectKey`（或 `normalizedFact`）新 active 行把旧行 `validTo=now, supersededByFact`（把 `mergeMemoryFacts` 的同主题替代搬到 namespace 级，dreaming `supersede.js` 扩展到 session-fact+subjectKey）；`user`/`confirmed` 永不被 `auto` 自动替代，冲突时 auto 打 `needs_confirmation` 并带 `[待确认]` 前缀渲染；自动行默认进提示但带 `[auto]` 标记，用户"停止使用"即 forgotten。
- 放哪一层：`systemPrompt.js:237` project 段之后 `reference('project-memory', bookText, 104, 2000, 'system')`，required；按 section 分组，组内 user > confirmed > auto，再 updatedAt desc；上限 **2000 est tokens**，溢出先丢 auto 的 technical_detail/file；book 行加入 `memoryRendered` 以便 `memoryUsage` 与 useCount 记账，加入 `excludedFacts` 避免与 corrections 组/Hot Attic 重复；Hot Attic 的 namespaces 去掉 `project:`。
- UI：项目页新 Tab「记忆本」（分节列表：文本、来源对话按钮、状态徽章、确认/改节/停止使用）；聊天回复底部「本回答参考的记忆（n）」展开，每条带「记到项目 / 记成个人」。
- 文件：`factRecords.js`、`sessionMemory.js`、新 `src/services/project/projectMemoryBook.js`、`systemPrompt.js`、`chatExecutionRunner.js`、`agentMemoryContext.js`、`dreaming/supersede.js`、`memoryManagement.js` + `domainRoutes.js`、`desktop-ui/memoryFacts.js` + `app.js`、`mobile-sync/workspaceProtocol.js:49-53`（两个可选字段）、iOS `MemoryFacts.swift`。
- 风险：自动行质量（抽取器把助手主张当用户决定——提示词已要求只取用户陈述）；前缀随抽取变化（每 4 轮至多一次，可接受；可选"只在对话开始与用户确认时刷新"）。
- 工作量 4–5 人日。验证：项目 P 对话 1 抽出 decision → 对话 2（另一 Agent）首轮 promptText 含该行且带 `[auto]`；远程对话不含；超限丢弃顺序正确；user 行不被 auto 替代。指标：`memoryUsage` 中 book 行占比；auto 行确认/停止使用比例；book 变化导致的缓存命中下降；book 渲染 tokens 分布。

**个人档案规则草案（1.5 人日）**：来源 `scope=personal` 行，category 限 `user_preference/identity/correction`；**不自动写入**，记忆页与回复旁一键，`identity` 类显示"建议设为个人"徽章；渲染 `reference('personal-profile', text, 106, 400, 'system')`，≤400 est tokens、≤15 条，correction > identity > user_preference；同 subjectKey 只留最新；与项目记忆本冲突时项目本优先（更具体）；远程永不；Hot Attic 职责收缩为本对话 + agent 命名空间的 correction/decision/pinned。

**Agent 级记忆定位（0.5 人日）**："这个 Agent 与用户协作的经验"：自纠错、用户手动标记的"对这个 Agent 的要求"、owner=agent 任务；不进稳定前缀，但给独立名额：corrections 组拆成 `agentNotes`（agent:A，limit 4）与 `sharedFacts`（limit 4）。

**远程受众边界（1 人日）**：SQL 层加 audience（`buildRecallQuery` 传 `audience`，与 forgotten/validTo 同层）；远程 chat 的查询集合去掉 audience=local 来源；回退路径 approvals/tasks 补 `accept`；`memory-isolation.test.js` 加"远程 chat 渲染结果不出现任何 audience=local 行（含 book/profile）"属性测试。

**跨设备同步（2 人日，Swift 为主）**：book/profile 是行的投影，portable memory 只需在 `workspaceProtocol.js:49-53` 增 `section/bookStatus` 可选字段；iOS 用同一规则先渲染 scope∈{personal,project} 的稳定块再做相关度召回；记忆页状态增加 `conflict`，提供"采用桌面版/采用手机版"；book 行以 `subjectKey` 去重优先于文本。

**2A 剩余 + 可见性（2 人日）**：回复底部"参考的记忆"展开；每条"记到项目 / 记成个人 / 停止使用"；记忆页允许改 `category` 与 `pinned`（`editMemoryFact` 白名单扩展）；"停止使用"写 `memory_hits.outcome='rejected'`，gate 的 outcome 分量改为 (used−rejected)/hits；`recordMemoryFeedback` 只记录**渲染过**的候选；Hot Attic 候选池改为"按 attic='hot' 或 category/pinned 先筛再按 updated_at"而非最近 32 行（让 dreaming 的晋升真正生效，解 M3）。

**推荐路线（记忆线）**：2A 剩余 + 可见性（2 人日，给后面的自动写入纠错出口）→ 项目记忆本 + 个人档案（6）→ 远程 SQL 层 audience（1）+ Agent 名额拆分（0.5）→ 手机端渲染与冲突 UI（2）。2C 不做默认。合计 ≈12 人日。

---

## 4. 三条线的交叉依赖

- **稳定前缀是公共地基**：项目记忆本、个人档案、话题卡目录都放 `placement:'system'`；话题摘录、`read_history` 结果、逐轮召回放 turn 段。任何一条线都不应再往系统提示里放逐轮变化的东西。
- **工具集固定（A1）先于一切缓存指标**：不固定工具数组，长对话线与记忆线的"缓存命中"指标都测不准。
- **`read_history`（1D-3）与 `search_history` 共用 P0-3 的受众/项目隔离**，并受 `knowledgeMemory` 能力门控。
- **RunBudget（C1）同时约束**：工具循环、同步压缩调用、后台预压缩、成员/技能子预算。
- **结果 envelope（B1）** 让"工具事实进摘要"（1D-5）与"工具轨迹回放"（D2）有统一的 status/code 可写。
- **附件外置**同时服务：线程文件瘦身、`activeChat` 回传、手机同步、`read_history` 返回文本而非 data URL。

## 5. 统一路线图（建议三周，≈ 35 人日；可按用户选择裁剪）

| 批 | 内容 | 人日 | 产出指标 |
|---|---|---|---|
| **第一批（基础 + 止血）** | B1 envelope 统一；A1 工具集按 Agent 固定 + 原生工具后置；修 `upgradeDegradedCompact` 丢 previousSummary；压缩后台化 + `compact:running` 事件；UI 只渲染最近 60 条；2A 剩余（回复旁记忆 + category/pinned 可改 + 反馈回流 + Hot 候选池修正）；F1 审批面统一 | ≈ 9 | 工具轮 cached tokens 中位数 >60%；压缩不阻塞；1000 条渲染 ≤50ms；记忆页可改 category/pinned |
| **第二批（结构）** | 账本式话题卡 + `read_history`；项目记忆本 + 个人档案；C1 RunBudget；附件外置 | ≈ 13 | "回到 A"问答 ≥8/10；同项目对话 2 首轮含对话 1 决定；每轮可承诺上限；线程文件/回传体积下降一个数量级 |
| **第三批（延展）** | 近窗收回 48–64k + 话题摘录进 turn 段；D1+D2 调用记录与回放；远程 SQL audience + Agent 名额；协议带 compact 与 book 字段同步手机 + 冲突 UI | ≈ 10 | 500 轮平均每轮 ≤45k est；取消后"继续"可衔接；手机下一轮含摘要与档案 |
| **第四批（按需）** | E1 协议适配器（Anthropic/本地原生工具）；F2 工具自描述；F3 MCP 注册隔离；线程文件 head+JSONL | ≈ 10 | 三协议 fixture 测试通过；新工具只注册一处 |

## 6. 需要用户拍板的决定

1. **工具集固定**（A1 vs A2 vs A3）：接受每轮多 0.7–2.7k token 的工具定义以换前缀缓存？
2. **长对话主方案**：1D（不重排历史）还是原版 1B（重排）？近窗收回到 48–64k 还是保持 114k（更贵但即时引用更稳）？
3. **项目记忆本自动行**：默认进提示带 `[auto]` 标记，还是只作提议等用户确认？
4. **附件外置**：是否接受消息存储格式变更（需迁移现有线程文件）？
5. **Anthropic / 本地模型原生工具**：现在做 E1（3 人日）、先做 E2（0.5）、还是暂不做？
6. **手机端**：先同步桌面摘要/记忆本（协议加可选字段），还是手机自己摘要（1A）？

## 7. 待核与边界

- 工具定义 token 为仓库估算器（非 tiktoken），JSON 与中文系数见上轮 C-10；缓存命中率需在用户机器用执行详情对比 10 轮同对话。
- 长对话数字来自沙箱只读模拟（文本 ~530 est tok/轮、图 2048 tok/张），真实 o200k 中文按 0.6–0.75× 换算；摘要模型实际输出按 ~1k 估。
- T5 远程 bash 写入挂 120s、M8 speaker 事实覆盖、补充消息与手机同步 409 冲突：静态推断，未实跑。
- 本轮只读；没有改产品代码、没有运行 `npm test`；唯一的新发现 bug（`upgradeDegradedCompact` 不传 `previousSummary`）列入第一批修复。
- **已落地 · 1D 长对话（固定近窗 + 账本式话题卡 + 原文读回 + 话题摘录）**。1D-1：`contextBudget.js` 新增近窗上限 `DEFAULT_NEAR_WINDOW_TOKENS=64k`（`MELO_HISTORY_WINDOW_TOKENS` 可覆盖，仍受 0.75 份额约束），云端模型原文历史从 114k 收回到 64k，压缩随之提前；后台预压缩与 `compact:running` 已在第一批落地。1D-2：新模块 `src/memory/compactLedger.js`——每次压缩只为新 chunk 生成一张卡 `{id,title,summary,fromMessageId,toMessageId,messageCount,at,source}` 追加到 `chat.compactCards`，`compactSummary` 改为卡片的渲染（下游提示段、线程检查点、state 水合、手机同步都继续读同一字段）；渲染超 6000 est tokens 时最旧卡折叠成一行标题并指向消息范围；旧单槽 `compactSummary` 在下次压缩时迁移为一张历史卡；摘要背景只喂卡片目录（标题+首行），不再把旧摘要整体回灌；`upgradeDegradedCompact` 只替换最新的降级卡。摘要提示改为"一张话题卡"格式（首行 `# 标题`，逐字保留数字/路径/标识符/用户纠正，列出关键消息 `[#id]`），转录逐条带 `[#messageId]`。1D-3：新工具 `read_history`（`src/tools/builtins/readHistoryTool.js`，能力 knowledgeMemory，核心组）按 `fromMessageId/toMessageId/aroundMessageId` 读原文 ≤8k tokens 并给续读 id；受众/项目隔离同 search_history（渠道只能读本对话；桌面默认本项目，`scope="all"` 跨项目）。1D-4：`src/services/chat/topicExcerpts.js` 按当前消息与卡片的词/CJK 二元组重叠选 ≤2 张卡，取其原文 ≤1500 tokens/卡，作 `reference('topic-excerpts', …, 85, 4000)` 进 turn 段，并发 `history:excerpts` 执行事件。1D-5：`projectToolResultForPersist` 多存 ≤200 字 `summary`（水合保留，连同 `status:'empty'`），压缩转录与 read_history 输出都带 `[Tools used] …` 行。验证：`compactLedger.test.js`、`readHistoryTool.test.js`、`topicExcerpts.test.js`、`contextBudget.test.js` 更新。未做：卡片的 UI 查看/编辑（`userEdited` 字段已预留）、chunk 边界优先用 frames 边界。
- **已落地 · C1 RunBudget**（`src/runtime/runBudget.js`，纯模块 + 虚拟时钟测试）：`createRequestContext` 默认为每个上下文挂 `budget:{deadlineAt,maxInputTokens,maxToolCalls,used:{inputTokens,toolCalls,providerCalls}}`（桌面默认 20 min / 400k 输入 / 120 次；`MELO_RUN_DEADLINE_MS` / `MELO_RUN_MAX_INPUT_TOKENS` / `MELO_RUN_MAX_TOOL_CALLS` 可覆盖；派生上下文共用同一个预算，进入 runner 时 `armBudget` 把排队等待的时间还回来）。runner 的 `createReply` 包装层给每次模型请求（含同步压缩、核验、意图判定）传 `timeoutMs=min(600s, 剩余)`（`openai.js` 新增 `timeoutMs` 选项），按供应商 usage 累加输入 token、无 usage 时用 `estimateMessagesTokens` 估算；每次模型调用前查 `budgetExhausted`，超限则发 `budget:exhausted` 执行事件并以「这轮对话已达到运行预算（原因），已停止。你可以发送“继续”接着做。」收尾，不再发请求。执行器：工具超时 `min(tool.timeout, 剩余)`，每次调用计数，超限直接返回 `BUDGET_EXHAUSTED` envelope（已加入 `TOOL_ERROR_CODES` 与 `toolCodeHint`）。成员/技能/团队：`narrowBudget(parent, child)` 取各上限的 min、共享截止时间，子预算用量同时记到父预算；成员 `timeoutMs` 与团队 `maxMinutes` 计时器都 ≤ 父剩余，团队 `maxTokens` 语义保留并被父预算封顶。C3（把 `budget.used` 推到执行面板）未做，事件里已带 `budget.usage`。
- **已落地 · 2B 项目记忆本 + 个人档案**（用户拍板：自动行默认进提示并带 `[auto]`）。新模块 `src/services/project/projectMemoryBook.js`（`BOOK_SECTIONS`、`sectionForCategory`、`listProjectBook`、`renderProjectBook` 按节分组、组内 user > confirmed > auto 再 updatedAt desc、≤2000 est tokens 溢出先丢 auto 的 technical_detail/file 行、`planBookSupersession` 同 `subjectKey` 命名空间级替代且 user/confirmed 永不被 auto 替代——冲突的 auto 行打 `needsConfirmation` 并渲染 `[auto][待确认]`、同文本不重复写入也不复活已停止的行）与 `src/services/memory/personalProfile.js`（scope=personal、category 限 correction/identity/user_preference，correction > identity > user_preference，同 subjectKey 留最新，≤15 条/400 est tokens）。写入：`reconcileChatFacts` 对本地项目对话的新 decision/project_context 事实额外写 `book:<factId>` 行（namespace `project:<pid>`、`bookStatus='auto'`、保留 sourceChatId/sourceMessageId/subjectKey；替代记录同时写 `supersededByFact`=文本与 `supersededById`）；`editMemoryFact` 白名单新增 `section`/`bookStatus`（后者只接受 `confirmed`），改 scope=project 即 confirmed，改 scope=personal 时非档案类别并入 user_preference；项目页手写行走 `POST /api/projects/memory-book`（`bookStatus='user'`，无来源对话，`reconcileLegacyFacts` 以项目存在与否判定隔离）。提示位置：`systemPrompt.js` project 段之后 `reference('project-memory', …, 104, 2000, 'system', required)` 与 `reference('personal-profile', …, 106, 400, 'system')`；runner 只对本地非远程对话且 Agent 未关记忆时渲染，行以 `kind:'project-book'/'personal-profile'` 进 `memoryRendered`（`memoryUsage` 与 useCount 记账）并加入 `excludedFacts`；Hot Attic 的 namespaces 去掉 `project:`。store：`iterateMemoryRecords` 支持 `namespace` 过滤，`book:` 前缀与 `promoted:` 一样不被快照重建删除。UI：项目页「记忆本」分节列表（状态徽章 auto/已确认/手写、待确认、确认/改节/停止使用/恢复、来源对话、手写一条），`desktop-ui/projectMemoryBook.js` 纯渲染；回复底部“参考的记忆”对 book/profile 行同样提供记到项目/记成个人/停止使用。协议：`shared/protocol/sync.schema.json` memory 记录新增可选枚举 `section`/`bookStatus`，已重新生成 `syncContract.generated.js` 与 iOS `SyncWorkspace.swift`，`portableMemory` 导出/导入透传（iOS 渲染与冲突 UI 仍属第三批）。验证：`projectMemoryBook.test.js`、`personalProfile.test.js`、`projectMemoryBook.scenario.test.js`（项目 P 对话 1 抽出 decision → 另一 Agent 的对话 2 首轮 systemPrompt 含 `- [auto] …` 且只出现一次；远程对话与无项目对话不含）、`memory-isolation.test.js` 远程属性、`systemPrompt.test.js` 位置/优先级、`desktop-ui/projectMemoryBook.test.js`、`mobile-sync/memory.test.js` 往返。未做：dreaming `supersede.js` 未扩展（替代逻辑在新模块内，仅在写入时执行，不做后台重扫）；记忆页列表尚未显示 section/bookStatus 徽章（投影字段已带）；auto 行“只在对话开始与用户确认时刷新”的可选策略未做。
- **已落地 · D1+D2 调用记录与回放**。D1：新模块 `src/tools/toolInvocationRecord.js`——runner 工具循环在 `functionSession.append` 之后为每次调用生成 `{version,runId,iteration,callId,toolId,argsRedacted,argsHash,resultEnvelope:{ok,status,code?,hint?,outputPreview≤500,meta?(脱敏、≤2000 字 JSON)},modelFacingOutput(≤8000；原生协议取 `functionCallOutputs[call_id].output` 原字节，legacy 用同一 `formatToolResult` 重建),startedAt,finishedAt,durationMs,parallelGroup}`，`appendToolInvocationRecord` 同步追加到 `<home>/desktop/execution-scenes/<runId>.tools.jsonl`（目录 0o700、文件 0o600、永不抛出，失败记 `failureCounters` `tool:invocation-record`），`readToolInvocationRecords(runId,{home})` 读回。`redactToolArgs`：键匹配 `/key|token|secret|password|authorization|cookie/i` 置 `[redacted]`、字符串截 400、`data:` URL 变 `data:<mime> (<n> bytes)`、二进制/循环安全；`argsHash`=原始 args 规范化 JSON 的 sha256 前 16 位。三投影：`tool_calls_start` 改发 `redactToolArgs(arguments)`；`tool_calls_done` 由 record 投影（`id/name/status/argsHash/durationMs`，失败时 `errorCode` 回退到 envelope code）；`projectToolResultForPersist(call,result,record)` 多存 `argsHash`/`durationMs`（`normalizeToolResultsForHydration` 白名单）；`observeTool` 的 `input` 改走同一脱敏（可选 `record` 参数带 `durationMs`）。执行器 `executeToolCalls` 每项多返回 `startedAt/finishedAt/parallelGroup`（每次并行 flush 或串行调用一个组号）。循环在一批工具记录落盘后 `signal?.throwIfAborted()`：取消后不再发下一次模型请求。UI：`activeToolCallsStrip` 胶囊显示脱敏参数摘要（前两个标量键、值截 48）与完成后的耗时（`app.js` 从 `tool_calls_done.durationMs` 取一行）。D2：新模块 `src/services/chat/toolTraceReplay.js`——`buildToolTraceText(records,{status})` 生成 `[工具轨迹] 本轮已取消/失败/完成，之前已执行 N 次工具调用（可据此继续，不必重复）：1. 工具(键=值…) ✓|○ empty|✗ CODE；…等 N 次`（≤600 字、最旧在前）；`sendChatMessage` 外层 catch（取消/失败）调用 `persistToolTrace`：本轮已有留在历史里的助手消息（部分图片回复）则追加到其 `content`，否则新增 `{role:'assistant',kind:'tool-trace',content,metadata:{runId,toolTrace:{status}}}`；供应商失败路径的失败文案本身被 `contextFilters` 过滤出历史，所以轨迹作为单独的 tool-trace 消息与失败消息同一次原子写入（排在失败消息之前）；`MELO_TOOL_TRACE_ALWAYS=1` 时成功且 ≥1 次调用的轮次也写（排在回答之前）。`normalizeChat` 保留 `kind:'tool-trace'`；纯文本无 call_id。验证：`toolInvocationRecord.test.js`（脱敏/哈希稳定/上限/jsonl 0o600 读写/不可写目录不抛出）、`chatExecutionRunner.test.js` 新增一测（3 次原生调用 → 3 行 jsonl、`modelFacingOutput` 与发回模型的 `functionCallOutputs[i].output` 逐字节一致、`tool_calls_start` 与全部 SSE 无明文 apiKey）、`toolTraceReplay.test.js`（真实 `sendChatMessage` 读一次 `file_read` 后取消 → chat 含带文件名的 tool-trace 消息；下一轮经 runner 的模型请求历史含该轨迹且不含 call_id）、`toolResultProjection.test.js`/`stateHydration.test.js`/`activeToolCallsStrip.test.js` 补充；`memory-isolation.test.js` 不回归。边界：仓库目前没有 `execution-scenes/*.json` 的过期清理代码，`*.tools.jsonl` 与场景文件同目录同名前缀，将来加清理时按 `<runId>.*` 一并删除即可；取消发生在模型请求中（而非工具执行后）时，该轮之前各批的记录已在盘上，轨迹同样可用；记录目前不含 MCP/成员子循环内部的调用（它们经 `subAgent`/`skillExecutor` 自己的循环）。
- **已落地 · 远程 SQL audience + Agent 名额**。SQL 层：`store.js` 新增 `memoryAudienceSQL(audience, prefix)` / `normalizeMemoryAudience` / `DESKTOP_MEMORY_AUDIENCE`，与 forgotten/validTo 同层接入 `buildRecallQuery`（带 `audience`）→ `keywordRecallRows`（FTS 与 LIKE 回退）、`knnRecall`（ANN 子查询）、`recallMemories` 语义路径的按 id 回取、`recallMemoryGroups`（候选池与补召回的 COUNT）、`recallMemoriesTiered`（三层 ANN 的 fetchByIds 与词法回退）；谓词：audience 为远程渠道名时排除 `json_extract(metadata_json,'$.audience')='local'` 的行，且 `project:*` / `agent:*` / `user:local` 命名空间里**缺 audience 的行视为 local**（快照写入的 task/approval 行没有 audience），`chat:*` / `speaker:*` 的无 audience 行（远程对话自己的 prompt/frame/scene）仍可见；`'desktop'` / `'local'` / 省略 = 看全部。调用方：`injectHotAttic` 新增 `audience`；`buildAgentMemoryNodeContext` 新增 `audience` 参数并导出 `memoryAudienceForChat(chat,{channelId})`（owner 对话含 mobile → desktop；渠道对话 → `normalizeAudience(source)`；runner 的 `channelContext.channelId` 优先），把它传给 `recallMemoryGroups` / `recallMemoriesTiered` / `injectHotAttic`；runner 在 memory prepare 段按 `isRemoteChannel ? channelContext.channelId : (isLocalChat ? 'desktop' : chat.source)` 传入；`accept`/`canRecallMemory` 的 JS 过滤原样保留作双保险；回退路径：approvals/tasks 的 `localOrProject` 与无索引时的 state 回退对远程受众都不再继承项目级行（只看本对话）。Agent 名额：`agentMemoryContext.js` 把 6 席 `corrections` 组拆为 `agentNotes`（只查 `agent:<activeAgent>`，kinds verification-correction / session-fact / task（owner=agent，仍受 chat/project 范围）, limit 4，group accept 再校验 namespace）与 `sharedFacts`（其余命名空间，kinds verification-correction / session-fact，limit 4）；两者渲染为同一 "Relevant saved facts and corrections" 块内的两个带标题子块（`AGENT_NOTES_HEADING` / `SHARED_FACTS_HEADING`，task 行沿用 task 格式并被 tasks 组去重），section 仍是 `reference('memory', …, 80, 5000)`，行照常进 `onRecall` → `memoryRendered`。验证：`memory-isolation.test.js` 新增属性测试（project/user:local/agent/desktop chat 的 local 行 + 无 audience 的 task/approval 行 vs telegram 对话自己的行：`recallMemories` 三种 query × preferHot、`recallMemoryGroups`、`recallMemoriesTiered`、`injectHotAttic`、tiers 开/关的渲染结果与 `onRecall` 均无 local 行，桌面对话仍全见；state 回退只见本对话）、`agentMemoryContext.slots.test.js`（4/4 名额、他 Agent 命名空间不出现、子块顺序与召回顺序一致、无 notes 的 Agent 不借席、远程对话只见自己的 chat 级纠错）。边界：谓词按命名空间前缀判断"桌面来源"，`chat:` 命名空间下另一桌面对话的无 audience prompt 行不在 SQL 层拦截（依赖查询集合从不包含他对话的 `chat:` 命名空间）；memory 行的 audience 值目前只有 `local`/`remote`，不区分渠道间（telegram 的行对 discord 对话仍由 `canRecallMemory` 的 chatId 条件隔离）；Chroma/LanceDB/HttpProxy provider 的 `search` 未接 `audience`（仅 sqlite-vec 路径）。
- **已落地 · E1 协议适配器层**。`functionCalling.js` 的 `native` 布尔改为 `protocol:'responses'|'chat-completions'|'anthropic'|'xml'`（`native` 保留为派生 getter `protocol!=='xml'`，`supportsResponsesFunctions` 语义不变）；解析规则在新纯模块 `src/tools/toolProtocol.js` 的 `resolveToolProtocol(config, env)`：`toolCalling:'legacy'` 永远 → xml；Codex / `apiProtocol:'responses'` / api.openai.com（非 local）→ responses；`apiProtocol:'anthropic'` 或 api.anthropic.com → anthropic；其余 chat-completions（DeepSeek/Qwen/Ollama/本地）**默认仍走 xml**（本地模型质量参差），只有 `config.toolCalling === 'native'` 或服务进程环境变量 `MELO_CHAT_TOOLS=1` 才启用原生 `tools/tool_calls/tool role`。协议中立中间表示 `{role,text,toolCalls[{id,name,arguments}],toolResults[{callId,name,output}]}`：`parseAssistantResponse(raw, protocol)` 把三种供应商回复解析成 IR，`toLoopMessages`/`renderToolMessage`/`toRequestMessages` 把 IR 渲染回各协议请求形状；session 的 `definitions`/`requestOptions()`（新增 `toolProtocol`）/`parse`/`append` 内部按协议分派，runner/subAgent/skillExecutor 循环未重写。responses 路径快照测试保证定义、解析结果与 `responseItems`/`functionCallOutputs` 链逐字节与改造前一致。定义按协议从同一 `compileFunctionTool` 生成：responses 继续 strict schema；anthropic `tools:[{name,description,input_schema}]` 与 chat-completions `tools:[{type:'function',function:{name,description,parameters}}]` 发原始（非 strict）schema，参数按原始 schema 校验（`parse(raw,{strict:false})`，可省略可选字段、可选字段传 null 自动丢弃）。Anthropic（`providers/anthropic.js`）：`tool_choice:{type:'auto'}`，`cache_control:{type:'ephemeral'}` 放最后一个工具定义 + system 末尾 + 最后一条 assistant 的末块（共 3 个断点）；解析 `tool_use` 块（流式按 `content_block_start`/`input_json_delta`/`content_block_stop` 组装 input，`stop_reason:'tool_use'` 视为完成，无 tools 时未请求的 tool_use 仍报错）；结果以 `{role:'user',content:[{type:'tool_result',tool_use_id,content:<toolOutput() JSON>}]}` 回流；带 tools 时返回 `{protocol:'anthropic',text,content,stopReason}`。流式与非流式都支持工具轮，未退化为非流式。chat-completions（`openai.js` + `providers/streams.js` 的 `readChatCompletionsSseResponse({returnToolResponse})`）：解析 `message.tool_calls[]`（流式 `delta.tool_calls` 按 `index` 累积，`finish_reason:'tool_calls'` 视为完成），assistant 消息的 `tool_calls` 以供应商原对象回灌历史，每个结果一条 `{role:'tool',tool_call_id,content}`；返回 `{protocol:'chat-completions',text,message}`。`openai.js` 路由改为按 `toolProtocol` 分派（无 `toolProtocol` 但有 `functionTools` 仍按历史行为走 responses）。持久化：runner 每轮 `functionSession.turnRecord` 生成 IR（参数用 `redactToolArgs` 脱敏、输出 ≤1500 字、整条 ≤24k 字、超出先丢最旧轮），`buildToolChainRecord` 作为 `metadata.toolChain {version:1,protocol,turns,truncated}` 随助手消息落盘（`toolResults` 投影不变）；`buildModelMessagesFromChat(chat,{toolChainProtocol})` 用 `toolChainToMessages` 把记录渲染回任一协议并排在该条回答正文之前；**默认关闭**（历史仍只含正文，与改造前一致），`MELO_TOOL_CHAIN_HISTORY=1` 或 `config.toolChainHistory===true` 时按当前连接协议渲染。call id 只在产生它的对话内读取，`portableWorkspace`/手机同步不带 `toolChain`。`contextBudget.requiredIndices`、`compactToolChain`、`tokenEstimate`、`modelFacingOutputsFor` 均识别 `toolCalls/toolResults`；`tools/systemPrompt.js` 原生说明（含 `TOOL_RESULT_CONTRACT_NOTE`）对三种原生协议生效，仅结果项名称随协议变化（function_call_output items / tool_result blocks / tool-role messages），XML 规格只在 xml。验证：`src/tools/toolProtocol.test.js`（解析规则、按协议定义、三协议 IR 往返、responses 字节快照、Anthropic 流式 tool_use 组装与 cache_control 位置、chat 流式 tool_calls 累积、持久化链重建到四种协议）、`src/services/chat/toolProtocol.integration.test.js`（真实 HTTP：anthropic / chat-completions（opt-in）/ chat-completions 未 opt-in 仍 XML / responses，各断言请求体形状、第二轮结果形状、`toolChain` 可重建到其他协议且 call id 不出对话）；`memory-isolation.test.js` 与既有 function-calling 集成测试不回归。边界：真实 Anthropic 10 轮 `cache_read_input_tokens>0` 需在用户机器核；默认 history 不含链，所以“切供应商继续”目前靠开关或 D2 文本轨迹；`skillExecutor`/`subAgent` 经同一 session 自动获得三协议，但它们的 loop 消息不落 `toolChain`。
- **已落地 · F3 MCP 注册隔离**。新模块 `src/tools/mcpRegistry.js`：stdio MCP 工具只注册到这里（`registerMcpTool` / `unregisterMcpServer` / `getAllMcpTools` / `toolsForAgent(profile)` / `resolveMcpFunctionName` / `indexMcpTools`），`src/mcp/manager.js` 的 `connectMcpServer` / `disconnectMcpServer` 不再碰全局 `registry`，`getAllTools()` 永远不含 `mcp:*`。`tool.id` 保持 `mcp:<server>:<tool>`（能力校验 `toolCapabilityAllowed`、审批、UI 不变）；模型看到的函数名改为可读的 `tool.functionName = mcp__<server>__<tool>`（非 `[A-Za-z0-9_]` 替换为 `_`），只有超过 64 字才变成 `mcp__<server>__<sha1 前 10 位>`（server 段按需截断），清洗后同名的第二个工具也退到哈希形；`functionSchema.compileFunctionTool` 优先用 `tool.functionName`（其余工具仍走 `functionName(tool.id)`），session 的 `byName` 反查回 `tool.id`。runner prepare 在 `skillTools` 之后取 `mcpTools = toolsForAgent(activeAgentProfile)`（白名单沿用 `capabilities.mcpServers` / `enabledMcpServerIds`，默认拒绝），并入 `allowedTools`（全局注册表里若仍有 `mcp:` 工具也照旧被 `filterMcpToolsForAgent` 过滤）；graph state 带 `mcpTools`，dispatch 用 `indexMcpTools` 同时按 id、函数名及 XML 解析器的规范化形（小写、`-`→`_`）解析，`allowedDispatchTools` 同样合并；团队/成员/技能通过 `extraTools:[...skillTools,...mcpTools]` 拿到工具对象（`delegate.js` 的 `toolObject` 与 `subAgent.resolveAllowedTools` 已读 `extraTools`；成员白名单仍由 `intersectCapabilities` 的 `mcpServers` 收窄；`skillExecutor.resolveSkillTools` 新增 `extraTools` 参数且只接受 `mcp:` id，技能仍不能调技能）。验证：`src/tools/mcpRegistry.test.js`（命名/清洗、64 字阈值与哈希稳定、反查、清洗碰撞、按 Agent 过滤默认拒绝、两个 Agent 并行准备得到不相交集合且各自 session 对对方工具报 `UNKNOWN_TOOL`、`buildMcpTool.run` 仍以原名调用 client）、`chatExecutionRunner.test.js` 新增一测（mcpRegistry 工具不进全局注册表；白名单 Agent 以 `mcp__probe_srv__echo` 与 `mcp:probe-srv:echo` 都能调用，未授权 Agent 既看不到也调不到）；`src/mcp/*.test.js`、`functionCalling.test.js` 不回归。边界：XML 协议的提示仍按 `tool.id` 列出工具（模型照旧写 `mcp:server:tool`）；成员/技能子循环内解析 XML 调用仍按 id 精确匹配（之前即如此）；`capabilityMigration` 的 `lostTools` 本来就排除 `mcp:`。
- **已落地 · 手机 compact 同步（手机对齐）**。协议：`shared/protocol/sync.schema.json` 新增 `$defs.compact`（`boundaryMessageId`(messageId)、`compactedCount`(≥1)、`source` ∈ cloud/local/rule、`at`、`summary` ≤8192 UTF-16、可选 `cards[]` ≤200 张，每张 `{id,title≤200,summary≤2048,fromMessageId,toMessageId,messageCount,at,source}`）并挂到 `conversation.compact`（可选，旧客户端照常校验），已重新生成 `syncContract.generated.js` 与 iOS `SyncWorkspace.swift`（`--check` 通过）。`workspaceProtocol.js`：`portableCompact` 校验枚举/尺寸/边界 id，`preferCompact(current,incoming)` = `compactedCount` 大者胜、同数取 `at` 晚者、永不后退，`compactAdvances` 判断是否推进；`validateWorkspace` 对 `conversation` 记录做 `coalesceConversation`——并发版本若只有 `compact` 不同，直接按该规则合并为一版（clock 取并），不再成为用户冲突；其它字段不同仍是冲突。桌面：`portableWorkspace.exportCompact(chat, previous)` 由 `compactBoundaryMessageId/compactedMessageCount/compactSummary/compactSummarySource/compactedAt/compactCards` 组装（边界消息不在对话里则不导出；summary/卡片超限按 UTF-16 截断且不切代理对；与上次同步记录比较后取推进者），`refreshPortableWorkspace` 的 `put('conversation', …)` 带 `compact`；导入 `applyPortableWorkspace` 对 `conversation` 记录调用 `applyCompact(chat, incoming)`——只在 `compactAdvances` 且本机有该边界消息时写回 chat 的六个 compact 字段（在 `updateStateAtomically` 内随导入一起落盘，`persistCompactSnapshot` 的"count 不后退"守卫与之一致）。iOS：`MobilePreferences.chatCompact:[String:SyncValue]?`；`WorkspaceProjection` 导入 `conversation` 时按同一规则（count 大者/同数 at 晚者）写入，导出时把本机存的 `compact` 原样带回（不带则旧值不会被手机覆盖）；`ConversationHistory.recentTurns(afterMessageId:)` 只取边界之后的消息（边界不在本机历史则不变），`compactContext(compact, messages)` 返回边界后消息与 ≤8 KB 的摘要块（无 summary 时由 cards 拼接），`ChatStore` 发请求前把摘要块放在 instructions 之前、历史改用边界后消息。验证：`mobile-sync/workspaceProtocol.test.js` 新增校验/合并规则测与往返测（桌面导出 → `validateWorkspace` → 另一端 `importMobileSnapshot` 应用更大 count；更小/同数更早的快照被忽略；缺边界拒绝；超长 summary 截到 8192；上次同步记录领先时保留）；`shared/protocol/contracts.json` 新增 `compactSync` fixture，`crossPlatformContracts.test.js` 与 `ios/Tests/SharedContractTests.swift` 各加断言（wire 校验、边界后消息 id、未知边界保留全部历史）。未做/边界：手机自摘要（离线超窗本地摘要写回）未做，`source:'local'` 已在协议里预留；snapshot 的 `chats[].messages` 文本层不带 compact（只走 workspace 记录）；iOS 代码未在此环境编译，需在 Xcode 验证。
- **已落地 · 记忆冲突 UI（跨设备同步）**。`portableMemory.applyPortableMemory`：(a) 单版本到达但桌面行与来件文本/scope 不同、双方 `userEdited` 且桌面 `editedAt` 晚于来件 `updatedAt`（`hasMemoryConflict`）→ 不覆盖，桌面行保持 active，来件存为 `metadata.conflict = {text,scope,editedAt,source:'mobile'}`；桌面自身值再次同步回来不会清掉待处理冲突；(b) 并发多版本（原 `mobileSyncConflict` 路径）保留工作区级标记，并把非桌面版本同样写入 `metadata.conflict`，同步冲突页选桌面版后两者一起清除。投影 `memoryManagement.memoryFacts` 新增 `status:'conflict'`（优先于 historical）与 `conflict` 字段。`editMemoryFact(id,{resolveConflict:'desktop'|'mobile'})`：`mobile` 用 `metadata.conflict` 的 text/scope 替换，两者都删除 `conflict` 并置 `mobileSyncConflict=false`；`updateMemoryFact` 改为 async，解决冲突时同时用 `resolveWorkspace` 收敛工作区 memory 记录（否则下次同步会重新标记），路由已 `await`。UI：`desktop-ui/memoryFacts.js` 对 `status==='conflict'` 显示「冲突」徽章、并列桌面版/手机版两段文本（含范围与手机修改时间）与「采用桌面版」/「采用手机版」按钮（`data-action="memory-fact-resolve-desktop|mobile"`），`app.js` 的 dispatch 与 `handleMemoryFactAction` 接入（`POST /api/memory/facts/update {id,patch:{resolveConflict}}`），样式 `.memory-conflict-badge` / `.memory-conflict`。验证：`src/services/chat/portableMemory.conflict.test.js`（判定规则、单版本冲突→投影 conflict→两种解决→无冲突时报错、并发版本→解决后工作区记录收敛、同步冲突页选桌面版清标记）、`desktop-ui/memoryFacts.test.js` 新增徽章/按钮/转义测；`mobile-sync/memory.test.js` 不回归。边界：iOS 端仍只显示工作区冲突列表，没有行级「采用桌面版/手机版」；`subjectKey` 去重优先于文本的 book 行规则未在此批实现。
