# 任务空间 C 方案：星核主控、实时评估契约与三维视角

状态：2026-11-05 用户选定 C（相对 A「只升级视角」、B「只用现有数据投影」），要求视频底部各面板对应真实数据、设计语言与现有界面一致。分支 `claude/task-space-c-20261105`（worktree `.tmp/task-space-c-20261105`），基准 bc42ea2。主工作区另一线程的未提交改动涉及 `taskEvaluation.js`、`goal.js`、`internalMembers.js`、`invokeModelNode.js`、`AgentLoop.swift`、`SharedChatAgent.kt`，本分支不触碰，合并前变基并重跑集成档。

## 执行链路（修改前从源码读出）

桌面：
1. `src/services/chat/execution/invokeModelNode.js` 主循环。`task_progress` 单独调用时 → `coreTurn.progress()`（`src/runtime/sharedAgentCore.js`）→ `goalOperation('progress')` → `updateTaskEvaluation`（`shared/agent/taskEvaluation.js`）→ 返回 `progressResult` 给模型 → `sseEmitter('execution_event', {kind:'pipeline', id:'task-evaluation:<iter>', ...taskProgressPresentation})`。
2. `route_task` → `startInternalJob`（`shared/agent/internalRouting.js`）→ `runInternalMembers`（`internalMembers.js`）→ `prescreenApprovals` 发 `routing:approval:N`，`pipeline()` 发 `internal:N`（running / completed / interrupted），成员子循环事件经 `emit` 加 `job-N:` 前缀和 `actorName`。
3. 核验：`goal-check:<iter>`（stage.delivery）；预算：`budget:exhausted`；停止：`core:stop`、`limit:delivery`。
4. `sseEmitter` → `src/services/chat/executionScenes.js createExecutionRecorder.event` → `applyExecutionEvent`（`src/shared/executionScene.js`，字段白名单）→ 每 100 ms 原子写入 `MELO_HOME/desktop/execution-scenes/<runId>.json`（tmp + rename），同时经 `execution_scene` SSE 推前端。
5. 结束：`finishExecutionScene` 写 `completion`（含 `task.evaluation` 完整状态，B 方案）。
6. 前端：`desktop-ui/executionPanel.js receiveExecutionScene / syncExecutionPanel → paint()` → `executionScene3D.update(scene, focus, items, zoom)`，标签由 `onProject` 投影到 DOM。

iPhone：`ios/Melo/AgentLoop.swift` 在 `internal:N`（:378 / :584）与 `task-evaluation:<iter>`（:572）调用 `hooks.onStage(id, name, status, output)` → `ChatStore.stage`（:260）→ `ExecutionRecord.recordStage` → 本机存档与同步 → `NeuralWebView` → `ios/SceneSource/mobile.js meloReceive` → 同一个 `executionPanel.js`（打包清单 `ios/Melo/Scene/desktop-manifest.json`，`npm run build:ios-scene`）。

Android：`SharedChatAgent.kt` 在 `internal:N`（:296 / :317）与 `task-evaluation:<seq>`（:385）调用 `journal.event` → JS core `scene`（`shared/agent/execution.js executionScene`）→ `SharedScene.kt` WebView，资源由 Gradle 从 `ios/Melo/Scene` 拷贝。

共享读写状态：场景 JSON（随消息进入历史与同步，`shared/protocol/sync.schema.json` `$defs/stage` 未限制额外字段）、评估状态（goal state 内的 `evaluation`，只在本轮内存与 completion 回执中）。

## 审计边界与停止条件

- (a) 共享状态：场景 reducer 两份（桌面 `applyExecutionEvent`、便携 `executionScene`）及其所有消费者（面板、三维场景、`executionContext`、`sessionEvents`、同步序列化）。
- (b) 异常：快照与规范化函数遇坏数据只丢弃字段、不抛错；reducer 现有抛错（未知 run、事件超限）形态不变。
- (c) 契约：`goalOperation` 新增只读 action、`taskEvaluationOperation` 新增 action、stage 新可选字段 `role` / `limits` / `evaluation`，三端实现方与消费方全部纳入。
- 停止：到 `shared/protocol` 与 conformance 为止；不进入 three.js 内部（版本钉死）；不进入模型供应商传输层；不改 sync v1 字段形状（新字段可选，旧端解码忽略）。

## 覆盖 / 未覆盖（实施中更新）

见文末「实施记录」。

## 实施记录（分支 `claude/task-space-c-20261105`）

