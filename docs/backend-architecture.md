# Melo 后端架构约定

更新：2026-10-19。范围：业务、存储、执行与 HTTP/SSE；UI 由独立任务维护。现状入口见 [Melo 总览](../MELO_OVERVIEW.md)，2026-10-13 性能/增量索引演进见 [架构验收](architecture-performance-2026-10-13.md)。本文早期夹具数字保留其原验证口径。

## 设计决定

保留模块化单体。桌面端、CLI、远程消息渠道复用同一组业务命令；不引入微服务、消息中间件或第二套事实存储。优先保证并发正确性，再收敛接口，最后拆分模块和减少写入。

| 层 | 职责与边界 |
| --- | --- |
| `server.js`、`http/` | 启动、生命周期、安全边界、HTTP/SSE 编解码与路由；业务命令不依赖这里 |
| `services/` | 对话、项目、任务、角色、设置、工作区等业务命令；按领域组织 |
| `runtime/requestContext.js` | 一次执行的 home、环境、路径、请求身份与取消信号 |
| `state/` | 最新状态事务、快照读取、兼容迁移、提交与派生索引同步 |
| `openai.js`、`providers/` | 模型调用与供应商协议解析；流解析器独立于业务命令 |
| `desktopStore.js` | 旧调用方的兼容导出入口；新增业务放入领域模块 |

抽取时先保留函数体，再单独验证行为变化。此次迁移的中间快照、函数体校验与回归日志保存在本地 `.tmp/architecture-20261006/`。历史导出和 HTTP/SSE 事件名继续兼容。

## 并发与状态写入

业务通过 `updateStateAtomically(mutator, { home })` 读取最新事实、修改本领域字段、提交；禁止业务模块直接调用整份 `saveState` 或底层提交方法。架构测试会检查此依赖边界。

每个规范化 home 有独立读写队列，防止读到提交中间态。网络请求、模型调用和用户审批等待位于事务外；本地状态变更位于短事务内。旧 `saveState` 仅保留初始化/导入兼容用途，带来源的过期快照报 `STATE_CONFLICT`，不会静默覆盖新状态。

同一 home、同一聊天的消息按顺序执行，不同聊天可以并行。调用方取消后，队列仍等底层工作退出才释放这一聊天，防止尚未停止的工具与下一轮重叠。排队期间已取消的请求不执行。

消息只追加到最新聊天；审批和任务先在事务中领取执行权。迟到的上下文压缩、会话记忆只更新自己的派生字段，检查消息边界和处理进度，不覆盖更晚的消息或摘要。

## 执行上下文

入口创建请求上下文，以 AsyncLocalStorage 传播，并在图执行和工具调用处显式传递。环境快照和 home 在入口绑定；聊天配置在入队时读取，工作区在开始执行时绑定，后续阶段复用。执行中改变全局环境或其他聊天设置不会把旧请求写到另一数据目录。

身份字段：`requestId` 表示调用方的一次逻辑提交，`runId` 表示其执行，`chatId` 表示所属会话。带相同 home、聊天与请求 ID 的重试使用稳定运行 ID。

权限请求保存原始工具、聊天和执行上下文。跨 home 或工具不匹配的回复被拒绝；重复审批只应用一次。会话级授权按 home 与聊天隔离。

## HTTP/SSE 与重试

`POST /api/chat/send` 和 `POST /api/chat/send/stream` 共用参数校验与业务命令。请求可携带 `requestId`，响应增加 `x-request-id`、`x-run-id` 以及关联字段，原响应字段继续保留。

客户端要实现安全重试，应在首次发送时生成请求 ID，并在重试时复用。旧客户端省略 ID 仍可工作，但后端无法判断两个独立 HTTP 请求是否是同一次提交。

| 情况 | 行为 |
| --- | --- |
| 相同聊天、ID、内容已完成 | 返回已存回复，`replayed: true`，不重新执行工具；跨服务重启有效 |
| 相同 ID、不同内容 | `REQUEST_ID_CONFLICT`，HTTP 409 |
| 相同 ID 的执行已取消、失败或中断 | `REQUEST_INTERRUPTED`，HTTP 409；调用方检查已发生的效果后明确创建新请求 |
| 请求参数或 JSON 无效 | HTTP 400；流开始前完成参数校验 |
| 已提交回复被删除 | `REPLY_UNAVAILABLE`，HTTP 410 |

SSE 保留 `started`、`delta`、`reasoning`、`done`、`error`、`aborted` 等事件。流已经开启后的业务错误通过 `error` 事件传递，不能再改变 HTTP 状态。错误载荷包含 `error`、`code` 与关联身份。

工具审批事件的 `requestId` 继续表示审批 ID；聊天提交 ID 使用 `turnRequestId`，避免破坏现有 UI 的审批回复。流传输不保证断线续传 token；完成后重试返回整条已存回复。

请求账本与助手消息在同一事务完成。它防止已完成请求因响应丢失而再次执行；不宣称外部系统的严格 exactly-once。进程在外部副作用后崩溃时，保留中断记录并拒绝自动重放。

## 业务操作回执与页面查询（2026-10-19，架构方案 P1）

