# 架构加固实施说明：执行器自解析能力 + 项目 R1（2026-10-15）

来源：Claude 架构复审（2026-10-15）。用户已批准按本文实施 A、B 两部分。
执行顺序：先 A，再 B；各自独立本地提交。按 CLAUDE.md，只有用户明确要求时才运行 git pp。
每个可验证步骤后更新 `MELO_OVERVIEW.md` 与短 `PROGRESS.md`。

---

## A. 执行器自行解析 Agent 能力（安全属性从"靠约定"改为"结构保证"）

### A.1 现状与问题

- `src/tools/executor.js` 的 `executeTool` 用调用方传入的 `options.capabilities` 判定；为 `undefined` 时 `toolCapabilityAllowed` 返回 true（全部放行）。
- 目前 3 个调用方（`chatExecutionRunner`、`skillExecutor`、`subAgent`）都传了，但新增任何执行路径只要漏传，就绕过能力限制。
- `null` 同时承担两种含义：「旧版未迁移，按旧行为放行」和「调用方没传」。两者必须区分。
- Codex 原生联网/生图开关、图片直达路径、团队启动各自从 `graphState.activeAgentProfile` 取能力，不是同一份来源。

### A.2 目标设计

1. **能力作用域随请求上下文传递**
   - 在 `beginChatRun`（`src/services/chat/turnLedger.js`）生成 `turnBinding` 的同一事务里，计算本轮 Agent 的有效能力：`effectiveAgentProfile(state, role, project).capabilities`。
   - 结果冻结后放进 request context，例如 `capabilityScope = { agentId, capabilities, legacy: boolean, source: 'turn' }`。
   - 未迁移的 Agent 用显式的 `legacy: true` 标记表示，不再用 `null` / `undefined`。
2. **子执行只能收窄**
   - `runConfiguredMember` / `delegateTask`：子上下文的作用域 = 父作用域 ∩ 成员自身能力（沿用 `intersectCapabilities`），`agentId` 换成成员。
   - `skillExecutor`：作用域 = 当前作用域 ∩ skill 工具白名单。
3. **执行器以上下文为准**
   - 有效能力 = 上下文作用域；若调用方另传 `options.capabilities`，只能再取交集，**不能放宽**。
   - 上下文没有作用域时：用已有的 turnBinding / chat 解析逻辑（与 `permissionScope` 同路）补算。
   - 仍无法确定 Agent 时：**拒绝执行**（新错误码 `CAPABILITY_SCOPE_MISSING`，`meta.executionStarted=false`），不回退为放行。
   - `legacy: true` 时保持旧行为放行（过渡期，见 A.4）。
4. **同一来源**：原生联网/生图开关、图片直达/变体、团队启动前检查、`delegate` 工具是否出现在工具列表，全部从同一个作用域读取。
5. 不改变能力的含义、迁移流程、界面和同步协议。

### A.3 验收测试（计数器证明未执行；新文件靠自动发现进 gate，提交前确认已被发现）

1. 本轮 Agent 没有修改文件能力：在该轮上下文里直接调用 `executeTool(file_write)` 且**不传** `options.capabilities` → `CAPABILITY_DENIED`，`run` 计数 0，权限确认计数 0。
2. 调用方传入比作用域更宽的 `options.capabilities` → 仍被拒绝，计数 0。
3. 没有请求上下文、也无法解析 Agent → `CAPABILITY_SCOPE_MISSING`，计数 0。
4. 委派：成员能力比父级宽 → 父级没有的能力被拒绝；成员能力比父级窄 → 成员没有的能力被拒绝。
5. 未迁移的 Agent（`legacy: true`）→ 行为与改动前一致（显式断言放行）。
6. 原生联网/生图开关在能力关闭时为 false（断言请求体，不只断言返回值）。
7. 现有 `capabilities.test.js`、`collaboration.test.js`、`functionCalling.integration.test.js`、`agentSettings.security.test.js` 全绿。

### A.4 过渡期收口（本次只记录，不实施）

`legacy` 放行分支计划在下一个版本移除：启动时把仍未迁移的 Agent 展示迁移预览，确认后统一转为推荐配置，之后删除 legacy 分支。

---

## B. 项目重构 R1：归属与工作区纠错

依据 `docs/project-architecture-plan-20261015.md` 第 3、5、6 节的 R1。工作区采用该文档推荐的方案 B（按需创建聊天独立的持久工作目录）。

### B.1 创建接口不再读 UI 选中状态

- `createChat`（`src/services/chat/chatMutations.js`）、`createTask`（`src/services/task/taskMutations.js`）、`createApproval`（`src/services/approval/approvalMutations.js`）去掉对 `state.settings.selectedProjectId` 的回退。
- 前端显式传 `projectId`：主页和普通入口传 `null`，项目页传项目 id。
- 任务、审批优先继承所属聊天的 `projectId`。
- 旧客户端省略字段时视为无项目，并记录诊断日志。
- 「开启项目对话」合并为一次请求（现为先 `patchSettings` 再 `createChat`）。
- 拒绝未知或已删除的项目 id；归档项目沿用现有的「先恢复」提示。

### B.2 不再制造占位文案