| 提交 | 内容 |
| --- | --- |
| `3497472` C1 | `taskEvaluationSnapshot` / `normalizeEvaluationSnapshot`（`shared/agent/taskEvaluation.js`），`goalOperation('progressSnapshot')` 只读；`INTERNAL_JOB_ROLES`；两份 reducer 接受 stage 可选字段 `role` / `limits` / `evaluation`；桌面、iPhone（新 hook `onStageEvent`，旧 `onStage` 作回退）、Android（`journal.event` 新参数，捕获异常先 `ensureActive()`）三端发出；服务端白名单与 iOS 打包清单加入 `taskEvaluation.js` |
| `c293857` C1 | 重新打包手机 / Android 共用场景 |
| `b21814c` C2 | `src/shared/executionBoard.js`：成员、阶段条、评估（实时快照优先，回退结束回执，再回退文本）、日志、资源、候选变化 |
| `fb785c5` C3 | 星核、成员行动者（岗位色）、分派光束、交接回流、评估火花；全局 / 跟随 / 自由视角（`executionViewFrame` 等纯函数），聚焦详情锁正面；拖动阈值与拾取一致（6 px） |
| `75b1361` C4 | 作战台六卡、阶段条、当前行动卡、视角切换、五语言文案；只在发生分派或评估时出现；视角与收起状态只存本机 |

设计承诺：
- 快照只含字段状态与用户合同原话，不含证据原文；分档直接取 `taskEvaluationSummary` 的主推 / 备选，界面门槛线读快照里的 policy，不写死；分数注明「排序分，不是概率」。
- 新字段可选；iPhone 冻结的 v1 同步投影（`WorkspaceProjection.stage`）不带这些字段，所以手机发起的任务在桌面同步回看时显示文本评估（界面标明「这条记录没有结构化评估数据」），本机回看完整。
- 没有分派或评估的普通对话，界面、相机与静止姿态与改动前一致（`yaw = pitch = 0` 时取景逐值相等，有测试）。
- 与批准计划的一处差异：跟随视角下拖动改为「绕跟随目标改变角度、继续跟随」，只有全局视角拖动才切到自由视角。

## 覆盖 / 未覆盖

覆盖：上表全部改动文件；共享快照对 36 个 B 夹具逐一核对分档、字段状态、门槛与限长；reducer 拒收坏数据与未知岗位；桌面宿主事件（计数器证明快照不触发工具执行）；Swift `ExecutionTests` / `AgentLoopTests` / `ParityRegressionTests`（同步投影不含新字段）；投影与视角纯函数；真实浏览器（服务端 + 临时 `MELO_HOME`）验证六卡数值、阶段条、三种视角、拖动不误触、聚焦锁定、实时飞入与减弱动态、393 宽无溢出、普通对话不出现作战台；手机打包场景（file:// + 原生桥桩）393×852 渲染与跟随。

未覆盖与原因：Android 仪器测试（`ChatPhoneUseFlowTest` 已加断言并编译通过，需模拟器或真机运行）；真实模型探针（会使用用户自己的模型连接，需用户确认后执行）；iPhone / Mac 安装（未获授权）。主工作区另一线程的未提交改动与本分支有文件重叠，合并前需变基后重跑集成档。

## 回归与证据

- C1 扩大快速档 `run-VMwbfc`（隔离 worktree，提交 `c293857`）：语法 / 生成器 / 共享渲染 / Android JVM·Lint·Debug·Release 全绿；JS 4965 通过、1 跳过、3 失败——三项都是新 worktree 缺少被 gitignore 的本机资源（桌宠皮肤、内置向量模型），软链接资源后同三项重跑通过；随后 Swift 38 组全部通过（583 s，无编译缓存）。
- 集成档 `npm test -- --base bc42ea2` → `run-VHB0gX`（提交 `75b1361`）：JS 4982/4982，零失败 / 跳过 / 复测；Swift 38 组、Android 四项、设置浏览器、文档链接、生成器与共享渲染预检全绿。
- C5 之后的改动（手机行高、证据目录名、文档）：renderer 预检、`SceneBridge`、`taskSpaceBoard.browser` 重跑通过。
- iOS 模拟器无签名 Release 构建：BUILD SUCCEEDED，改动行无新告警。审计扫描 H1–H20 相对基线除既有 H5 外无新增（H10 / H11 / H13 / H14 均 +0）。
- 本平台未执行：Android 仪器测试（需模拟器）；真实模型探针、安装未做（见上）。
- 证据目录 `.tmp/task-space-board-20261105/`：`screens/`（改动前、结束、实时全局、跟随、自由旋转、作战台 4–6 卡、393 窄屏、手机打包场景两张）与 `gates/`（两次门禁摘要、Swift 38 组、iOS 构建结论）。

## 布局 A：独立作战大屏移入产品（2026-11-06）

用户决定：嵌在聊天里的任务空间界面不要，改为独立全屏「作战大屏」（布局 A），原型经四轮调整后确认（星核即主 Agent；成员是低饱和紫色线框蜘蛛，出星核、跳到区域、站在网上走动转身、前爪扒取，词条从爪子飞进执行日志对应行；五个区域沿用 Melo 主界面配色与神经网络画法并细化；区域放大铺满）。执行要求（用户原话要点）：界面必须和任务本身对齐（例如「工具调用」区域其实算进了网页搜索）；所有数字与记录可追踪；回复用户时自动弹出；电脑与手机都能手动旋转、缩放。

