# Shared Loop 本地 Trace 与后续 Eval 设计

日期：2026-10-27。基准：本地 `1486dc7`。状态：设计待用户审阅；没有改动生产 Loop 或声称已开始采集。

## 1. 目标与选择

用户要求“本地 Trace 用于后续 Eval，不要只改 Android，改 Loop”。Trace 是一次真实执行的事件记录；Eval Case 则在 Trace 之外增加独立的预期结果。记录到的成功声明不能自动充当正确答案。

推荐 A：共享 Core 定义事件、校验、脱敏和 Loop 状态转移记录；各 Host 使用相同契约采集真实请求/回执并写入本机 JSONL。优点是可以检查实际执行、跨端对比并逐步形成数据集；代价是三端都需接入 Model/Tool 边界和本地 Writer。

B：只扩充 ExecutionScene / UI 日志。改动小，但展示层有截断与合并，无法证明每次请求实际包含哪些能力、结果是否回到模型，不适合作为 Eval 主数据。

C：直接接远端 Observability 服务。便于集中查看，但增加服务和账号依赖，并把私人执行数据带出本机；本次不采用。格式保留以后导出适配空间，不新增后端服务器。

## 2. 当前代码依据

- [`shared/agent/turn.js`](../../shared/agent/turn.js)：公共状态机已有 request / calls / result / feedback / complete、Tool 许可、前置条件、重复和预算终止。它目前不产生完整的持久化 Trace。
- [`src/runtime/sharedAgentCore.js`](../../src/runtime/sharedAgentCore.js)：Desktop 主循环、Subagent、Skill Executor 使用相同 Node Host，另有 Goal Check。优先在这里接共享 Trace，而非在界面拼日志。
- [`shared/agent/execution.js`](../../shared/agent/execution.js)、[`src/shared/sessionEvents.js`](../../src/shared/sessionEvents.js)：用于展示/历史上下文的投影，部分字段裁剪、事件由最终 Scene 重建，不是逐轮实际输入的原始凭证。
- [`src/tools/toolInvocationRecord.js`](../../src/tools/toolInvocationRecord.js)：已有本地 Tool JSONL、脱敏参数、模型可见输出和耗时，但缺少完整模型请求、能力快照、目标变化、权限决策和父子因果关系。
- [`shared/agent/taskReplay.js`](../../shared/agent/taskReplay.js)、[`shared/agent/taskScore.js`](../../shared/agent/taskScore.js)、[`scripts/eval-agent-tasks.js`](../../scripts/eval-agent-tasks.js)：已有确定性 Fixture 和独立 expected；不是从真实执行自动形成的数据集，也不等于真实模型能力评估。
- iOS [`SharedAgentCore.swift`](../../ios/Melo/SharedAgentCore.swift) / [`AgentLoop.swift`](../../ios/Melo/AgentLoop.swift)、Android [`SharedCoreTurn.kt`](../../android/app/src/main/java/com/melo/android/core/SharedCoreTurn.kt) / [`SharedChatAgent.kt`](../../android/app/src/main/java/com/melo/android/chat/SharedChatAgent.kt) 需要接同一事件契约。Android Device 子循环是子 Scope，不另建不兼容格式。

## 3. 接入共享 Loop 的方式

```text
Desktop / iOS / Android 的 Loop Host
    -> Shared Core：同一 Trace schema + 脱敏 + 状态转移事件
    -> 本机 Trace Writer：串行追加 JSONL + 内容快照
    -> Trace 检查 / 导出 -> 人工确认 expected -> Eval Case
```

新增 `shared/agent/trace.js` 和 Core Bridge operation；以兼容的 traced-start / traced-advance 包装现有 startTurn / advanceTurn，返回原有状态和事件 Delta，不改许可/预算/Goal 判定算法。旧 API 保持不变；生产 Host 完成迁移后必须真正走新入口，不能只增加一个未使用模块。

Core 无文件、网络和系统时钟依赖。Host 在每个真实边界提供事实，Core 负责契约校验和脱敏。Node / Swift / Kotlin 只实现 I/O、序列队列及实际 Provider/OS 回执采集，不各写一套 Trace 业务规则。

状态机事件与 Host 边界事件互补：Reducer 知道是否允许调用，Transport 才知道 HTTP 请求是否发出，Executor 才知道设备操作是否 dispatch，不能从 `ok=false` 反推出没有副作用。

