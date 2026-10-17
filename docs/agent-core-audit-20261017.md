# Agent Core：Loop、State、Memory / Context 与能力清单

日期：2026-10-17。源码基线 `bb9a9c3`，分支 `codex/mobile-use-features`。用户认可共用 Core / 平台 Adapter 的方向，要求先检查现有循环、状态、记忆和实际能力。本轮完成检查及隔离探针，没有迁移或修复生产实现。

## 1. 结论与发现

已有停止、权限、持久化和隔离机制；不能说没有 Loop 或必然无限执行。但当前三端实现仍分叉，且确认了五项应在 Core 抽取前处理的问题。

### F1 · P1 · Skill Match Cache 缺少作用域与完整定义身份

- 代码：`src/agents/skillMatcher.js:255,275,337`、`src/agents/skillMatchCache.js`。
- key 使用消息前缀、Skill ID / updatedAt 或 version / Prompt 长度及少量选项；不含 home，也不覆盖 Prompt 内容、toolWhitelist 等完整定义。进程级 singleton 保存的是 Skill 对象数组，命中只复制数组，返回旧对象。
- 实际调用生产 matcher：home A / B 使用相同 ID、version、Prompt 长度，不同 Prompt / whitelist。B 命中返回 A 的对象；关闭 Cache 则返回 B。数据全为 Fixture，没有读取真实 Skill 或跨用户资料。
- 影响：跨 home 或定义身份碰撞会选择错误 Prompt 和元数据。这里证明的是对象串用，不能外推已经绕过后续 Capability 交集或发生真实资料泄露。
- 建议：按 home / 执行 scope 分区，以不可变完整定义的 revision/hash 标识内容；缓存匹配 ID / 分数，命中后从当前 Registry 取定义。补同长度编辑、不同 home / Agent scope 回归。

### F2 · P2 · RepeatGuard 限制 executor 重试，没有阻止无效模型往返

- 代码：`src/agents/repeatGuard.js`、`src/services/chat/chatExecutionRunner.js:634,654,672,779,901`。
- 生产 Chat Runner 注入持续相同调用的假模型：永久失败得到 **10 次模型请求 / 2 次 Tool 执行**；相同成功读取得到 **10 次模型请求 / 10 次 Tool 执行**。两者都到上限后诚实返回未完成。
- 不是无上限循环；问题是失败被本地拒绝后仍让模型反复请求，成功但没有新信息时也缺少通用 Progress / Completion 判定。Fixture 证明这条路径可发生，不代表真实模型每次都如此。
- 建议：共用有界改策略与无进展状态；达到条件先允许一次收尾，仍重复则停止。避免将任意 Tool 成功当成业务目标完成；写动作还需独立的重放 / 幂等控制。

### F3 · P2 · Android Context 截断及 Memory 拼装缺少检索与预算协调

- 代码：`android/app/src/main/java/com/melo/android/chat/ChatPhoneUse.kt:35`、`network/ModelClient.kt:42`、`data/Repository.kt:93`、`device/DeviceAgentClient.kt:47`。
- 两条 Chat 路径取最近 60 条消息并从 user 起点截断，没有增量对话摘要或针对被截断消息的召回。Fixture 的第 1 条约束位于 61 条消息开头，最终请求剩 59 条，约束消失；原始持久记录未删除。
- Repository 将符合 scope 的 Memory / Knowledge 直接全部拼入 instructions，没有按 query relevance 召回或分段预算。Tool Chat 的 instructions 上限为 32,000 字符，Fixture 确认即使当前问题只有 `hi`，过长 instructions 仍拒绝。
- Android 普通路径另有 200,000 字符合计限制，Tool history 另有 160,000 字符限制；这些不等于按所选模型 Context Window 管理全请求 Token。
- 建议：共用完整 turn 的 Token 估算窗口、增量 summary、scope + relevance 检索、Tool Schema / instructions / history 的统一预算。长对话原始记录保留。

### F4 · P2 · Android 没有跨轮 call ID 唯一性保护

