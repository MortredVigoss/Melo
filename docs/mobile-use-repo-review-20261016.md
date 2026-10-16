# Melo Repo 审视与 Mobile Use 下一步

日期：2026-10-16 · Branch：`codex/mobile-use-features` · Baseline：`964bc7bfe3e0745ce329845ce570696475c63895`

下一步优先完成 Mobile Use 的可验证执行闭环，再接入聊天；同步修测试基线与平台契约。

以本地 964bc7b 的实际源码、关键路径与 Fixture 为依据；覆盖 Node/桌面、iOS、Android、同步协议、构建与测试。不是逐行审查全部 1,233 个文件，也不是完整安全审计或实机任务成功率评测。

## 下一步

### A — 先做 Mobile Use Core v1

把“能发 Tool Call”推进到“能证实目标完成、解释失败并可靠停止”。

- TaskOutcome 与目标验收：区分 achieved / blocked / needs_user。
- 动态 UI 目标验证、稳定等待、无进展检测与有界恢复。
- 执行端授权边界、可脱敏的步骤诊断与 Context budget。

验收：用普通 Android Fixture 与 Fold6 分别验证：设置搜索、目标 App 启动、目标不存在、加载页面点击、折叠后重定位、取消在途请求；逐项记录真实成功/受阻，不用 Tool 成功数冒充任务成功率。

依赖：可并行处理本地测试基线；本阶段不依赖增加多 Agent 或更换 LLM。

### B — 再把操作接入聊天

实现你最初想要的单一对话入口，同时保留清晰的运行与设备所有权。

- 先修跨对话 Job / UI busy 不一致。
- 捕获 chatId、Agent、project、connection 与设备授权上下文。
- 聊天内显示计划/动作/结果卡片；一个 DeviceLease 串行控制屏幕。

验收：A/B 普通对话并发、取消隔离；屏幕任务互斥明确；选定模型/角色不串；停止和返回历史可用。

依赖：建立在 A 的状态与事件接口上，再调整 UI。

### C — 并行补工程基线，再扩功能

让后续 Mobile Use 改动得到正确平台的回归保护。

- 修/界定 WSL 文件身份复用问题，配置 Chrome/Ruby 等测试依赖。
- 将 Android JVM/Lint/Debug 与 Emulator gate 接入按边界检查及 CI。
- Kotlin 共享行为契约、能力矩阵；存储先基准再增量化。

验收：六项文件身份测试通过；Android 代码故意破坏时 gate 必红；共享语义的 mutation 同时触发三端对应测试。

依赖：文件安全与测试工作单列，不将 Node 文件工具失败归因给 Android Accessibility。

## 本轮验证结果

- **本轮 npm run test:unit — 有失败**：3,642 tests：3,608 pass / 15 fail / 19 skipped；约 69.8 秒。 8 个浏览器入口缺 macOS Chrome 默认路径；1 项缺 Ruby；6 项文件身份替换测试失败。未隐藏或隔离失败。
- **本轮独立文件安全重跑 — 失败复现**：6 tests：0 pass / 6 fail。 单线程、临时目录 Fixture；排除“只有全套并发才出现”的解释。
- **本轮 inode 对照探针 — 观察证据**：不持有 FD：20/20 编号复用；持有 FD：0/20。 只代表本机 WSL /tmp；不外推 macOS、Android 或其他文件系统。
- **合并后的既有基线 — 此前通过**：36 JVM + Debug；90 mobile-sync；41 schema/contract。 是本会话上一轮同运行时代码的结果；本次没有再跑 Android runtime / Release。
- **Fold6 / iOS / 完整发布 — 本轮未测**：未操作手机、未调用真实模型、未运行 npm run test:full。 0.2.3 曾实看 Home 回到 Launcher；Hearthstone 启动复测中断，未证明游戏成功打开。

## 架构与可保留基础

### Node / desktop

`Swift shell / CLI / channel → Node services → chat execution → providers / tools`

主业务核心；工具、权限、记忆与团队功能集中在这里。 WSL 文件身份测试与依赖可移植性需修；桌面 UI 入口是维护热点。

### iOS

`SwiftUI → ChatStore → 本机模型 / 本机数据工具 ↔ mobile-sync`

独立请求路径；近期已有按对话并发与团队相关实现。 本轮没有 macOS/Xcode/实机验证；不要把源码存在当作当前实体机通过。