## 4. 单一事件契约

每条事件包含：schemaVersion、eventId、traceId、runId、parentRunId、scopeId、spanId、parentSpanId、sequence、round、attempt、type、at、elapsedMs、data。Root Trace 对应一次用户 Turn；Child Device / Subagent / Skill 使用不同 runId / scopeId，并继承同一 traceId 和父 Span。用户下一条消息是新 Trace，可用 previousTraceId 关联，不复用上次运行身份。

Trace Controller 为同一 Root Trace 串行分配 sequence；并行 Tool 使用独立 Span，完成顺序不必等于调用顺序。所有异步任务继承入口捕获的 Trace Context、Home、Agent、Project 和 Sink，禁止在后台重读全局环境改变归属。eventId 用于写入去重，sequence 用于检查缺失与排序；不得靠 wall clock 排序推断因果。

UTC at 用于查看，monotonic elapsedMs / durationMs 用于耗时。跨进程不可比较的时钟以 parent Span 和请求/回执关联，不能直接相减。

必须记录这些事件类别：

- `run.started / run.finished`：原始目标引用、Host/应用/Core/schema 版本、配置指纹、最终原因；模型声明与验证结果分别保存。最后一条不是自动判定成功。
- `context.snapshot / capabilities.snapshot`：实际使用的对话窗口、Memory / Retrieval / Compaction 输入引用；本轮实际可见 Tool Schema、授权能力、Skill Manifest 和已加载 Skill 文本/版本。available、selected、loaded 分开；缺失字段是 unknown，不能写成空目录。
- `model.request.prepared / model.request.started / model.response / model.error`：关联输入快照、实际 Provider payload、返回解析结果和公开 Summary；区分 planner / goal-check / device / subagent；包含 Provider 协议、模型、request attempt、finishReason、可用的 usage、TTFT 和总耗时。
- `tool.requested / tool.admitted / tool.rejected / tool.dispatch.started / tool.result / tool.feedback.appended`：Tool/Call ID、模型函数名到实际 Executor Tool ID 的映射、参数和输出引用、许可/拒绝原因、执行身份、发送回模型的结果引用。requested、permitted、dispatchStarted、resultReturned、feedbackAppended 是不同事实。
- `goal.updated / goal.check / loop.transition`：目标补充、待完成项、已有 evidenceIds、continue / needs_user / complete 决策，以及 transition 前后状态、预算与停止原因。只存有界状态摘要和证据引用，不复制越来越大的完整历史。
- `cache.lookup / cache.replay / cache.publish`：候选 ID/revision、exact / similar / miss、环境不兼容原因、参数、已完成步骤、子目标验证及发布结果。App 版本/姿态是 Metadata；成功部分与整项任务结果分开。
- `trace.gap / trace.truncated / trace.recovered`：明确标记写入丢失、容量截断、重启恢复，避免不完整日志被当成完整证据。

Tool result 额外使用 effectState：`not_started / dispatched / returned / error_returned / unknown`。发起执行后超时或崩溃，结果不明就保留 unknown；不能标成未执行，也不能在离线回放中重新做真实副作用。

## 5. 真正用于 Eval 的输入快照

推荐本地采集“脱敏内容 + Metadata”，不是只有 Tool 名称和耗时。没有输入/回执内容，后续无法判定模型为何选错 Tool、漏目标或误读结果。

- 每轮保留实际送入模型的标准化 messages / instructions / tools，以及在 Provider 序列化发送边界捕获的脱敏 payload。准备好的 Schema 与真正发出的 Schema分别可核对；不能只记录 Registry 全集。
- Tool 保存脱敏的 arguments、Executor 回执，以及回填模型的实际 modelFacingOutput；结果裁剪/压缩必须单列原长度、保存长度、截断状态和变换版本。
- Tool Catalog、Skill 内容、Context Snapshot 等大对象写成去重的本机 Artifact，事件通过 contentRef / SHA256 / byteLength 关联。Hash 针对脱敏后的内容，不保存原始密钥 Hash。Schema/Skill 引用必须可以从归档读取，不能只留无法还原的 Hash。
- Provider usage 缺失写 null，并区分 provider / estimate / unknown；不能把 estimated tokens 混成实际消耗，也不能把 TTFT 缺失填 0。Fixture latency / tokens 永远带 simulated 标记。
- 秘钥、Authorization、Cookie、OAuth token、URL 敏感参数先脱敏再落盘；仅保存公开 reasoning summary，不保存或伪造隐藏思维。文字仍可能含私人内容，因此 Trace 默认本机、不进 Git、不进入 mobile-sync、不自动上传。
- 图片/视频/Base64 不内联事件。第一版默认不新增截图归档；如果没有保留下来的视觉 Artifact，该段必须标为无法完整 Multimodal Replay，不能声称视觉 Eval 可复现。后续可显式开启本机视觉 Artifact 捕获，使用同一引用格式。