- 代码：`android/app/src/main/java/com/melo/android/chat/ChatPhoneUse.kt:74`、`device/DeviceAgentClient.kt`；对照 `src/tools/functionCalling.js:85`。
- 生产 ChatToolLoop Fixture 中，假模型两轮使用相同 call_id、不同 goal；两次 invoke 都执行，history 中形成两个同 ID call/output。现有 goal 去重不等于调用身份去重。
- 回执异常时，应在执行任何副作用前拒绝，不能依赖 Provider 在下一轮拒绝无效协议链。探针没有执行实际点击 / 发送。
- iOS `DeviceToolLoop.validateBatch` 的 seen 集合也只在单批内；`ChatGPTAccount` 跨轮调用没有相同的 seen ledger。iOS 此项只有静态证据，未做 Swift 运行验证。
- 建议：共用整轮 call identity ledger；先校验全批，再执行动作。重复 Provider call ID 应直接拒绝；动作幂等是另外一层保护。

### F5 · P2 · Desktop 主 Loop 没有 end-to-end 总截止时间

- 代码：`src/runtime/requestContext.js`、`src/services/chat/chatExecutionRunner.js:672`、`src/tools/executor.js`、`src/openai.js:39`；对照 `src/agents/team.js:94`。
- 普通主 Loop 有 10 轮上限、单次模型 / 工具 timeout 和用户 signal；主 turn 没有统一绝对 deadline。Team / Member 另有自己的总计时，不能据此宣称所有调用链共用同一时间预算。
- 影响：每次单独请求都未超时，整轮仍可能运行很久。这是静态确认，没有发起真实长故障或用虚构耗时当实测。
- 建议：入口捕获 deadline 与累计用量；向模型、Tool、Skill、Member、摘要和收尾传递剩余额度；取消后仍保留现有未结束写任务的隔离。

## 2. Loop 现状

```text
Desktop：输入 -> Prepare（Scope / Memory / Context / Tools）
               -> Model -> Tool -> 临时 Context -> Model
               -> Finalize -> 消息和运行记录 Commit

Android：Chat Model -> phone_use -> Device Model
                                -> android_device -> 原生执行
                                -> finish 重新观察 -> Chat 续答
```

- Desktop Main 最多 10 轮；Skill 默认 6、最高 16；Sub-agent 默认 8、最高 20；团队另有时间与用量预算。实际 Tool dispatch 受本轮可见集合、Capability、权限、工作区和 Schema 检查。
- Desktop Responses Function Session 校验整批参数及整轮 call ID，再派发；工具结果与调用配对后返回模型，过大时压缩早期 Tool output。
- Android Chat 最多 3 个手机任务及最后一次模型整理，整段 Tool Chat 最多 15 分钟；设备任务最多 30 步 / 10 分钟。已有重复启动、3 次未解错误、连续无变化、screen freshness 与窗口检查。
- Android 的 achieved 要求显式 finish 并重新观察声明的 package / visible text。它验证可见事实，不独立证明摘要里每个餐厅评分或业务效果。
- iOS 受支持的 Phone Data Tool Loop 最多 6 轮、每轮 8 个调用；通用文件 / Shell / Android 屏幕操作不是这条链的能力。

## 3. Shared State 如何保存

当前没有三端共享的运行中 Agent State，也没有已实现的父 Agent Core。