### Android

`Compose → ChatEngine 或 DeviceAgent → provider / AccessibilityService ↔ mobile-sync`

独立聊天、基础共享同步、原生跨 App 屏幕工具已经形成。 执行结果语义、动态 UI 与恢复、会话关联、平台 gate 仍需完善。

- **原生手机工具基础已经可复用**：真实 AccessibilityService、截图/UI tree、节点/坐标操作、App 全量分页与搜索、显示屏边界、取消/息屏停止已存在。先加可靠状态与验收，不需要另造 ADB/Root/AutoInput 运行时。
- **Node 执行器有明确权限与上下文边界**：executeTool 从执行上下文收窄 capability / workspace，串接授权、取消、任务操作记录；模块化业务服务与多 Agent 继承约束已经存在。
- **同步与凭证隔离已有防线**：共享 v1 schema/Fixtures、冲突与删除确认、Keystore AES-GCM、禁止生产 HTTP/Redirect、资产 WebView origin 限制均有源码与测试。继续保留这些边界。

## 发现与源码证据

### [P1] M01 — 模型结束回答与目标完成尚未分开

证据层级：代码确认

触发：先 observe 成功，再返回“无法找到目标”；或一次动作失败后 observe 成功，模型结束。

影响：DeviceAgent 只要求至少一个成功 Tool，最后一个 Tool 不失败就保存 completed。UI 文案“模型已结束任务”较谨慎，但没有结构化目标达成证据，后续恢复与统计不能据此判断成功。

建议：增加显式 TaskOutcome：achieved / blocked / needs_user / cancelled / failed；结束回执必须关联目标检查与最新 observation。先以可验证的小目标建立成功条件。

验收：Fixture 中“observe 成功但目标未达成”不能记为 achieved；失败后单纯重新观察不能抹掉未解决的阻塞。

源码：`android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:49`；`android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:59`；`android/app/src/main/java/com/melo/android/device/DeviceAgentScreen.kt:56`

### [P1] M02 — 内容变化校验过于粗，动态 UI 的可操作性仍待验证

证据层级：代码确认 + 待实机验证

触发：LLM 思考期间，同一个窗口发生任意内容事件；目标按钮本身可能没有改变。

影响：generation 的任何变化都会拒绝 tap/type_text/swipe/back。Home 已在 0.2.3 单独修复，不能当成当前未修问题；其余动作仍可能被进度、倒计时或动画阻断。现有测试证明拒绝旧坐标，却没有证明持续更新页面仍能可靠执行。

建议：区分节点动作与像素动作：节点动作检查目标身份、内容、bounds 与窗口；坐标动作保留严格画面校验并在失效后重新定位。增加稳定等待和有界重定位，保留取消与密码保护。

验收：在持续更新的 Fixture 中点击未变按钮成功；目标移动/变更时拒绝；Fold 尺寸变化后重新观察与定位。

源码：`android/app/src/main/java/com/melo/android/device/MeloAccessibilityService.kt:65`；`android/app/src/main/java/com/melo/android/device/MeloAccessibilityService.kt:116`；`android/app/src/main/java/com/melo/android/device/MeloAccessibilityService.kt:138`；`android/app/src/androidTest/java/com/melo/android/DeviceAgentTest.kt:98`

### [P1] M03 — 敏感动作确认目前主要是 Prompt 约束

证据层级：代码确认；未执行真实敏感动作

触发：模型输出合法的 tap，而目标恰好是发送、删除或购买。

影响：DeviceTools 的指令要求适时停止确认，但执行器只有 session/节点/密码等检查，没有独立的 pending-approval 状态与原生确认 ticket。不能把 Prompt 当成执行端的强制边界。

建议：明确支持范围与风险策略；需要新授权的动作在原生层进入 needs_user，确认绑定当前任务、目标和动作。用户已明确授权的同一动作不重复确认；不能假设坐标本身能完整表达业务风险。

验收：敏感操作 Fixture 在缺少所需授权时不触发回调；取消、过期 observation 或修改参数后旧确认不能复用。

源码：`android/app/src/main/java/com/melo/android/device/DeviceTools.kt:34`；`android/app/src/main/java/com/melo/android/device/MeloAccessibilityService.kt:123`；`android/app/src/main/java/com/melo/android/device/MeloAccessibilityService.kt:138`