### 设计（单一方案，按用户要求直接执行）

- 作战大屏是任务空间的展开态：桌面是覆盖整个窗口的独立层（挂在 `document.body`，不进聊天的增量渲染），手机就是现有全屏任务空间网页（iPhone `ExecutionWorkspace`、Android `ExecutionScreen`）。聊天里的面板收成一行（状态、阶段条、历史任务、朗读设置、「进入作战大屏」）。
- 自动弹出：当前对话的进行中任务第一次出现可观测执行（工具调用、分派或评估）时打开；纯对话回复不弹。任务结束后若是自动打开且用户没动过，约 2.6 秒回到对话（沿用现有「自动收起」设置）；任务中用户手动关掉，本任务不再自动打开。手机两端同一规则（原生侧收到首个执行阶段时弹出，结束后按同样条件收回）。
- 分类对齐：区域计数只算本区域自己的调用（`moduleActivity('tools')` 不再汇总全部调用）；全部调用数只在状态栏，五个区域的调用数之和等于它（有测试）。没有声明 `uiModule` 的外部工具按名字识别网页检索类（`web_search` / `fetch` / `browse` / `crawl` / `scrape` 及常见检索服务名），其余仍归工具调用。蜘蛛去的是它正在执行的那次调用所在区域，不按岗位猜；成员在第一次调用前停在星核表面；主 Agent 自己调用工具时由一只标着主 Agent 名字的蜘蛛出去执行。
- 数字可追踪：状态栏（工具调用、输入 token、用时、软检查点）、区域标签（几次调用、几条来源）、分派（每个成员的调用数）、交付闸门四项、证据热力账本与每一行、合同覆盖每个字段，点开都列出被计数的那些记录，标题里的数等于列表条数；记录再点开是现有的执行详情（输入、输出、接口用量）。
- 作战台：有分派或评估的任务六格（执行日志、分派、交付闸门、证据热力、合同覆盖、任务合同），全部取自录下的场景与评估快照；没有的任务三格（执行日志、区域与来源、资源账本），不显示空的评估格。原展开面板的来源卡片、计算公开摘要、图片候选与选图、重试缺图、执行详情全部移到作战台的详情视图，功能不减。
- 旋转缩放：桌面拖动旋转、滚轮与触控板双指缩放、方向键与加减键；手机单指旋转、双指缩放（指针事件，画布 `touch-action: none`），另有缩放按钮；作战台区域照常滚动。
- 设计语言：颜色全部来自现有 token（区域 `--visual-execution-*`，蜘蛛 `--visual-agents-light` 与 `--palette-dcb6b78bdc`，星核金色沿用），不新增色值。

### 执行链路（读源码得出）

1. 数据不变：`invokeModelNode` / `internalMembers` → `sseEmitter('execution_event')` → `executionScenes.js createExecutionRecorder.event` → `applyExecutionEvent`（`src/shared/executionScene.js`，`moduleForOperation` 定区域）→ 原子写场景文件并经 `execution_scene` SSE 推送。
2. 桌面前端：`app.js` → `executionPanel.js receiveExecutionScene / syncExecutionPanel` → 新 `warRoom.js`（覆盖层：顶栏、作战台、状态栏、追踪视图、词条飞行）→ 新 `warRoomScene3D.js`（星核、五个神经网络团、蜘蛛、手势与视角）。纯投影在 `src/shared/executionBoard.js`（C2）与新 `src/shared/warRoom.js`（蜘蛛位置、区域计数、追踪清单、交付闸门）。
3. 手机：`AgentLoop` / `SharedChatAgent` 阶段 → 本机场景 → WebView `mobile.js meloReceive` → 同一套 `executionPanel.js` / `warRoom.js`（打包清单 `ios/Melo/Scene/desktop-manifest.json`）。自动弹出由 `ContentView` / `MainActivity` 观察进行中任务的首个执行阶段决定；网页内「回到对话」经桥消息 `close` 交给原生关闭。

### 审计边界与停止条件

- (a) 共享状态：场景记录只读，不新增字段、不改 reducer 写入；`moduleActivity` 语义改动的全部调用方（面板、旧三维场景将删除、测试）。本机偏好只用现有 `localStorage` 键。
- (b) 异常：投影与渲染遇坏数据只跳过该项；三维初始化失败沿用现有降级文案，作战台与追踪照常可用。
- (c) 契约：不改 sync v1、`shared/protocol`、工具结果信封；手机桥只新增两类消息（`close`、`interacted`），旧原生端忽略未知消息。
- 停止：不进入 three.js 内部（版本钉死）；不改服务端执行与模型调用；手机原生只改「何时弹出 / 收回」与桥消息处理。

### 测试计划