项目命令（`createProject`、`updateProject`）和 Agent 命令（`createCustomAgent`、`updateAgentProfile`，含清除项目覆盖；`testAgentChannelConnection` 透传其结果）返回提交回执，不再构建桌面 bootstrap。字段全部取自 `updateStateAtomically` 返回的已提交状态：

| 字段 | 含义 |
| --- | --- |
| `project` / `agent` | 提交后的记录；Agent 为该作用域的全局资料或项目覆盖，覆盖被清除时为 `null`，并带 `agentId`、`scope`、`projectId` |
| `revision` | 清单 `_revision`：每次真实提交加一，无变化事务保持原值；不新增持久化字段 |
| `changedIds` / `removedIds` | 与事务开始时相比实际改变或新增、被删除的记录 ID（按规范化 JSON 比较） |
| `agentExportWarning` | 仅在提交后 Markdown 导出失败时出现 |

旧 URL、请求体和成功响应不变：`src/http/bootstrapAfterCommit.js` 在提交后调用 `getDesktopBootstrap()`，必要时并入 `agentExportWarning`。兼容期内这些请求仍有整页组装开销。

提交后构建页面数据失败时，响应仍为 HTTP 200：`{ ok: true, receipt, bootstrapError: { code: 'BOOTSTRAP_UNAVAILABLE', message } }`。不用 5xx，避免客户端把已保存当成失败并重试（重试创建会产生重复项目或 Agent）；客户端应重新读取 `GET /api/bootstrap`。`receipt` 只含 ID、修订号与警告，不含记录正文（Agent 记录含频道凭据）。命令自身的校验或提交错误照旧报错。当前桌面 UI 尚未识别 `bootstrapError`，由页面拆分阶段处理。

`scripts/check-dependencies.js` 禁止已迁移模块直接或经任何链路（含 `desktopStore.js`）到达 `services/desktop/bootstrap.js`，失败信息列出导入链。仍直接导入它的业务模块列在例外清单中，只能减少：新增直接导入或清单中已不再导入的条目都会使检查失败。

## 存储提交与迁移

`desktop/state.json` 是提交清单，格式版本为 2，含单调递增 `_revision`。聊天消息放入按内容哈希命名的不可变 checkpoint，清单保存精确引用。

提交顺序：暂存变化的 checkpoint → 原子替换清单 → 同步派生索引 → 清理未引用 checkpoint。清单替换是提交点；提交前失败仍能读取旧消息，提交后索引或清理失败不会把已提交消息报告成未保存。这里保证进程级原子可见性，不承诺断电级持久性。

未变化聊天复用 checkpoint；空聊天使用显式空引用，避免重新读回旧记录；缺失已提交 checkpoint 明确报错，不能静默变成空聊天。无变化事务不重写清单。bootstrap 查询不提交事实状态，兼容修复与初始化由写入入口处理。

旧内联消息和旧聊天 ID checkpoint 仍可读取。首次提交为格式 2 前，自动备份旧清单及对应 checkpoint 到 `desktop/backups/before-checkpoint-v2/`，完成后才发布备份目录。已有完整备份不覆盖。

旧后端不能直接理解格式 2。需要回退时：先停止使用该 home 的后端，另存当前整个数据目录，再从完整备份恢复旧 `state.json` 和 `threads/`，随后启动旧版本。该备份是迁移时点快照；恢复它会回到迁移时点，后续消息须先另存。不要让新旧后端同时使用同一 home。

搜索用 SQLite 消息/帧/场景投影由事实数据派生。生产服务在独立 worker 中按聊天内容身份增量更新；清单修订号保存待处理状态，成功后才更新索引回执，失败退避重试、重启重放。维护命令未注册 worker 时保留同步路径。SQLite 中还存在独立长时记忆、使用统计等数据，因此不能把整个数据库当作可随意删除的缓存。

## 验证与边界

专项命令：`npm run test:architecture`。覆盖并发写入、过期快照、同聊天队列、取消、运行身份、HTTP/SSE、服务重启重试、审批、摘要竞态、提交失败与旧格式备份；已纳入红绿灯脚本。

全量非安装测试：`node --test 'src/**/*.test.js' 'desktop-ui/**/*.test.js' 'scripts/**/*.test.js'`；使用独立 `MELO_HOME`。不要在该测试命令外统一关闭 dreaming，否则会禁用并发测试本身要验证的 sweep。语法检查：`npm run build`。

隔离浏览器检查涵盖 CLI/服务身份、语音模式设置保存与重载、消息持久化和检索、聊天滚动、诊断展示及前端异常。此次使用 mock 回复，没有验证真实云模型、真实语音合成或重新安装原生应用。

本机受控样本：3 个聊天、120 条消息、连续 20 次设置更新，checkpoint 重写从 60 次降到 0 次，耗时样本从 290ms 降到 92ms。该结果只说明此夹具下的磁盘写入变化，不代表整体应用性能或长期内存结论。

当前仍是单后端进程拥有一个 home 的模型；进程内队列配合服务目录锁工作。没有引入多进程分布式事务。请求账本随聊天删除清理；消息量很大时仍需另行测量清单规模与队列等待时间，再决定是否分片。