### [P1] C01 — 切换对话后发送可能被静默丢弃

证据层级：代码确认

触发：A 对话正在生成，切到 B 输入并点击发送。

影响：UI 的 busy 仅比较当前 chatId，B 的发送按钮可以点击；ChatEngine 却使用全局单个 turn Job，发现 A 仍运行就直接 return。B 的消息不会进入发送路径，也没有排队或错误提示。

建议：改为按 chatId 管理 Job/运行状态，或明确排队并反馈。普通聊天可按对话并发，设备操作仍由单一 DeviceLease 串行拥有，避免多个会话争用屏幕。

验收：两个 HTTP Fixture 对话可并发；取消 A 不影响 B；设备控制同时只能有一个 owner，另一任务应明确排队或拒绝。

源码：`android/app/src/main/java/com/melo/android/chat/ChatEngine.kt:18`；`android/app/src/main/java/com/melo/android/chat/ChatEngine.kt:28`；`android/app/src/main/java/com/melo/android/MainActivity.kt:160`；`android/app/src/main/java/com/melo/android/MainActivity.kt:204`；`ios/Melo/ConcurrencyVerification.swift:30`

### [P1] S01 — WSL 下六项文件身份替换测试稳定失败

证据层级：测试复现 + 临时目录对照

触发：授权前后，目录或文件被删除并在相同路径重建，文件系统复用 inode。

影响：六项拒绝替换的测试在全量和单独重跑中均失败。临时目录实验：不持有 FD 时 20/20 复用 {dev,ino}，持有 FD 时 0/20。当前 checked helper 在执行时才打开父目录并比较编号，因此编号复用会破坏“新对象必然有新编号”的前提。这是本机 Linux/WSL 证据，不是 macOS 复现，也不等于 Android 的 Accessibility 点击漏洞。

建议：单独修复/界定 Linux 文件身份保障：在授权边界保持可验证的对象身份与目录锚点，检查生命周期和释放；补充确定性的编号复用测试。不要把失败直接 skip，也不要用单一时间戳假装原子性。

验收：六个失败用例在同一 WSL 文件系统通过；编号复用及父目录替换仍被拒绝；验证修复前后合法文件操作与取消均无回归。

源码：`src/safety/dirfdOps.js:371`；`src/safety/dirfdOps.js:394`；`src/safety/dirfdOps.checked.test.js:66`；`src/tools/builtins/phase2a.fileTools.test.js:331`；`src/tools/builtins/phase2a.fileTools.test.js:1314`

### [P1] Q01 — 日常检查未自动执行 Android gate

证据层级：代码确认 + 选组函数探针

触发：只修改 Android Kotlin 文件后运行 npm test。

影响：test-plan 将其归为完整 JS/浏览器/Swift 检查，没有 Android 分支；完整发布脚本也未发现 Android 调用。独立 check:android 已存在，但依赖人工执行。仓库中未发现已跟踪的常见 CI 配置。另有环境声明差距：package.json engines 仍为 >=18，README 已要求 Node >=22.13。

建议：把 Android JVM/Lint/Debug 接入按边界的日常 gate，runtime 放在明确的 Emulator job；SDK 不可用时明确报告未验证。为 Windows/WSL/macOS 配置浏览器与解释器前置检查，并对齐 engines 与已验证的 Node 基线。

验收：Kotlin 语法故意破坏时对应 gate 必红；Android 改动不能仅凭 JS/Swift 成功而绿；测试输出列出实际运行平台。

源码：`scripts/test-plan.js:5`；`scripts/verify-daily.js:30`；`scripts/android.mjs:7`；`scripts/verify-red-green.js:1`；`desktop-ui/agentPersona.browser.test.js:23`；`package.json:7`

### [P2] M04 — 恢复主要按连续 Tool 错误计数，缺少无进展检测

证据层级：代码确认

触发：失败动作之后重新 observe 成功，再重复同一个失败动作。

影响：成功 observe 会把 errors 清零；app_not_found 有一次专用补充，其余失败没有通用策略状态。30 次 / 10 分钟上限仍有效，但可以消耗预算反复做同类尝试。

建议：保存当前阻塞、已尝试策略和屏幕/目标变化；按任务进展而非单个 Tool 成功重置；输出 stale_screen / target_missing / permission / timeout 等结构化原因。