每个 Run 提供 replayability 摘要：policy / text / multimodal 的可用性、缺失引用、脱敏造成的不可还原字段、截断和 Host 捕获范围。所谓 text replay 只保证捕获的文本边界，不等于环境或真实模型可重现。

## 6. 本地文件和可靠性

```text
<trace-root>/<traceId>/manifest.json
<trace-root>/<traceId>/events.jsonl
<trace-root>/<traceId>/artifacts/<content-hash>.json
```

Node：捕获的 `<home>/traces/`；iOS：App Support 下本机 Traces；Android：filesDir/traces。三端 JSONL schema 和导出格式相同，Writer 是本机 Host Adapter。

默认保存 30 天、最多 200 个未固定的完成 Trace、全目录 500 MiB；单 Trace 最多 64 MiB / 10000 events、单文本 Artifact 最多 4 MiB、单事件最多 64 KiB。达到采集上限只降低 Trace 完整性，不修改任务预算或阻止用户操作；预留元数据空间标记截断。人工固定的 Eval Case 不自动清理；活动 Trace 不因清理被删除。容量被固定数据占满时停采并提示，不能静默覆盖。

Writer 入口串行化并在任务终态排空；模型请求发出前和 Tool dispatch 前的关键事件须在对应副作用之前写入本机日志。I/O 失败会标记 trace 不完整、向本机诊断报告，不把 Agent 任务伪装成失败或成功。关键写入等待最多 100 ms，写队列最多 128 个待写事件；超限或超时后降级并标记缺口，不能因磁盘卡顿把 Agent 卡成无限等待。不能把追加成功等同于断电级持久化保证；重启时按换行边界恢复，保留损坏尾部并产生 interrupted / recovered 记录。

Trace 是诊断资料，不是恢复执行指令。重启或打开 Trace 不执行任何 Model / Network / Device Tool。UI 仍使用 ExecutionScene；可关联新 traceId，但不从 UI 重建事实。

## 7. 首批 8 个本地 Eval 场景

下列为待制作的受控场景，来源是已报告问题，不冒充已采集的真实 Trace。每个场景含成功/失败对照和独立 expected；不固定搜索页数或 Tool 调用的唯一序列。

1. **Calendar -> Venue -> Weather**：日程可唯一识别演唱会，Fixture 中场馆与天气可查；读完日程不能把原始天气目标丢掉。对照场景存在多个同名事件时应合理澄清。
2. **Brunch research -> navigation**：资料足够时给出有依据的选择，再按用户要求导航；只统计已实际读取/返回的证据，不预设必须读 N 页。未要求操作手机时不能占用屏幕。
3. **任意追问保持能力**：首句、再次重试、换地点、其他语言等都记录实际发出的 Tools/Skills；避免用措辞分支隐藏已授权能力；新消息有独立请求/Trace。
4. **UI Tree / Screenshot fallback**：结构可用时直接使用节点；结构不足才使用图像。画面过期后重新定位；真正发生页面变化时不能盲点。循环次数和截图成本可由 Trace 计算。
5. **广告干扰与恢复**：已打开 App 但内部动画变化，不抹掉打开动作成功；关闭目标改变后拒绝旧坐标；相同失败不能无限重试。动画本身不能自动当作进展。
6. **Partial success -> Cache -> reuse**：open_app 成功后即时发布，即使后续失败；下一次匹配子目标走原生 Workflow、设备模型请求为 0，并继续未完成目标。编辑/删除后的 revision 不能复活。
7. **折叠状态 / App 版本变化**：不兼容 UI 脚本不自动重放；Trace 必须说明候选被排除的原因，不能统称 miss。兼容对照应可正常重放。
8. **Cancel / timeout / provider error / restart**：没有响应、部分结果、未知副作用和未发送请求分开；关闭后不能继续 Tool；所有 Tool 请求有回执或明确 orphan/unknown，不能把缺记录当作“无副作用”。