- **单轮临时状态**：Node 的 graph / loopMessages / call ledger；Android 的 Coroutine Job、Device Context、screen generation / pixels。按 run / chat 捕获与隔离，不是所有 Agent 共用一个可变 conversation。
- **Desktop 持久化**：`updateStateAtomically` 按 home 串行写；先持久聊天 checkpoints，再以 `desktop/state.json` manifest 为 commit point。Memory / 检索与部分归档在 SQLite；派生索引失败不会冒充主数据提交失败。入口及实现：`src/state/stateStore.js:228,293,304`、`src/services/chat/turnLedger.js`。
- **Android 持久化**：Repository 的 Mutex 串行变更 AppData；Room 的 `melo.db` / `documents` 表保存一份 JSON snapshot，存储成功后发布 StateFlow。每秒保存运行 partial，设备步骤保存脱敏回执；重启将 running 变 interrupted，不自动续点。实现：`data/Repository.kt:25,33`、`data/Storage.kt:15,64`、`chat/ChatEngine.kt:69`。
- **跨设备资料**：可选 Sync 交换受 Schema 限制的 chats / workspace / tasks / handoffs。Workspace 使用版本 clock 合并并保留冲突，不能当作全局实时共享内存或完整在途任务迁移。凭证、原始屏幕、Coroutine / Promise 不进入这份 Snapshot。
- **父子成员**：Desktop 传入任务、受限背景和 Capability 交集，成员返回 structured handoff；不默认把主会话全部历史当共享工作内存。真实文件写入由 workspace writer 调度。

## 4. Memory 与 Context

```text
当前问题 -> Scope 过滤 -> Memory / Knowledge 召回
         -> recent turns + summary + instructions + Tool Schema
         -> 全请求预算 -> Model
Tool result -> 本轮临时 Context -> 下一次 Model
最终消息 -> 本机存储 -> 后置 Memory 提取 / 索引（已实现的平台）
```

- **Desktop**：有 session facts、长期事实、历史、项目知识；按 home、chat / agent / project / audience 过滤。SQLite FTS 与向量候选融合后排序 / 去重；embedding 超过约 2.5 秒降级关键词。长对话增量 summary 配合预算；默认 Cloud 配置总预算为估算 160k，输出预留默认 8k，历史窗口按剩余输入的 75% 推导，不保证任意 Provider 都有相同实际窗口。实际调用：`chatExecutionRunner.js:329,466,694`、`memory/store.js:1369`、`services/chat/contextBudget.js`。
- **Desktop 更新**：消息落盘后异步抽取 session memory / promote facts / 补索引，使用入口捕获的 home；不能把 pending 后台结果当成当前请求已可召回。实现：`sendChatMessage.js:510,518`。
- **Android**：MemoryFact 来自手动保存和 Sync。Scope 包括 personal、agent、project、chat，但没有 Desktop 同款自动事实提取、向量召回和对话摘要；目前按 scope 全量拼入。UI 文案也明确手机只用显式保存的文字记忆。Device Loop 自身会保留目标、最近画面和少量完整 call/result，属于工作上下文，不是长期 Memory。
- **iOS**：已通过 JSCore 使用同源 rule extractor，有本机 recall 与 budget；ConversationHistory 保留完整 user turn，默认 60 条与 48,000 UTF-8 byte budget。仍不等同 Node 的完整检索 / 摘要实现，本轮未编译 Swift。

## 5. 实际 Tool / Skill 清单

### Desktop Built-in：30 个 Logical ID

由生产 `bootstrapBuiltinTools()` / `getAllTools()` 枚举，包含 `agent` 兼容 alias；30 个 ID 不表示 30 个独立执行器，也不表示每轮都暴露。

- 文件 / Shell：`bash`、`file_read`、`file_edit`、`file_write`、`file_delete`、`file_move`、`file_mkdir`、`glob`、`grep`。
- Web Retrieval：`web_search`、`fetch_url`。
- Browser：`browser_open`、`browser_snapshot`、`browser_close`、`browser_click`、`browser_fill`、`browser_wait_for`。
- Memory / Knowledge：`search_history`、`knowledge`。
- 媒体 / 文档：`media_info`、`media_api`、`image`、`pdf`、`xlsx`。
- Utility：`calculator`、`clipboard`、`translate`、`reminder`。
- 协作：`delegate`、`agent`（delegate 的兼容 alias）。

还可动态加入 `skill:<id>` 和连接成功的 `mcp:*`。Hosted `web_search` / `image_generation` 由 Provider 路径声明，不额外计入上述静态 Built-in。最终集合受 SearchPlan、Agent Capability、连接、平台和审批约束。本轮没有读取用户 Mac 的活动实例或 MCP 连接，所以不能将源码清单说成用户当前每轮实际暴露清单。