验收：重复“observe → 同一失败点击”触发策略切换或明确受阻；不能仅靠 observe 清除阻塞，也不无限重放非幂等动作。

源码：`android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:40`；`android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:50`；`android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:75`

### [P2] M05 — 执行记录不足以解释选错目标或消耗

证据层级：代码确认

触发：用户回看失败，只看到 observe / open_app 与通用“执行回执已返回”。

影响：DeviceStep 只有 action/ok/detail/at；没有 Tool Call ID、具体目标、阶段耗时、阻塞分类或模型用量。查询已增加数量摘要，但通常不能从历史精确还原用了哪个关键词/目标。

建议：增加可脱敏的诊断字段与按需导出：callId、screen revision、目标 package、目标定位类型、duration、错误代码、已报告用量。继续默认不保存原始截图、UI tree、输入内容或凭证。

验收：能从一条本地记录定位“哪个步骤因何失败”；导出不含测试 secret、图片或输入框内容；未知 Token/费用保持未知。

源码：`android/app/src/main/java/com/melo/android/device/DeviceTools.kt:16`；`android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:68`；`android/app/src/main/java/com/melo/android/device/DeviceAgentClient.kt:12`

### [P2] M06 — 旧 UI tree 全保留，缺少 Context / Token budget

证据层级：代码确认；未测长任务质量

触发：多步任务不断追加包含大量节点的 observation。

影响：appendResult 删除旧图片，但保留旧工具 JSON（包括 UI tree）；循环只限制次数/时间，没有请求 Context budget 或压缩策略。长任务可能堆积过期节点与较大输入，具体费用和任务成功率尚未测量。

建议：保留最新可执行 observation、紧凑动作摘要和未解决阻塞；压缩旧 tree，保留 Tool Call/Result 协议配对；增加输入预算与 usage 统计。

验收：构造 30 步多节点 Fixture，输入保持有界；工具回执配对不丢，旧节点不能当作当前可执行目标。

源码：`android/app/src/main/java/com/melo/android/device/DeviceAgentClient.kt:96`；`android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:43`

### [P2] P01 — 聊天内嵌需要统一上下文，不能只搬页面

证据层级：产品缺口 / 代码确认

触发：希望在当前角色、项目和模型的聊天里直接操作手机。

影响：当前 Device 是独立 Page；普通 ModelClient 不带手机 Tool，DeviceAgent 则读取全局模型设置，只接收 goal。没有 chatId / Agent / project / 每条消息模型上下文的任务关联。当前页面明确写全局模型，因此这不是它违反现有 UI 承诺。

建议：建立不可变 DeviceTaskContext；把计划、动作、结果和取消挂到当前消息的事件流。显式启用手机操作，保留普通对话；DeviceLease 保证单设备任务互斥。

验收：当前会话选定的连接/角色被任务捕获；切换页面不串任务；聊天卡片可查看进度和停止，单设备 owner 清楚。

源码：`android/app/src/main/java/com/melo/android/MainActivity.kt:91`；`android/app/src/main/java/com/melo/android/device/DeviceAgentScreen.kt:31`；`android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:27`；`android/app/src/main/java/com/melo/android/chat/ChatEngine.kt:58`

### [P2] D01 — 本地存储是整个 AppData JSON 的单行更新

证据层级：代码确认；未做性能基准

触发：聊天流式运行每秒 checkpoint，输入草稿也触发保存。

影响：Room documents 只有一个 state payload，每次 Repository.change 都编码整个 AppData 并写入。写入量随历史增长；这不是已证实的当前卡顿原因，不用行数估计真实 Latency。

建议：先量测有代表性的聊天/历史大小；达到阈值后拆分 message/run/draft 的增量写入，限制 checkpoint 频率，保留事务与恢复语义。

验收：提交前给出写入字节和 P95 的前后基准；运行中断、草稿恢复、删除与同步一致性测试保留。

源码：`android/app/src/main/java/com/melo/android/data/Storage.kt:16`；`android/app/src/main/java/com/melo/android/data/Storage.kt:63`；`android/app/src/main/java/com/melo/android/data/Repository.kt:33`；`android/app/src/main/java/com/melo/android/chat/ChatEngine.kt:54`；`android/app/src/main/java/com/melo/android/MainActivity.kt:168`