- 纯函数（`src/shared/warRoom.test.js`）：区域计数之和等于全部调用、搜索不进工具调用；未声明模块的外部检索工具归网页检索；蜘蛛位置跟随实际调用、成员首次调用前在星核、主 Agent 调用单独成一只；追踪清单条数等于显示数字；交付闸门四项取自快照字段。
- 浏览器（真实服务端、临时 `MELO_HOME`）：进行中任务出现首个调用时作战大屏自动打开、纯对话不弹、结束后自动回到对话、手动关闭后不再弹；所有带数字的位置点开清单条数一致；拖动旋转、滚轮与双指缩放改变相机且不误触选择；393×852 无横向溢出；减弱动态效果下不飞词条、行直接出现；控制台无错误。
- 原有用例改到新结构后保持原意（计时、遥测、语言、密度、场景桥），不删断言。手机：Swift 测试覆盖自动弹出判定与 `close` 桥消息；Android JVM 测试覆盖同一判定；仪器测试需模拟器则记「本平台未执行」。

### 实施记录（布局 A，C6）

| 项 | 内容 |
| --- | --- |
| 共享投影 | 新 `src/shared/warRoom.js`：`regionSummary`（各区域只算自己的调用，加起来等于总数）、`sceneActors`（蜘蛛位置跟实际调用走，成员首次调用前在星核表面，主 Agent 自己的调用另成一只）、`operationChip`、`deliveryGate`（四项取自快照，开闸以评估器 `stop` 为准）、`traceList`（每个数字背后的记录，条数 = 显示数，token 为合计）、`shouldAutoOpen` |
| 分类 | `moduleActivity('tools')` 不再汇总全部调用；`moduleForOperation` 对未声明 `uiModule` 的外部检索工具（名字含 web_search / fetch / browse / crawl / scrape 或常见检索服务名）归网页检索 |
| 修复 | C2 `sceneResources` 把推理摘要阶段（沿用请求的 `api` 记录）的用量又算一遍，状态栏 token 翻倍；新 `usageStages` 按响应只计一次（跳过摘要阶段、按 `responseId` 去重） |
| 三维 | `warRoomScene3D.js`（星核、五个 Melo 配色神经网络团、蜘蛛、勾取词条、全局 / 跟随 / 自由 / 区域视角、拖动旋转、滚轮 / 触控板 / 双指缩放、键盘、慢设备按帧时降密度）；`warRoomSpider.js` / `warRoomCluster.js` / `warRoomParticles.js` 自原型移入 |
| 界面 | `warRoom.js` + `warRoom.css`：全屏层、顶栏（阶段条、历史任务、更早的任务、视角、回到对话；手机加朗读设置）、作战台（有分派或评估六格，否则三格）、追踪 / 区域 / 记录详情、状态栏、词条飞行；`executionPanel.js` 收成聊天里一行，原展开面板的来源卡片、公开摘要、图片候选与选图、重试、执行详情移入详情视图 |
| 自动弹出 | 桌面 `executionPanel.js`；iPhone `WarRoomPresentation`（`ExecutionRecord.swift`）+ `ContentView` / `ExecutionWorkspace`（网页 `close` / `interacted` 桥消息，网页正常时隐藏原生导航栏）；Android `WarRoomPresentation.kt` + `MainActivity` / `SharedScene` |
| 不挡确认 | 回复中出现等待用户回应的提示（被扣住待许可的调用，或聊天里带 `data-request-id` 的工具权限 / 任务授权 / 文件写入 / 能力请求），作战大屏让开、不自动弹出，答复后回来；让开不算用户关闭。自动弹出不抢键盘焦点。iPhone 另把设备操作确认与能力请求两种系统弹窗算进去（它们在弹出页之上无法显示）；Android 的确认是浮在页面上的系统对话框，只按调用状态让开 |
| 删除 | 旧嵌入式渲染 `executionScene3D.js`、`executionBoard.js`（桌面渲染）、`executionViewport.js`、`executionPicking.js`、`synapticBody.js` 及其单测；其职责由上面的新文件承担，手势与拾取在真实浏览器验收里测 |

与方案的差异：
- 相机视角（全局 / 跟随 / 自由）不再按设备记忆（C3 的 `melo-task-space-view`）；每个任务记住的是打开的区域详情（沿用 `melo-scene-view:<runId>`，手机经桥同步到原生）。
- `build:ios-scene` 依赖 Python ≥ 3.9（`str.removeprefix`）；本机 PATH 上的 Anaconda 3.8 会让它静默失败，变基时那次重建因此没生效，这次用 `/usr/bin/python3` 重建并已核对。