示意摘录（不是完整 Trace，也不是可直接导入的 Dataset）：

```text
model.request.started: catalogRef=tools-v1, skillRefs=[phone-skill-v3]
tool.dispatch.started: callId=open-1, name=open_app
tool.result: callId=open-1, package=com.luna.music, effectState=returned
cache.publish: kind=action, verification=foreground-package
model.request.started: tools-v1, previousFeedbackRef=open-1-result
tool.result: callId=search-2, ok=false, code=target_not_found
run.finished: claimedOutcome=blocked, verifiedParts=[open-1], taskOutcome=blocked
```

预期必须写在 Case 的 labels / assertions 中：打开动作应保存、整任务应 blocked、后续重放不得重新 Probe 打开动作。不能从 run.finished 复制 outcome 再断言两者相等冒充质量评估。

## 8. Eval 接法与度量

阶段一只提供 Trace 检查、导出和受控 Fixture；真实运行无需先有 Dataset。后续从本机 Trace 选取并脱敏、补全依赖、人工标注 expected，再纳入版本化 Case。

- **Contract / Replay Eval**：使用录制的模型响应和 Tool Fixture，不调用真实 App/网络，重放共享 Loop，验证许可、目标延续、回执配对、停止条件和 Cache 行为。这只能证明 Harness 行为，不能证明新模型更聪明。
- **Live-model Eval（后续）**：独立模式，真实模型面对固定 Tool Fixture，允许不同合法调用路径；不按完整 Trace 字面相等评分。调用不在 Fixture 能力范围时明确 unsupported，不能返回假成功。费用和真实 usage 另计，不在本阶段自动启用。
- 核心度量：独立标注的 goal/subgoal success、错误完成率、可避免的澄清、被拒绝/重复/无进展调用、结果未回填、模型/工具/截图次数、Cache hit/miss/replay cost、token 来源及 p50/p95 Latency。Trace 不完整时相关指标是 unknown，不计成成功或零成本。

保留现有 tasks.json / eval:tasks 的确定性 Fixture gate。新录制 Case 使用独立的 versioned recorded-trace 格式，显式记录来源、脱敏/裁剪、label 状态和可回放范围；不能硬塞进当前最多 20 个 frames 的 Fixture 并截掉失败尾部。未标注真实 Trace 可以做结构诊断，不进入模型质量通过率。

## 9. 迁移步骤和验收

1. 共享 Core：Trace schema / normalization / redaction / traced reducer + Bridge；包含重复/乱序/缺事件、未知 usage、敏感值、quota、并行 Span 和 parent linkage 的确定性测试。
2. Desktop 主循环：Node Core Host 和真实 Provider/Executor 边界接线；再覆盖 [`src/agents/subAgent.js`](../../src/agents/subAgent.js) / [`skillExecutor.js`](../../src/agents/skillExecutor.js)。用本地 HTTP Model/Tool Fixture 验证磁盘 JSONL，而非只测格式化函数。
3. iOS 与 Android：PhoneCoreTurn / SharedCoreTurn 以及真实模型回执、Goal Check、Device 子 Scope、本机 Writer 接线。Node / QuickJS / JavaScriptCore 使用同一组契约 Fixture；平台未运行必须如实注明。
4. 首批 8 个场景、Trace 完整性检查与独立 labels 样例；证明不执行真实副作用的离线回放，以及跨 Home / Chat 不串写。

验收的必要条件：共享生产 Loop 和 Desktop 必须真正产生日志；主循环、Goal Check、Subagent / Skill / Device Child 可关联；实际发出的 Tools/Skills 和模型可见 Tool 回执可定位；失败/取消不丢部分成功；记录坏了不伪造通过；根本没有 Raw Artifact 时不声称可完整重放。Android 单端通过不算完成。

本次不重写 Agent 算法、不替换模型供应商、不强制固定 Research 顺序/页数、不自动采集历史聊天补伪 Trace、不上传私人数据、不引入必须常驻的后台服务。