### Android：Chat 1 个 Tool + Device 子任务 1 个 Tool

- Chat：`phone_use(goal, purpose=research|action)`。
- Device：`android_device(action, ...)`。
- 10 个 action：`observe`、`list_apps`、`open_app`、`tap`、`type_text`、`swipe`、`back`、`home`、`wait`、`finish`。
- 无 `web_search` / `fetch_url`、Desktop Skill loader / registry 或 MCP executor 接入。list_apps 搜可启动 App；Task Cache 重放流程，不能替代实时检索。

### Skill

- Desktop 代码中定义 4 个 Built-in：`skill-creator`、`project-planner`、`connector-builder`、`artifact-curator`。都是轻量 Prompt 定义、type executable，默认各自最多 6 轮；folders 字段不证明磁盘真有对应完整脚本和资料。
- 可以追加 JSON `customSkills` 或 `<MELO_HOME>/desktop/skills/<id>/SKILL.md`。按 Agent 授权及 Trigger / Name / Tag / Description 等相关性匹配，再包装为 Tool 执行；没有检索匹配不等于执行了 Skill。源码：`src/domain/skill/skillService.js`、`src/agents/skillsDisk.js`、`skillMatcher.js`、`skillExecutor.js`。
- Android 只有硬编码 Phone Use 策略，尚无可扫描 / 安装 / 选择的完整 Skill 系统。它不是从 Desktop 同源 Skill Registry 加载的。
- iOS 有独立原生数据 Tool：`calendar_list_events`、`calendar_create_event`、`reminders_list`、`reminders_create`、`reminders_complete`、`contacts_search`、`location_current`；部分 Provider 路径有 Hosted Search / Image。未见 Desktop SKILL.md executor 接入。
- Melo 的以上 Skill 与 Codex 当前会话列出的外部 skills 是不同清单；本轮没有读取用户自定义 Skill 内容来推断活动配置。

## 6. 验证、边界与下一步

- Node 既有目标回归 **65/65**：RepeatGuard、Skill Matcher、真实本地 HTTP Function Calling、Context Budget、home 写队列、checkpoint、Sync Protocol。
- 新 Node 诊断 **3/3**：Cache 跨 home 碰撞、永久失败 10 / 2、成功重复 10 / 10。诊断 PASS 是确认现有缺陷，不是修复验收。
- JVM **116/116**，包含 **3 个新增诊断**：60 条窗口丢旧约束、32,001 字符 instructions 拒绝短问、复用 call ID 仍执行。没有 Emulator、实机或 Swift 运行测试。
- 第一次尝试通过 Gradle init 增加诊断源目录没有进入 Kotlin 编译，旧测试为 UP-TO-DATE，未将其计作新诊断通过；最终显式加入临时测试源，核对 XML 中 3 个诊断后已删除自有临时源码。
- 脱敏结构化结果：[evidence/agent-core-audit-20261017.json](evidence/agent-core-audit-20261017.json)。本机详细探针 / 日志：`.tmp/agent-core-audit-20261017/{probes.test.mjs,probes.log,existing-node.log,kotlin/CoreAuditDiagnosticTest.kt,android-jvm-diagnostics.log,android-diagnostics.xml}`。生产文件 hash 记录在 JSON 中。
- 本轮只有检查和证据 / 文档；未修产品逻辑、调用真实模型、读凭证 / 私聊、操作手机、安装 APK、运行 CLI review / git pp 或推送；不是完整发布 gate。
- 本机 Canvas 已使用实际 SDK declarations / React types 通过 TypeScript noEmit 检查；Codex 面板打开请求返回 queued，尚无宿主实际渲染或视觉验收证据。完整 Markdown 报告与 JSON 证据不依赖 Canvas 才可读取。

下一步：先修 F1 与调用身份，随后收敛 Progress / Completion 与 end-to-end Budget；在同一组 Conformance Fixtures 下迁移 State / Context / Search / Skill 决策。Runtime spike 与三端原生功能验收必须单列，不将本文或同名接口当成已经统一。