覆盖：上表全部文件；纯函数 8 例（区域加和、外部检索归类、蜘蛛位置、词条、交付闸门、追踪条数、token 只计一次、自动弹出规则）；面板 3 例（来源上限与追踪；自动弹出 / 回收 / 手动关闭 / 触碰 / Esc / 不抢焦点 / 为许可与聊天提示让开再回来；停止后本地收尾）；手机场景桥（视图恢复与桥接、来源与引用、追踪、会话事件、手势控制到场景、`close` / `interacted`、历史分页、朗读设置）；真实浏览器验收（阶段条、六格数值等于账本、每个数字的清单条数、五区加和、工具调用 0、视角、拖动不误触、滚轮 / 触控板 / 双指 / 键盘 / 按钮缩放、实时任务自动弹出、蜘蛛勾取词条落行、减弱动态不飞、393 宽无溢出、普通对话三格、无控制台错误）；原有计时 / 遥测 / 语言 / 密度浏览器用例改到新结构；Swift `ExecutionTests` 自动弹出与让开规则；Android JVM `WarRoomPresentationTest`（弹出、回收、让开）。门禁首轮抓到两项真实问题并已修：作战大屏挡住文件写入许可与能力请求提示（`taskPermissions` / `capabilityElevation` 浏览器用例）、样式改动后未重新打包手机场景（渲染预检）。

未覆盖与原因：真机上的手势与帧率（需要用户设备）；Android 仪器测试（需模拟器）；真实模型探针（会用用户的模型连接）；安装与合并（未授权）。

回归与证据（`.tmp/war-room-20261106/`）：
- 快速档 `run-nGv2Jp`（删除文件触发 JS 全量）：语法、文档链接、生成器、共享渲染预检、JS 4 986 / 4 986（0 失败 0 跳过）、设置浏览器验收、Swift 38 组全绿，467.7 s。摘要 `gates/quick-run-nGv2Jp.json`。
- 审计扫描相对改动前提交：H1–H20 全部持平（H5 102、H14 5 均与改动前相同；H10 / H11 / H13 为 0）。
- Android `npm run check:android`：JVM 209 / 209（0 失败 0 跳过，含 `WarRoomPresentationTest` 4 例）、Lint、Debug、Release 全部 BUILD SUCCESSFUL。日志 `gates/android-check.log`。
- iOS 模拟器无签名 Release 构建：BUILD SUCCEEDED，`ContentView` / `ExecutionWorkspace` / `ExecutionRecord` 无告警。日志 `gates/ios-simulator-unsigned-build.log`。
- 本平台未执行：Android 仪器测试、真机手势与帧率、真实模型探针；集成档 `npm test -- --base d5c596e` 留到合并前。

### 复看后的修正（C7，2026-11-06）

用户看了产品截图后指出：电脑端五个区域会跑到默认画面外面；手机端底部做成左右滑动。我自己复看截图时，另外发现三处细节问题。

| 问题 | 原因（读代码 / 量出来的） | 修法 |
| --- | --- | --- |
| 电脑端区域出屏 | ① 打开时相机从初始距离 1400 慢慢拉到取景位置，开场约一秒内区域明显出屏（变异检验量到外沿到 x=1604，画面宽 1280）；② 取景把每个区域当成 0.9 × 标称半径的球，只留 4% / 7% 边。侧倾 0.5 弧度的「工具调用」实际投影比这个球宽约 40%，全局视角摆动时节点离画面边只剩 1–24 像素，外圈尘埃和泛光被切，标签也没处放，只能压回区域上 | 新 `desktop-ui/warRoomLayout.js`（纯函数，不依赖 WebGL）：布局与侧倾常量从场景移入；每个区域取 256 个方向上的最远节点，再外扩 5%，作为外沿（在任何方向上都包住全部节点）；全局 / 自由视角按外沿取景，四边按画面尺寸留出标签空间（宽 5.5%，限 12–80 px；高 7%，限 10–44 px）；打开和画面尺寸变化时相机直接就位；区域标签按投影后的外轮廓椭圆往外摆 |
| 手机底部 | 原本已是横向滑动、每次停一张；滑到头会把滑动带到整页，第二张起停靠时贴边 | 加 `overscroll-behavior-x: contain` 与 `scroll-padding-inline: 12px`；用真实触摸手势验收 |
| 顶栏「04 核验 · 金冬天 · 核验 · …」 | 阶段名与最新一条日志的动词直接拼接 | 动词与阶段同名时省略 |
| 没有用量记录时显示「输入 0 token」 | 把「未知」显示成 0（服务商不报用量，或还没有回复） | `sceneResources` 增加 `usageRecords`；为 0 时显示「—」，点开仍是同一份清单 |
| 卡片副标题被截断且看不到全文 | 单行省略，没有 `title` | 副标题与热力表字段名悬停显示全文；「交付闸门」副标题缩短为「四项都满足才核验」（五种语言同步） |

测试：
- `warRoomLayout.test.js`（6 例，均用产品同一套种子、节点数与侧倾生成的真实节点）：
  - 侧倾旋转与 three 的 `Euler` 一致；
  - 外沿在 4000 个方向上都包住全部节点；
  - 13 种画面尺寸（桌面 1024–2560 宽，手机竖 / 横）× 全局摆动范围内，每个节点都在画面内，外沿都在标签边距内；
  - 自由视角各个角度下，每个节点都在画面内；
  - 取景贴近边距且居中，没有缩得过小；
  - 旧取景下节点离边缘不到 1% 宽。