- `createProject`（`src/services/project/projectMutations.js`）和 `normalizeProject`（`src/domain/project/projectService.js`）不再补默认的 summary / instructions，空值就是空字符串。
- `buildProjectContextSection`（`src/services/project/projectContext.js`）跳过空字段。对**逐字等于**旧默认文案（`归拢相关对话、资料与目标。`、`A local Melo project.`、`Keep this project focused, actionable, and easy to continue later.`）的字段，在拼 prompt 时按空处理。
- **不改写已存储的数据**（见项目方案第 6 节末段）。界面上对这些字段显示为空，用户可以编辑。

### B.3 工作区不再回退到程序目录或进程目录

- `buildWorkspaceSnapshot`（`src/services/workspace/workspaceSnapshot.js`）：无项目时 `rootPath: null`，不再是 `APP_ROOT`。
- 远程频道后台分支（`src/services/chat/sendChatMessage.js` 的 `shouldUseBackgroundWorkspace`）同样处理。
- 文件和命令类工具首次需要工作目录时，按需创建 `<MELO_HOME>/workspaces/chats/<chatId>`（权限 0700），并登记到这个聊天上，跨重启保留。闲聊本身不创建目录、不扫描磁盘。
- 去掉工具里的 `process.cwd()` 回退：`bashTool`、`fileRead/Edit/Write/Delete/Move/Mkdir`、`glob`、`grep` 等。拿不到工作目录时明确报错，不再默默使用进程目录。
- 旧项目的 `workspacePath` 恰好等于 Melo 程序目录时：保留原记录和文件，执行前提示用户「请确认或重新选择工作目录」，**不自动迁移、不自动放行**。用户明确选择 Melo 源码作为工作区的，确认后照常可用。
- 已有的权限授权不能因为路径变化而扩大。

### B.4 验收测试

1. `projectId` 为 `null`、省略、未知 id、已删除 id 四种情况的创建结果。
2. 进入 A 项目页后回到主页新建聊天 → 不属于 A 项目；同时并发创建两个聊天，各自归属正确。
3. 无项目聊天执行 `bash pwd` 和 `file_write` → 实际执行位置是 `workspaces/chats/<chatId>`，绝不是 `APP_ROOT` 或 `process.cwd()`（断言真实路径）。
4. 旧项目路径等于程序目录 → 工具调用被挡下并提示，执行计数 0。
5. 新建项目不填目标和要求 → prompt 里不出现项目目标、要求或任何占位文案；旧数据里逐字等于默认文案的字段同样不进入 prompt。
6. 图片生成和下载、远程频道对话、项目内对话行为不回归。
7. 已授权的权限范围不扩大（对比改动前后的权限判定）。

---

## 边界

- 本文不包含 R2（统一 `resolveProjectContext`）、R4（移动和删除生命周期）、前端拆分和兼容层淘汰，这些另行出方案。
- 不迁移、不删除用户的真实数据。真实数据上需要执行的步骤要先告知用户。

## 实施回执 A（Codex，2026-10-15）

A.3 七项验收已覆盖：`executor.capabilityScope.test.js` 的遗漏/放宽/无身份/双向委派/legacy/冻结/技能白名单计数器，`functionCalling.integration.test.js` 的真实 HTTP 原生工具请求体，以及既有能力、协作和同步安全测试。新测试由日常自动发现。69 项专项、11 项验收及日常 3553 JS / 21 Swift GREEN，日志 `/tmp/melo-hardening-a-daily2.log`；仅隔离树实现，B 与共享集成继续。

## 实施回执 B（Codex，2026-10-15）

| 验收 | 实际证据 |
| --- | --- |
| B.4.1 / 2 归属 | `projectR1.test.js`：显式 null、省略、未知/删除、并发与任务/审批继承；`projectR1.browser.test.js`：项目启动只有一次 POST，回主页后创建无项目聊天 |
| B.4.3 / 4 工作区 | 真实 bash pwd 与 file_write 落在聊天私有目录，0700；冷进程重读仍保留；程序目录拦截计数 0，界面编辑/勾选/保存后明确确认 |
| B.4.5 文案 | 新空字段、旧默认文本、非精确匹配文本分别验证；原始旧数据不变 |
| B.4.6 回归 | 日常包含图片工作流/下载、远程 sendChatMessage、项目内执行；远程未执行文件操作时不建目录 |
| B.4.7 权限 | 旧 APP_ROOT 授权不匹配聊天目录；调用方不能替换绑定目录；符号链接替换、内部配置、目录根与兄弟聊天不会取得写权限 |

新目录只在首次工具执行时创建，登记在聊天 manifest，不通过手机同步传播本机路径。Melo 数据保护的例外限定到本轮验证过的生成工作目录内容，其他内部数据保持保护。

隔离日常 `npm test` GREEN：3563 JS、837 文件语法、两组浏览器、21 Swift，143.1 秒。69 项持久化/PDF 边界、34 项浏览器/安全专项通过；依赖图 386 模块、0 环。日志 `/tmp/melo-hardening-b-{boundary-final2,acceptance3,daily3}.log`。真实模型、真机与完整发布安装 gate 未在本轮重跑；共享源码整合回执随后补充。