### [P2] A01 — 基础同步共享了契约，新增行为还缺 Kotlin 同等覆盖

证据层级：代码确认 / 平台差距

触发：主线新增 Agent capability sidecar、团队交接、工具 replay 等行为。

影响：Android 已读共享 schema 并覆盖基础 v1 Fixtures，不能说它完全没有共享契约。但新 crossPlatformContracts 测试及生成器主要面向 JS/Swift，Android Agent 数据结构仍是较早的人设字段。拉取主线不等于已移植这些能力。

建议：增加 Kotlin 行为契约 runner 与平台 capability matrix；优先共享数据与状态语义，执行器留在原生。按实际产品需要移植可选 AgentSettings 通道，避免现在为齐功能扩张团队执行。

验收：同一 contract mutation 能让 JS/Swift/Kotlin 对应检查失败；明确每个平台支持/不支持的能力，旧 v1 客户端兼容不退化。

源码：`scripts/generate-sync-contract.js:20`；`mobile-sync/crossPlatformContracts.test.js:1`；`android/app/src/test/java/com/melo/android/SharedContractTest.kt:1`；`android/app/src/main/java/com/melo/android/data/Models.kt:16`

### [P3] A02 — 桌面 UI 的 app.js 是明显维护热点

证据层级：代码统计与入口抽查

触发：同一个 UI 入口继续承载多个功能表单、事件和渲染逻辑。

影响：desktop-ui/app.js 有 13,447 个物理行；同时已经有很多独立 helper。体积是变更风险信号，不是缺陷或质量评分。Mobile Use 无需先重写这部分。

建议：按以后实际改动的功能边界抽取 controller/view；遵循本仓库 byte-for-byte port → 回归 → 独立行为修改的规则，保留现有 Node 服务边界。

验收：每次抽取能证明行为不变，相关浏览器流程通过；不以文件变小替代功能验收。

源码：`desktop-ui/app.js:1`；`CLAUDE.md:79`

## 范围与统计口径

Tracked code files; physical lines including comments/blank lines; test path conventions classified separately; excludes binary/assets/node_modules/build output.

已跟踪文件 1233；Android source 2511 行 / tests 899 行；Node src source 77538 行。行数用于定位变更体积，不能当作质量或性能评分。

测试与探针只使用临时 Fixture；本轮未改产品行为、用户数据、凭证、真实连接或实机。证据日志路径：

- `work/melo-repo-review-unit.log`
- `work/melo-review-filesafety-isolated.log`
- `work/melo-inode-probe.json`
- `work/melo-review-inventory.json`
- `work/melo-mobile-branch-android.log`
- `work/melo-mobile-branch-sync.log`

## 重现入口

```bash
cd /home/zhouy/workplace/Melo
npm run test:unit
MELO_TEST_MODE=1 node --test --test-concurrency=1 --test-name-pattern="parent rmdir|parent-swap|inode mismatch|final-unlink" src/safety/dirfdOps.checked.test.js src/tools/builtins/phase2a.fileTools.test.js
```

inode 对照探针（临时目录；不操作用户文件）：

```js
import {mkdtempSync,mkdirSync,statSync,rmdirSync,rmSync,openSync,closeSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'melo-review-inode-'));
const result={scope:'Local WSL /tmp filesystem; synthetic temporary directories only',trials:20,withoutPinnedFd:{reused:0},withPinnedFd:{reused:0}};
try {
  for(const pin of [false,true]) for(let i=0;i<result.trials;i++) {
    const dir=join(root,`${pin?'pinned':'unpinned'}-${i}`);
    mkdirSync(dir);const before=statSync(dir);
    const fd=pin?openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY):null;
    try {
      rmdirSync(dir);mkdirSync(dir);const after=statSync(dir);
      if(before.dev===after.dev&&before.ino===after.ino) result[pin?'withPinnedFd':'withoutPinnedFd'].reused++;
    } finally {if(fd!==null)closeSync(fd);rmdirSync(dir);}
  }
  console.log(JSON.stringify(result,null,2));
} finally {rmdirSync(root);}
```

本报告 P1 表示后续可靠运行或验收前应优先处理，包含已确认缺陷与需验证的设计边界；不表示全部是已利用的安全漏洞。