- 浏览器验收新增：
  - 打开后第一帧，外沿就在边距内；
  - 1024×700、1440×900、1920×1080、1280×1000 四种窗口下同样在边距内；
  - 393×852 竖屏布局同样在边距内；
  - 用触摸手势左滑，第二张卡片完整停靠；右滑，回到第一张。
- 面板测试新增：无用量记录时显示「输入 — token」，有记录时显示合计；顶栏不重复阶段名。

变异检验（每次改完都恢复原文件；上面的断言均先在改动前的代码上失败）：

| 变异 | 结果 |
| --- | --- |
| 去掉打开时直接就位 | 开场第一帧外沿到 x=1604，失败 |
| 换回旧的标称球取景 | 外沿离左边 18 px，小于标签边距，失败 |
| 手机底部改为不可横向滚动 | 滑动检查失败 |
| 顶栏与 token 两处恢复旧代码 | 面板测试两例失败 |

手机打包清单（`ios/scripts/build-scene.py`）加入 `warRoomLayout.js`；已重新打包，并按压缩后仍保留的特征核对包内含新取景代码。

门禁与证据：
- 快速档 `run-r9KrKL`（顶栏、token、副标题三处）：JS 844 / 844，Android、设置浏览器验收全绿。
- 快速档 `run-RRwgAh`（取景与滑动）：选中 142 / 591 个文件，JS 850 / 850（0 失败 0 跳过）；Android JVM / Lint / Debug / Release、设置浏览器验收全绿。摘要在 `.tmp/war-room-20261106/gates/`。
- 审计 H1–H20 与改动前持平。H6 / H17 / H20 的命中全部在本轮未改动的文件里。
- 产品录屏与截图在 `.tmp/war-room-20261106/screens/`：自动弹出那一帧、全局视角、追踪清单、手机默认视角、手机左滑后。

### 合并（2026-11-06）

用户要求合并并推送。

合并前集成档 `npm test -- --base d5c596e` → `run-CjTZuy`：
- JS 591 / 591 个文件，4 992 / 4 992 项，0 失败 0 跳过；
- Swift 38 组全部执行通过（编译沿用缓存，C6 后 Swift 源码未变）；
- Android JVM / Lint / Debug / Release、设置浏览器验收、文档链接、生成器与共享渲染预检全部通过。

摘要在 `.tmp/war-room-20261106/gates/integration-run-CjTZuy.json`。

合并时 master 与 `origin/master` 均在 `d5c596e`，本分支在其之上，快进合并。

同步更新了仍描述旧文件或旧规则的现行文档：
- `docs/execution-panel.md`：实现入口与区域计数规则；
- `docs/mobile-desktop-alignment.md`：「工具调用汇总所有调用」改为只算本区域，以及对齐表三行；
- `MELO_OVERVIEW.md`：模块表与保留的产品决定。

`ios/VERIFICATION.md` 与带日期的审计、归档文件是历史记录，未改。

### 推送门禁评级 C 与修复（C8，2026-11-06）

在主工作区对 master 运行 `git pp`。推送前评估评级 C（「完成状态与评估计数失真」），推送被阻止，GitHub 上的 master 仍在 `d5c596e`。本地 master 已快进。

Codex 的三条发现都已在代码里核实；核实时又发现两处同类问题，一并修复：

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| 🔴 评估到「可进入核验」后，任务只要结束（含失败、取消、中断、部分完成），闸门就显示「已核验 · 已交付」 | 用「运行结束」推断交付与核验 | 新纯函数 `deliveryStatus`（`src/shared/warRoom.js`）。运行中看评估器的 `stop` 与最近一次 `goal-check`。结束后先看任务自身终态（失败 / 取消 / 中断），再看完成回执的 `outcome` 与 `goalState`。只有回执可以说「交付」，只有 `goalState` 为 verified / supported 时才说「已核验」。闸门状态行带 `data-state`，按状态着色 |
| 同类：阶段条最后一格、日志结束行一律写「交付」 | 同上 | 按 `deliveryStatus` 显示交付 / 部分交付 / 已取消 / 失败 / 中断 / 结束；运行中被预算或停止截断的显示「停止」 |
| 🔴 实际核实 30 个，闸门显示「24 / 30」而闸门已开；热力账本少计 | 合格数、主推数取自最多 24 条的候选明细 | 闸门四项改用评估器自己的总数：`summary.verified`、`recommended`，以及新增的 `gapCount` |
| 同类：缺口与排除数也被截断（缺口最多带 4 条，而未覆盖维度最多 12 个；排除的候选排在最后，最先被截掉） | 快照没有这两个总数 | 共享核心快照汇总新增 `excluded` 与 `gapCount`；规范化保留它们，旧记录没有就保持没有，回退为数明细。已重新打包 agent-core（桌面 dist 与 iPhone `AgentCore`） |
| 追踪清单与总数不一致 | 清单只有快照带的行 | `traceList` 返回 `omitted`，显示的数字等于已列行数加 `omitted`；详情注明「另有 N 条未随快照记录，数量取自评估器的总数」；热力账本的数字取对应清单的总数，表格截断时注明 |
| 🟡 在画布上点区域或蜘蛛不算用户操作，自动弹出的作战大屏会在任务结束时收起，打断正在看的详情 | `pick()` 不发交互通知（DOM 按钮会发） | `pick()` 命中即调用 `onInteract` |

测试：
- `src/shared/warRoom.test.js` 新增两例：超出快照上限时，闸门与七种追踪都用总数并标注未列出的条数，旧记录回退；`deliveryStatus` 覆盖运行中四种情况和结束后的全部终态与回执组合。
- `shared/agent/taskSpaceSnapshot.test.js` 新增一例：排除数与缺口数在截断后仍然准确，旧记录规范化后不多出这两个键；恶意输入测试加入这两个字段。
- `desktop-ui/executionPanel.test.js` 新增一例：失败任务的闸门、阶段条和日志都不说「已核验 / 已交付」；只有回执说交付并核验时才显示；超出上限时作战台的数字是总数。
- 浏览器验收新增：自动弹出后在画布上点区域，任务结束后作战大屏保持打开。
  - 这项检查第一版是假绿：夹具页传了 `autoCollapse: false`，作战大屏从不会收起。变异检验发现后，夹具页加了 `auto` 参数，开启与产品一致的收起。

变异检验（每次测完都恢复原文件）：

| 变异 | 结果 |
| --- | --- |
| 两个 warRoom 文件回到修复前 | 面板新用例失败 |
| 合格数改回按 24 条明细计数 | 面板与投影各一例失败 |
| 去掉 `pick()` 里的交互通知 | 浏览器验收失败 |

门禁：快速档 `run-jsRQQE`（共享核心改动扩大到全量）：
- JS 591 / 591 个文件，4 996 / 4 996 项，0 失败 0 跳过；
- Android 四项、设置浏览器验收全部通过；
- Swift 38 组全部通过。编译沿用缓存，测试运行时加载的是新打包的 agent-core，日志首行为 393 635 字节，与本次构建一致。

重跑 `git pp` 等用户确认：规范 §9 规定，被门禁阻止后不得自行重跑。

### 第二次推送门禁评级 C 与修复（C9，2026-11-06）

用户确认「修完、`git pp` 之后合并到 master」。重跑 `git pp`，评级 C（「跨端终态与候选追踪存在回归」），推送再次被阻止。三条都已复现并修复。

1. 🔵 Android 的便携记录器把部分完成、需补充、预算用尽、未核验都记成 `status: failed`，C8 的 `deliveryStatus` 先看 `status`，这些在 Android 上全显示成「失败」。现在三端统一解读如下。只改解读，存量记录不动；旧的 Android 场景会按其 `taskOutcome` / 回执重新显示。

| 端 | 结束方式 | `status` | 任务结果（回执 `outcome`；Android 另有 `taskOutcome`） | 显示 |
| --- | --- | --- | --- | --- |
| 桌面 / iPhone / Android | 正常回复 | completed | 回执 completed，看 `goalState` | 已核验 · 已交付 / 已交付 / 已交付 · 未核验 |
| 桌面 / iPhone | 回复了但任务没做完 | completed | partial / needs_user / budget_exhausted / unverified / blocked | 部分完成 / 等待你的补充 / 预算用尽 / 已交付 · 未核验 / 未能完成交付 |
| Android | 任务没做完 | failed（由结果推出） | 同上，原因不是请求错误 | 按回执，同上一行 |
| 桌面 | 请求出错 | failed | 无回执（消息只带 `executionError`） | 任务失败 |
| iPhone | 请求出错 | failed | 补写回执，原因 `REQUEST_FAILED` | 任务失败 |
| Android | 请求出错 | failed | 原因 `REQUEST_FAILED` 或 `MODEL_*` | 任务失败 |
| 任一端 | 取消 | cancelled，或回执为 cancelled | — | 任务已取消 |
| 任一端 | 中断 | interrupted | — | 任务已中断 |
| 任一端 | 回执说完成，但运行失败（矛盾） | failed | completed | 任务失败（从严） |
| 任一端 | 结束但没有任何结果 | completed | 无 | 已结束 · 没有完成回执 |

2. 🟡 快照把候选 key 直接截成 80 个字符，前缀相同的两个长 key 会成为同一个身份，点一条出两条详情，前后快照的比较也会混淆。
   - 快照：key 不超过 80 个字符时保持原样；超长时取前 71 个字符，加 `#` 和整个 key 的 FNV-1a 哈希。展示名另行截断。
   - 规范化：旧记录中已经相撞的 key，后出现的加编号，不丢行。
   - 已重新打包 agent-core 与手机场景。
3. 🟡 首次打开时，作战大屏还没创建，记住的区域没有被应用；三维场景是异步加载的，即使区域已恢复，相机也没有对准。
   - `executionPanel.js`：作战大屏创建时立即 `restore` 当前任务记住的区域；
   - `warRoom.js`：三维场景创建后，如果当前打开的是区域详情，补一次 `focusRegion`。

测试（每条都先在修复前的代码上失败）：
- `src/shared/warRoom.test.js`：用 Android 便携记录器、桌面 `finishExecutionScene`、iPhone 的补写回执，以及共享核心的 `completionReceipt` 生成 18 种真实结束场景，逐一核对显示。C8 版本在此用例上失败。
- `shared/agent/taskSpaceSnapshot.test.js`：前缀相同的长 key 保持唯一、确定、不超过 80 个字符；旧记录中相撞的 key 修复后三行都在。改回直接截断时失败。
- 浏览器验收：写入「上次看的是分析与计算」后首次打开，相机停在该区域，作战台进入详情。去掉场景加载后的对准时超时失败。

门禁：
- 快速档 `run-QtcVtL`：JS 4 998 / 4 998；Android 四项、设置浏览器验收、Swift 38 组（加载的 agent-core 为 394 617 字节）全部通过。
- 集成档 `npm test -- --base d5c596e` → `run-pHTRku`：JS 591 / 591 个文件、4 998 / 4 998 项，0 失败 0 跳过；文档链接、生成器与共享渲染预检、Android 四项、设置浏览器验收、Swift 38 组全部通过。

### 第三次推送门禁评级 C 与修复（C10，2026-11-06）

重跑 `git pp`，评级 C（「数据展示与跨任务隔离仍有缺陷」），推送被阻止。三条都已复现并修复。

1. 🟡 合同覆盖的分母只取合格候选，而合格本身要求必填字段全部核实，所以每个字段恒为 100%。复现：1 个合格、1 个缺地点，地点仍显示 100%。
   - 新纯函数 `fieldCoverage`（`src/shared/warRoom.js`）：分母是快照所带的未排除候选（主推、备选、合格、待补），分子是其中该字段已核实的。
   - 雷达图与字段追踪用同一个函数。追踪清单列出参与统计的候选，并注明「已核实 x / y」。
   - 快照没带上的候选在 `outside` 中单独注明，不计入统计，也不对它们做任何假设。
2. 🟡 候选飞入的定时器只检查作战大屏是否打开。切换任务后旧任务的候选会飞进新任务；关闭后重开，关闭前排好的飞入还会再播一次。
   - 定时器登记在集合里，带任务编号与代次；切换任务、关闭、释放时全部取消。
   - 关闭时把待落地的行直接显示出来；定时器触发时再核对任务与代次。
3. 🔵 成员的任务只从 `input` 读，而 iPhone（`AgentLoop.swift`）把运行中成员的任务写进 `output`，结束时汇报还会覆盖它，导致分派卡空白。
   - iPhone 改为与桌面、Android 一致：阶段事件新增 `input`，经 `ChatStore` 传到 `ExecutionRecord.recordStage`；合并阶段时，空 `input` 不覆盖已有的任务。
   - 旧的 4 参数 `onStage` 回调仍然收到任务文本。
   - 投影层 `sceneMembers` 兼容旧 iPhone 记录：没有 `input` 且仍在运行的阶段，把 `output` 当任务，汇报留空。

测试：
- `src/shared/warRoom.test.js`：合格、待补、排除混合时地点为 50%、名称为 100%，字段追踪只列前两类。原有两处字段追踪的预期改为新口径。
- `src/shared/executionBoard.test.js`：三端的成员任务读法一致；旧 iPhone 记录运行中也有任务；汇报不覆盖任务。
- `ios/Tests/ExecutionTests.swift`：成员阶段的任务记在 `input`，完成后仍在，汇报在 `output`。
- `desktop-ui/executionPanel.test.js`：用一个替身渲染器（jsdom 无 WebGL，否则作战大屏走无 3D 降级、不排动画）验证：
  - 切换任务后旧任务的候选不飞入；
  - 关闭再重开不补飞，被接纳的行已显示；
  - 覆盖率显示「地点 50%」，字段详情为「已核实 1 / 2」；
  - 旧 iPhone 记录的分派卡显示任务。

变异检验（测完都恢复原文件）：

| 变异 | 结果 |
| --- | --- |
| 定时器回到只检查是否打开 | 面板用例失败 |
| 覆盖率回到只算合格候选 | 两例失败 |
| 成员任务只读 `input` | 两例失败 |

门禁：
- 快速档 `run-WR410h`：292 个文件，JS 2 459 / 2 459；Android 四项、设置浏览器验收通过；Swift 38 组通过，其中 22 组重新编译，用时 535 s。
- 集成档 `npm test -- --base d5c596e` → `run-GagU9S`：JS 591 / 591 个文件、5 001 / 5 001 项，0 失败 0 跳过；文档链接、生成器与共享渲染预检、Android 四项、设置浏览器验收、Swift 38 组全部通过。
- iOS 模拟器无签名 Release 构建：BUILD SUCCEEDED，改动的 Swift 文件无告警。日志 `gates/ios-simulator-unsigned-build-c10.log`。
