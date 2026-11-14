# 死代码清理第二轮与检测提速（2026-11-14）

用户原话："去逐行扫描代码 看一下有没有废的空的没用的 帮我清理掉 然后看看有什么优化空间 每次检测太久了"。

源码基准：master `cc9a982e`（已含 Codex 11-12 那一轮的 `11e8939e`，见[上一轮记录](dead-code-audit-20261112.md)）。本轮没有推送、没有覆盖安装、没有读写正式数据目录 `.tmp/melo-home-user`。

## 1. 结论

- 清理：手写代码净减 **3,579 行**（桌面服务与共享内核 −1,239、桌面界面代码 −522、样式表 −1,381、翻译表 −140、Android −96、iPhone −159、根目录脚本 −42），随之重新生成的打包文件 −5,975 行。删除 23 个文件（其中 3 份是随死模块一起删的专属测试）。界面 38 张截图逐像素一致。
- 没动的：只有测试在用的代码、已停用功能的整套代码、未被引用的素材，共 30 多项，列在第 5 节等用户决定。
- 检测：
  - 过去 150 次有记录的运行里，「快速档」122 次有 76 次（62%）被扩大成全量。按新规则回放其中 88 次能还原改动清单的运行，跑全量的从 72 次降到 11 次。
  - 全量门禁 285 秒 → 237 秒；一个界面文件的快速档 5.5 秒。
  - Swift 38 组全部重新编译并执行：150 秒（以前 551 秒）。
  - Swift 测试缓存从不清理，已攒到 4.8 GB；现在每组只留最近用过的 4 份（当前一整套 113 MB）。
- 阅读时发现并核实的真实问题 12 个、未逐条核实的 30 多个，本轮都没有修，列在第 7 节。

## 2. 范围、方法与审计边界

### 2.1 做了什么

1. **机械扫描（全部 JS）**：1,350 个 JS / MJS 文件用 Acorn 解析、eslint-scope 做作用域分析，建立导入图（含桌面界面经服务路由引用服务端模块的映射），输出：没人导入的文件、只有测试导入的产品文件、没人导入的导出、未读取的绑定、空函数 / 空分支。解析错误 0。工具：`.tmp/dead-code-claude-20261114/scan-js.cjs`、`graph.cjs`、`hints.cjs`。
2. **逐行阅读（分片交给子代理，结论由主线程核对）**：机械扫描看不出来的东西（永远走不到的分支、只写不读的字段、没人传的参数、重复实现、过期注释、已停用功能）靠读。各片读到什么程度见 2.2。
3. **删除标准**：只删"产品代码和测试都没有任何引用"的；整份模块唯一的引用方是它自己的专属测试时，连同那份测试一起删并在第 3.3 节列出。"只有测试在用"、"功能已停用但代码还在"、"重复 / 空壳"一律不删，进第 5 节。
4. **每一处删除的证据**：全仓按名字搜索（所有语言、字符串、JSON、HTML），排除项只有 `.tmp/`、`node_modules/` 和生成的打包文件。
5. **独立复核**（主线程自己做，不采信子代理的自述）：
   - 样式：512 个被删选择器，421 个确认没有任何代码能产生其中的类名 / 属性；其余 91 个按证据类别逐条看（恒为假的结构条件、被后面同名规则完全覆盖、只有选择器字符串没有产出）。
   - 翻译：135 个被删的键，9 个是重复行（保留行的值与生效值相同），126 个在 JS / Swift / Kotlin 里没有引用。子代理判为没人用的 `补充：%@` 实际被 `ios/Melo/ChatStore.swift:902` 使用，已保留。
   - 界面事件：被删的 17 个事件名里，提交版本中只有那份打不开的右键菜单自己会发出其中两个。
   - 导入：7,632 处具名导入全部能解析到真实导出（`check-imports.cjs`）；界面从服务端模块导入的 120 个名字逐个动态导入核对。
   - 截图：见第 4 节。

### 2.2 覆盖清单

| 范围 | 文件 / 行 | 机械扫描 | 逐行阅读 |
| --- | --- | --- | --- |
| `src/services/**` | 146 个产品文件，约 25,600 行 | 全部 | 全部 |
| `src/tools/**`、`src/safety/**` | 63 个，20,959 行 | 全部 | 全部 |
| `src/` 根目录、`agents`、`domain`、`state`、`http`、`shared`、`runtime`、`development`、`tasks`、`persistence`、`reminders`、`plugins` | 约 160 个，约 21,170 行 | 全部 | 全部 |
| `src/memory`、`media`、`images`、`retrieval`、`search`、`web`、`mcp`、`providers` | 113 个，约 21,000 行 | 全部 | **第一遍只读了约四分之一**（子代理写明"时间预算"）；补读见第 9 节 |
| `shared/**` | 51 个，5,632 行 | 全部 | 全部 |
| `scripts/**`、`mobile-sync`、`desktop-pet`（自有部分） | 约 228 个 | 全部 | 门禁与生成脚本全部；16 个较长的冒烟 / 模拟 / 基准脚本只读了结构，补读见第 9 节 |
| `desktop-ui/**/*.js` | 145 个，26,582 行 | 全部 | 全部 |
| `desktop-ui/**/*.css`、`index.html`、`translations.js` | 22 份样式表 9,023 行 | 自写解析器 | 全部 |
| Android `android/app/src/main/**/*.kt` | 78 个 | Kotlin 编译警告、Lint、R8 清单 | 全部 |
| iPhone `ios/Melo/*.swift` | 106 个，18,781 行 | Xcode 索引可达性 | 全部 |
| `desktop-app/*.swift`、`ios/scripts`、`ios/SceneSource`、`ios/UITests` | 约 20 个 | — | 全部（只读，未改） |

### 2.3 未覆盖清单与原因

- 测试文件（710 个）：只做了机械扫描（删了 31 处没用的导入和 1 个没用的辅助函数）。测试里 34 处没读取的局部变量没有动，多数是为了副作用而调用的返回值。测试断言是否真的验证了它声称的东西不在本轮范围。
- `ios/Tests/*.swift`（38 个）：只做机械检查，没有逐行读。
- 生成文件、第三方代码（`desktop-pet/upstream`、Gradle wrapper）、`native/dirfd_ops.cc` 的函数体：不在范围。
- C++、Python、Shell：读了，但没有做语言级的静态分析。
- 没有做的验证：真机、真实模型、桌面应用启动（数据目录待恢复，见第 8 节）、iPhone 模拟器界面操作。iPhone 侧只有模拟器 Debug 构建和 38 组宿主测试。
- Android 设备测试在无窗口模拟器上跑了一遍（`878b2ba8` 之后）：144 项，140 通过，4 项失败，与 11-10 那一轮是同样的 4 项（两项需要真实模型凭证，一项需要仓库外的桌宠素材，一项等待一个从不存在的元素），没有新增失败。
- 机械规则扫描（`scripts/audit-inventory.mjs`）相对本轮开始前：没有新增命中；关闭 1 项（H5，iPhone 里一个没人用的地址常量）；H14 一增一减是同一条规则的文字变了。

### 2.4 停止条件

到这些边界就停，不删：持久化 / 同步的数据字段与迁移；`shared/protocol`、`mobile-sync`、`shared/agent` 的线格式；模型可调用的工具定义；HTTP 路由；Worker 与子进程入口；按名字查表的注册项；写明理由的空实现；用户保留的产品决定（主 Agent 路由与整合、不自动切换模型、Telegram / Discord 归档但保留配置与历史）。

## 3. 清理明细

逐条证据在本机 `.tmp/dead-code-claude-20261114/`（各片报告，见第 10 节）；这里只列类别和有代表性的条目。

### 3.1 桌面服务与共享内核（172 个文件，−1,239 行，含第 9 节补读落实的部分）

- **10 个转发文件**（只有测试还在用旧路径）：`src/services/{agent/agentChannels,agent/agentTools,agent/markdownFiles,approval/approvalService,chat/turnArchive,message/messageBlocks,project/projectService,settings/localPreferences,skill/skillService}.js`、`src/state/{derivedSnapshot,memorySnapshot}.js`；测试改为导入真实模块。
- **3 个整份死模块**：`src/serverGuard.js`、`src/agents/pendingSkillDrafts.js`、`src/services/search/sharedFetchAdapter.js`。
- **17 条只为"保留模块初始化"而留的空导入**：逐个确认目标模块没有顶层副作用后删除。
- **没人调用的函数与常量**（约 95 处），例如：`pruneMemoriesByNamespaceKind`、`indexMessages`、`deleteThreadCheckpoint`、`reassessAttic`、`shouldCompact`；`dirfdOps` 的 `withParentDirFd` / `atomicRename` / `atomicMkdir` / `atomicUnlink` / `atomicSymlink`；`fileSafetyGate` 的 `precheckParentDir` / `assertParentDirUnchanged`；`getToolsByCategory`、`containsSecret`、`explainSkillMatches`、`getCodexAccessToken`、`agentPresetById`。
- **只写不读**：`prepareNode` 返回值里的 `memoryCandidates` / `systemPrompt` / `turnContext`、`missingHostedEvidence`、`turnLedger` 的 `fresh`、启动数据里 13 个界面不读的字段。
- **走不到的分支**：`server.js` 的 `otherInstances` 分支、`openai.js` 与 `codexImageEngine.js` 里针对旧 Node 的回退、两处只重新抛出的 `try/catch`。
- **共享内核**：没人调用的操作 `runtimeMessage`、`skills`、`inlineSpans`，意图动作 `translation` / `greeting`，预算动作 `describe`，`legacy-search` 路线。打包后 46 → 45 个模块。
- **112 个只在本文件内使用的符号去掉 `export`**（与界面那边的 143 个同样处理）。
- 34 处没读取的导入。

### 3.2 桌面界面（代码 66 个文件 −522 行；样式 15 个文件 −1,381 行；翻译 −140 行）

- 代码：打不开的"最近对话"右键菜单及其两个动作（入口 `.recent-item` 在旧侧栏移除后已不存在）；没有任何标记会发出的 15 个事件分支（含记忆页"连接外部向量服务"表单的处理）；永远为假的分支；143 个符号去掉 `export`；转发文件 `desktop-ui/html.js`。
- 样式：407 条没有任何元素能匹配的规则（旧侧栏、旧顶栏、对话内三维舞台、"任务空间方案 C"看板等）、16 条被后面同名规则完全覆盖的规则、92 个没人读取的自定义属性、2 段没人引用的动画。样式表 9,023 → 7,643 行。
- 翻译：桌面表 126 个没人用的键、5 行重复；手机原生表 12 行没人用。生成的字符串目录 2,274 → 2,262 条。

### 3.3 连同专属测试一起删除的 3 份测试

`src/serverGuard.test.js`、`src/agents/pendingSkillDrafts.test.js`、`src/services/search/sharedFetchAdapter.test.js`：被测模块在产品里没有任何引用，测试是它唯一的使用者。没有删除、跳过或放宽其它任何测试。为跟随删除而改的断言：`scripts/generate-module-map.test.js`（消费方清单）、`desktop-ui/appSwitchFreeze.test.js`（基线清单按其文件头的规定缩小 12 个名字）。

### 3.4 Android（25 个文件，−96 行）与 iPhone（24 个文件，−159 行）

- Android：`SmartRoutingSettings.kt`（没有任何构造处）、只写不读的变量、21 处没用的导入、`ACTION_STOP_SPEECH`、`PetSpeechInput.cancel()`。JVM 243 项、Lint、Debug、Release、设备测试编译通过。
- iPhone：`SmartRoutingSettings.swift`（唯一调用处已在 `81ae41a5` 删除）、`CoreView`、`PhoneIntent` 里已迁到共享内核的三个函数及只为它们服务的契约字段、只写不读的 `iterations` / `spentTokens` / `evidenceId` / `replyStatus` 等、5 处没用的导入、一个抛不出来的 `catch`。
- iPhone 一处要知道的影响：删掉没人读的 `replyStatus` 后，不带状态键的请求结束时不再触发一次没有内容变化的界面刷新通知。

### 3.5 根目录与脚本

`check-voice.js`、`check-voice.cjs`、`viz-module-check.mjs`；`package.json` 里 13 个没人引用的命令（12 个直接跑 `node --test` 的快捷方式和 `rebuild:voice`），剩 70 个。

### 3.6 删了又恢复的 4 处

- `src/memory/conversationIndex.js` 的 `unindexChat`：没人调用，但它正是修"已删除的对话仍可被搜到"所需要的函数（第 7 节），留着。
- 启动数据里的 `customVoiceBaseUrl`：界面经 `/shared/localServices.js` 的 `customVoiceActive(settings.config)` 间接读取，按名字搜不到；已恢复并加注释。
- `src/services/remote/telegramApi.js` 的 `telegramApiFormRequest` 的 `export`：一份测试在子进程脚本字符串里导入它，导入图看不到；全量测试发现后恢复，并对其余 111 个同类改动补做了"别处是否同时提到模块名"的排查。
- **提交后才发现的一处回归**：`878b2ba8` 删掉了向量提供方缓存包装上的 `probe`（证据是"没有任何 `.probe(` 调用"）。记忆的"检测"和"重建"是用 `provider.probe || provider.embed` 取它的，删掉后这两处改从缓存取向量：检测成功一次之后，即使模型已经不工作也会继续报"可用"。补读（第 9 节）发现，`06791f79` 恢复，并加了一条经过生产所用包装的测试（修复前为红）。
- 同一提交还带了一份过期的手机场景包清单：调整翻译表行序（为了不让规则扫描多报一条）之后没有重新生成场景包，当时只跑了定向测试。最终的完整校准在第一道预检拦下，重新生成后通过。
- 针对这一类盲区的补查：把 `878b2ba8` 删掉的 363 个定义按**整词**重新搜了一遍（不再只搜调用形式），其中 80 个 JS 名字在别处还有属性式的出现，逐个看过，都是同名的别的东西；Swift 和 Kotlin 的成员删除由编译保证。

## 4. 界面没有变化的证据

同一份种子数据、同一端口、同一数据目录路径，对清理前（`fab843a0`）和清理后的代码各拍 19 个页面 × 2 种宽度（1440、390）共 38 张截图，逐像素比较：**38 / 38 一致**。清理前自己和自己比两次是 37 / 38（手机宽度对话页有 322 个像素的抖动）。第一次比较有 2 张不同，原因是对照目录里没有被 Git 忽略的本地模型文件，补上后一致。

没有被截图覆盖的状态（菜单、对话框、执行中的面板、任务空间）靠 22 份浏览器测试和样式的静态证据。

## 5. 没有动、需要用户决定的

> 2026-11-14 当天稍后，用户对这一节和第 7 节的清单作了决定。逐项结果见本文第 11 节；下面保留当时的原文。

### 5.1 已停用或没有入口的功能（代码都还在）

| 项目 | 规模 | 现状 |
| --- | --- | --- |
| Telegram / Discord | 约 4,700 行产品代码、1,300 行测试，依赖 discord.js、@discordjs/voice、opusscript、prism-media、tweetnacl | 已归档，所有网络调用在入口被拦；配置与历史按用户决定保留。`server.js` 退出时仍导入 `discordVoiceRuntime` |
| 智能模型选择（自动切换） | 桌面约 26 处分支加 `routing.js`、`desktop-ui/smartRouting.js`；Android 引擎约 180 行；iPhone 约 260 行 | 开关恒为关，只有测试让它活着 |
| 旧版可视化（Demon viz） | `vizSpec.js` 约 400 行、`desktop-ui/viz/*` 2,870 行 | 不再生成，只为显示已保存的旧消息 |
| 记忆提供方栈 | `src/memory/providers/*` 约 820 行 | 输出没人读 |
| 外部向量后端（Ollama / OpenAI / 自定义） | 约 240 行，加 `POST /api/memory/connect` | 界面没有入口 |
| `store.js` 的 Stage-4 `validateContext` | 约 250 行 | 很可能是空操作 |
| 插件钩子、HTTP 后台命令任务、技能自升级应用接口、OpenClaw 凭证回退、`searchTask.js` | 各 90–320 行 | 没有调用方或没有入口 |
| 废纸篓的恢复 / 清除函数 | 约 380 行 | 只有测试调用，而 `file_delete` 的说明承诺可以恢复 |
| 聊天锁定 | 接口在 | 桌面界面没有入口 |
| 旧版桌面搜索规划器（`buildSearchPlan` 等） | `shared/agent/retrieval/searchRouter.js:156-340` 共 185 行，另有约 300 行测试断言它 | 产品只走共享规划，旧规划器只有测试在调用 |
| 第二套记忆状态工具 | `scripts/memory-status.js` 89 行、`src/memory/statusFormat.js` 229 行、测试 287 行 | 不是 npm 命令，也没有文档提到；`melo memory status` 用另一套代码渲染同一份数据 |
| Browserless 预设与"未锁定版本"机制 | 约 170 行产品代码、约 200 行测试（`src/mcp/presets.js`、`manager.js`） | 永远启用不了；文档已称它为旧占位 |
| `POST /api/mcp/connect` 接受请求体里的 `command` / `args` / `env` | `src/server.js:736` 的两个分支 | 桌面界面和手机都只发 `{name}`。这两个分支是"让服务启动任意命令且不落配置"的唯一入口，建议删掉 |
| 离线压缩探测三个本地模型服务 | `src/memory/offline/compact.js:24-29、180-192` | 只在"仅用本地服务"开关打开时走到；与"不自动探测外部应用"的约定不一致 |
| Agent 身份行写入记忆库并做向量 | `src/memory/snapshotBuilder.js:435-453` | 每个 Agent 都写，没有任何读取路径 |

### 5.2 只有测试在用的代码

导入图里 578 个导出只被测试导入。子代理按"刻意留的测试缝"与"失去了产品调用方"分了类，后者较大的有：`buildReActSystemPrompt`、`persistChatRuntimeFields`、`detectImageGenIntent`（与 `openai.js` 里的内联副本重复）、桌面界面的九个 Agent 动作和语音转写发送路径。清单在各片报告的"Only tests use it"一节。

### 5.3 没被引用的素材与脚本（约 7 MB）

`assets/options/*`、`assets/codex-reference.png`、`assets/Melo.iconset/`、`assets/brand/melo-black-ice-master.png`、`assets/melo-icon.svg(.png)`、`scripts/MeloLauncher.applescript`、`Melo.command`、`scripts/render-mark-options.swift`。`assets/personas/金冬天_voicePersonality.txt` 是用户内容，不建议删。

### 5.4 其它

- iPhone：约 20 个没人读的持久化字段（例如存进钥匙串却不用的 `CodexRegistration.idToken`）、22 个调试启动参数里 16 个没有驱动、7 个没用的生成主题色。
- `scripts/smoke-desktop.js` 汇总的 63 个字段里 16 个没人检查；`scripts/mock-telegram.js` 的假接口。
- `package.json` 里还有约 40 个直接跑 `node --test` 的 `test:*` 命令（见第 7.3 节）。

## 6. 检测为什么久，改了什么

### 6.1 数据

`.tmp/test-runs/` 里 2026-10-24 到 11-12 的 150 次运行：

- 快速档 122 次：29 次只有文档；**76 次被扩大成全量**（中位数 200 秒，合计 452 分钟）；真正按影响面选测的只有 15 次（中位数 87 秒）。
- 各阶段累计：JS 回归 356 分钟（57%）、Swift 124 分钟、Android 60 分钟、设置浏览器验收 53 分钟、语法检查 14 分钟。
- 开跑时的机器负载中位数 4.0、九成位 9.3（10 核）。
- 触发扩大最多的路径：重新打包出来的共享内核（`shared/agent/dist/*`、`ios/Melo/AgentCore/*`，各 48 次）、Kotlin 文件（和别的文件一起改时，150 多次）、iPhone 工程文件与界面测试、设置验收脚本。

### 6.2 选择规则（只改快速档；集成档规则不变）

| 以前 | 现在 |
| --- | --- |
| 生成器的产物算未知文件，跑全量 | 跑该生成器的一致性检查；手机载入的产物再加全部 Swift 组 |
| Android 路径和别的文件一起改，跑全量 | Android 阶段照常，其它文件按各自规则 |
| `scripts/` 下非门禁的开发脚本，跑全量 | 脚本测试组加引用它的测试 |
| 设置验收脚本，跑全量 | 跑验收本身加脚本测试组 |
| 功能地图没登记的文件（工程文件、夹具、图片、桌面壳源码……），跑全量 | 所属功能组、提到它的文件的反向依赖测试、最近的测试目录；`ios/` 下再加全部 Swift 组。整批一个测试都没选中时仍跑全量 |
| `docs/evidence/**` 的回执 JSON，跑全量 | 按文档处理 |

回放过去 88 次能还原改动清单的快速档：跑全量 72 → 11 次；选中的 JS 测试文件总数降到 78%；设置浏览器验收 83 → 63 次。剩下的 11 次是门禁自身的改动和删除文件，按规范仍然扩大。

| 改动示例 | 以前选中 | 现在选中 |
| --- | --- | --- |
| 共享内核一个源文件加重新打包 | 610 / 610，全部 Swift、Android、验收 | 227 / 610，全部 Swift、Android |
| 一个 Kotlin 文件加一个对话服务文件 | 610 / 610 | 186 / 610，Android |
| iPhone 工程文件或界面测试 | 610 / 610 | 3 / 610，全部 Swift |
| 设置验收脚本 | 610 / 610 | 38 / 610，验收 |

提交后的实测（快速档，`npm test -- --files …`）：改一个界面功能文件（`desktop-ui/features/memory/viewPane.js`，选中 30 个测试文件）5.5 秒（`run-8WCxG6`）；共享内核一个源文件加四个重新打包的文件（选中 227 个，加 Android 与全部 Swift）142.1 秒（`run-54HIh6`，其中 JS 117.6 秒），以前这类改动跑的是全量。

### 6.3 调度

- **Android 构建与 Swift 编译同时进行**，然后单独跑 Swift 测试，再跑 JS。最初是把整个 Swift 阶段和 Android 并排（`c5ee2c6b`），最终校准时 `AgentLoopTests.swift:817`（断言两个并发任务按创建顺序启动）在 Gradle 同时构建的情况下失败了一次，而此前约七十次串行运行从未失败；于是改成只让编译重叠。
- **Swift 先并行编译再逐组执行**（同时最多 6 组）。冷缓存实测见下表。
- **Swift 测试缓存按最近使用清理**：每改一次源码就多一份二进制，以前没有任何清理，十天攒到 4.8 GB。现在每组保留最近用过的 4 份，一小时内用过的不删（`ios/scripts/swift_test_cache.py` 的 `prune_suite`）。
- **JS 测试池**：长文件先跑；启动真实浏览器或真实服务的"重"文件同时最多 3 个；位置数按开跑前的机器余量取 4–8。重文件上限先定的是 2 个，实测后改为 3 个：4 个位置、机器负载 9–10、只跑 41 个重文件时，3 个并行 87 秒，2 个并行 111 秒，两次都全部通过。
- 试过更激进的配置并放弃：8 个位置、4 个浏览器测试并排时，在这台同时有后台负载的机器上，`desktop-ui/executionTiming.browser.test.js` 超过自身 45 秒上限，`scripts/eval-loop-traces.test.js` 的落盘超过写入时限。
- 测试进程带 Node 编译缓存；语法检查的并行数随核数取 4–8。
- 修了一个并发写日志的重名问题（`scripts/test-stage-runner.js`）。

| 运行 | 以前 | 现在 |
| --- | --- | --- |
| 全量集成档，Swift 有缓存 | 284.6 秒（`run-er6A1K`） | 238.0 秒（`run-11UkeT`，开跑负载 5.2）；最终校准 236.8 秒（`run-33QqEn`，开跑负载 5.0）。两次 JS 都是 4 个位置 |
| 其中 JS 回归 | 175.5 秒 | 164.2 秒；最终校准 155.2 秒 |
| Swift 阶段，冷缓存（38 组全部编译并执行） | 551.5 秒（`run-ACh0QE`，整次 815.7 秒） | 150.4 秒（单独运行 `ios/scripts/test.py --skip-renderer --skip-js`，开跑负载 6.0） |
| Swift 阶段，有缓存 | 17–24 秒 | 18.6–23.6 秒（不变） |

JS 阶段在这台机器上受后台负载限制：`run-11UkeT` 里 606 个文件的耗时相加是 653 秒，4 个位置正好 164 秒，排得再好也到头了。开跑前负载低于 1 时位置数会到 8；这一档在空闲机器上的表现本轮没有条件实测（机器后台一直有约 5 的负载）。

### 6.4 还能做但没做的

- 最慢的单个测试 `desktop-ui/taskSpaceBoard.browser.test.js` 45 秒，里面约 10 秒是固定等待；`src/index.memoryCli.test.js` 修掉定时器后仍要约 20 秒（最终校准实测 20.3 秒），因为它反复启动命令行。
- 设置浏览器验收每次 35 秒，过去一半的运行都带着它。
- 发布门禁在这台机器上仍用 `MELO_TEST_CONCURRENCY=1`；新的池在位置数为 1 时行为不变，是否放开需要在发布门禁里实测。

## 7. 阅读时发现的问题（本轮未修）

> 这些问题后来按第 11 节处理：7.1 的 12 项全部修复，7.2 的 29 条逐条核实后修了 23 组，4 条等用户决定。下面保留当时的原文。

### 7.1 主线程已核实（读代码，其中两项跑了隔离探针）

共 12 项（后 4 项来自补读）。

| 严重度 | 位置 | 问题 |
| --- | --- | --- |
| 高 | `src/tools/builtins/fileEditTool.js:262`（`run` → `original.replace(old_string, new_string)`） | 单处替换时，`new_string` 里的 `$&`、`$1`、`$$` 会被当作替换模式展开，写进用户文件的内容与模型给的不一致。`replace_all` 分支用 `split/join`，没有这个问题 |
| 高 | `src/memory/conversationIndex.js:213`（`unindexChat` 没有调用方）与 `searchHistory` | 删除对话后，它的消息仍在 `search.sqlite` 里，`search_history` 工具还能搜到并返回片段。探针：调用 `unindexChat` 后即搜不到 |
| 中 | `src/tools/builtins/clipboardTool.js:42`（`writeClipboard`） | ES 模块里用 `require(...)`，每次写剪贴板都以"require is not defined"失败 |
| 中 | `src/tools/builtins/fileReadTool.js:195-201` | 超过 200 KB 的文件直接拒绝，并提示"用 start_line / end_line 读一部分"，但范围参数在这之前没有被考虑，照做也读不了 |
| 中 | `src/memory/conversationIndex.js:325-329`（`searchHistory` 的 `after`） | 时间存的是文本、比较用的是毫秒数，条件恒真。探针：`after: 2026-06-01` 仍返回 2026-01-01 的消息 |
| 中 | `src/memory/status.js:224`（`probeEmbeddingProviderAvailability`）与 `embedProviders/OllamaEmbedProvider.js:34-38`（`isAvailable`） | `melo memory status` 探测的是 Ollama / OpenAI / 自定义 HTTP，而实际使用的只有内置模型（`getEmbeddingProvider` 的顺序是 `['builtin']`，注释写明"不自动探测外部应用"）。同一处还有一个已经修掉的毛病：Ollama 探测里 2 秒的定时器以前不清除，命令每次多等约 2 秒，本轮 `12ac7eee` 已修（`src/index.memoryCli.test.js` 从 32 秒降到约 20 秒）。探测对象不对这一半仍在 |
| 低 | `src/tools/parser.js:99-105`（`safeParseToolCall`） | 参数 JSON 坏掉时退化成空参数继续执行，`_parseError` 标记没人读 |
| 低 | `src/server.js:1248` | `_nativeSayQueue` 没有声明，退出时清朗读队列的那一行每次都抛错并被吞掉 |
| 高 | `src/services/search/socialLinkReader.js:868`（`closePattern`）与 `src/web/camoufoxReader.py:62` 的同一份 | "关闭弹层"的匹配式末尾有一个不带边界的 `x`，而且拿元素的 `class` 一起匹配；候选是页面上所有可见的 `button`、`[role=button]` 和 `svg`。文字或类名里带字母 x 的都会被点（"Next"、"Explore"、类名 `flex`、`px-4` 等）。读取社交链接时带着用户保存的登录 Cookie，所以这些点击发生在已登录的页面里。上方注释写的是"不点击任意按钮" |
| 中 | `scripts/codex-review.sh:304` | `git pp` 评审的是第 224 行取到的提交，推送的却是 `HEAD:<分支>`。评审那几分钟里新做的提交会未经评审被推上去。改成推 `$head_sha` 即可 |
| 中 | `src/memory/offline/extractor.js:89、113、114、139、140、208` | 规则里的 `[.!?$]` 把 `$` 写进了字符集，成了字面的美元符号而不是行尾。英文的决定 / 更正句子不带句号就提取不到（探针："We decided to use Postgres for the project" 无结果，加句号才有）。这份文件也打进 iPhone |
| 低 | `src/memory/speakerFacts.js:77` 与 `:86` | 地点规则 `^我在(.{1,30})$` 排在工作规则 `^我在(.{1,30})工作$` 前面，"我在腾讯工作"被记成 `Location: 腾讯工作`，工作规则几乎走不到 |

### 7.2 子代理报告、主线程未逐条核实

`isEmbeddingAvailable` 调用了不存在的 `pickBackend`；IDENTITY.md / SOUL.md 的引导链从不运行；MiniMax 的韩文剥离已删但注释仍承诺；`.melo-trash/` 与 `.melo-backups/` 无上限增长；`buildSkills` 把技能来源一律改成 `custom`；`intentRouter` 的缓存从不写入（对应测试是假绿）；旧版可视化的抛物线滑块调用了不存在的 `CSS.escapeHtml`，时间线 / 树 / 流程图读取了服务端不存的字段；流式引用条的选择器写错导致重复追加；`toggle-tts-enable` 保存两次；Android 桌宠问答超时后停在"思考中"，`PRIOR_ACTION_FAILED` 守卫只认旧工具名 `phone_use`；桌面"开机启动"开不了（`desktop-app/main.swift:828`）；桌面壳的 `topbarOverlap` 启动检查永远不会失败；若干样式引用了未定义的变量（`modelPresentation.css:57` 的 `--line`）。

补读新增（同样未逐条核实）：流式回复 120 秒无数据时取消读取并不会抛出"停滞"错误，用户看到的是别的提示，或一段不完整的回复被当成正常回复（`src/providers/streams.js:170-198`，按 Streams 规范推断，没有执行）；`pdfTool` 启动的 Playwright 会话没人关也回收不到；转写失败的占位结果被缓存七天，后端修好后同一段音频仍然没有转写（`src/media/index.js:366-370`）；浏览器没给类型的附件被存成 `.bin`（`src/media/attachments.js:167、185`）；MiniMax 生图在调用方传了取消信号时不再有超时（`src/images/imageGen.js:111`）；记忆提取、朗读改写这类辅助请求在 Codex 模式下可能被挂上联网搜索工具（`src/openai.js:944-946`）；身份类记忆的"以新代旧"从不生效（`dreaming/sweep.js:206`）；`melo memory consolidate` 有两行统计永远不打印（字段名对不上）；记忆本空内容的报错写的是 1–2000 字，实际上限 600；设置验收脚本记录了四组值却没有断言；冒烟脚本的"连续性"检查调用的是一个产品已不再调用的函数；`desktop-pet/assets.lock.json` 里提交了一个本机用户目录路径；`/api/mcp/servers` 返回四种状态而界面只区分一种；文档里的 `MELO_DREAMING_INCREMENTAL_MS`、`MELO_DREAMING_FULL_MS` 没有代码读取。

### 7.3 与事故相关的一项

`package.json` 里约 40 个 `test:*` 命令是直接的 `node --test`。11-07 和 11-10 两次把测试夹具写进正式数据目录的事故都是这样跑出来的。之后 `src/runtime/paths.js` 加了防护：测试进程没有设置 `MELO_HOME`（或指向正式目录）时改用一次性的临时目录，所以这些命令不再直接危险；它们仍然绕过门禁的调度、机器锁和超时复测，建议改成走 `scripts/run-test-pool.js` 或删掉。本轮只删了其中没有任何引用的 12 个。

## 8. 仍然挂着的事

- **桌面正式数据目录还没恢复**（11-10 的事故）。恢复前不要正常启动桌面 Melo。恢复命令在[上一份修复记录](agent-fixall-20261110.md)第 5 节，需要用户自己执行。
- 第 11 节的工作完成后，按用户要求用普通的 `git push` 把 master 推到 `origin`（推送前 master 领先 `84437476` 32 个提交）。上一次 `git pp` 评级 C 之后没有重新评审，这次也没有运行评审。
- iPhone 个人签名描述文件已于 2026-11-14 到期，手机上的 App 要重新安装才能打开。

## 9. 补读（第二遍）与最终校准

**范围。** 第一遍没有逐行读完的部分，由三个只读子代理补读，报告在本机 `.tmp/dead-code-claude-20261114/reader2-*.md`：

| 范围 | 逐行读完 |
| --- | --- |
| `src/memory`（第一遍没读或只读了片段的文件） | 27 个文件 7,722 行，另为追调用方重读 11 个文件 1,618 行；至此该目录 55 个非测试文件都有人逐行读过 |
| `src/media`、`images`、`retrieval`、`search` | 33 个文件 5,904 行 |
| `src/web`、`mcp`、`providers` | 26 个文件 3,281 行 |
| 第一遍只读了结构的 16 个脚本 | 4,256 行 |

**结果。** 找到第一遍造成的回归 1 处（第 3.6 节，已修）；确证可删的小项约 60 组、约 180 行，多数是没有任何调用方传入的选项、过期或放错位置的注释、旧 Node 版本的回退；另有新的待决定项（已并入第 5.1 节）和问题（已并入第 7 节）。

**落实。** 原计划交给三个子代理按更严格的规则落实（删任何名字前整词搜索并逐条看命中；证明依赖别的模块行为的冗余判断不删）。三个子代理因模型额度用完中断，中断前没有改任何文件。主线程只落实了证明完全在本文件内的一批，26 个文件净减 66 行：

- `src/memory`：`sessionMemory.js` 里常量搬走后留下的 14 行标题和注释；`heuristics.js` 里 6 个被同表更短条目完全覆盖的匹配词；`attic.js` 传给 `recallMemories` 的一个它并不接收的参数；`projectBook.js` 一个没人读的字段；`store.js` 三处放错位置或失去对应的注释。
- `src/mcp/client.js`：没有任何调用方的 `listResources` / `readResource`，只写不读的 `connected` 与 `name`；`manager.js` 一条已搬走代码的标题。
- `src/images/codexImageEngine.js`：两处针对旧 Node 的 `randomUUID` 回退；`src/retrieval/sharedSearchPlan.js`：第一遍已删除的 `legacy-search` 路线的表项。
- `scripts/verify-settings-design.mjs`：关闭一个界面已不存在的确认框的那一行。
- 16 个文件里 24 行 `eslint-disable` 注释（仓库没有 ESLint 配置，也没有这个依赖）。

没有落实的确证项留在三份报告的第 2 节，较大的有：`src/images/sdcppEngine.js` 五个没人传的选项和三个没人读的返回字段（约 25 行；这个文件没有任何测试，所以没有动）、`recallMemoriesTiered` 的 `atticLevels` 选项（和待决定的记忆提供方栈连在一起）、二十来个只有一种取值的参数、`src/providers/streams.js` 与 `src/mcp/manager.js` 主链路上的几处冗余判断。

**最终校准。** `npm test -- --all`，`run-33QqEn`：5,204 项 JS 测试全部通过，Android 四项、全部 38 组 Swift、设置浏览器验收、文档链接通过，236.8 秒（开跑负载 5.0，JS 4 个位置、155.2 秒）。第一次运行在"共享渲染资源预检"失败（上面说的过期清单），重新生成后这一次通过。

## 10. 可重复的验证命令与证据

```bash
# 机械扫描与导入核对
node .tmp/dead-code-claude-20261114/scan-js.cjs /tmp/scan.json && node .tmp/dead-code-claude-20261114/graph.cjs /tmp/scan.json /tmp/graph.json
node .tmp/dead-code-claude-20261114/check-imports.cjs
# 截图对比（两棵树各拍一次再比）
node .tmp/dead-code-claude-20261114/visual/capture.mjs <树> <输出目录>
node .tmp/dead-code-claude-20261114/visual/compare.mjs <目录甲> <目录乙>
# 门禁
npm test -- --base origin/master
# 机械规则扫描
node scripts/audit-inventory.mjs --out <目录> --baseline docs/audit/inventory-2026-10-27.json
```

证据目录（本机，未入库）：`.tmp/dead-code-claude-20261114/`。各片报告：`reader-src-*.md`、`reader-shared-scripts.md`、`ui-js-report.md`、`ui-css-report.md` 与 `ui-css-evidence.md`、`android-report.md`、`ios-report.md`、补读 `reader2-*.md`；截图 `visual/`；门禁日志 `gate-integration-1.log`；历史回放脚本与结果见该目录。门禁运行目录：`.tmp/test-runs/run-11UkeT/summary.json`（集成档）、`.tmp/test-runs/run-33QqEn/summary.json`（最终完整校准）。

## 11. 第 5、7 节的落实（同日第二轮）

用户看完第 5、7 节的清单后说："全按你推荐的来吧。然后直接 git push"。这一节记录每一项做了什么、哪些没做及原因。清单编号沿用当时发给用户的 A（第 5 节）、B（第 7.1 节）、C（第 7.2 节，29 条并成 27 条）、D（第 7.3 节）。

**源码基准。** 起点 `67ad9457` 的上一个提交；九个提交，到 `721b5267` 为止。手写产品代码 149 个文件净减 3,379 行，测试 90 个文件净减 218 行（新增与改写 2,961 行，随代码删除 3,179 行），生成文件净减 1,281 行；删 38 个文件，新增 20 个。

**方法。** C 组先由三个只读子代理逐条核实（报告在本机 `.tmp/dead-code-claude-20261114/verify-c-*.md`，29 条全部成立），我再逐条对着当前代码读一遍才动手。每个修复都带测试，并且在旧代码上跑一遍确认它会失败（变异，或换回提交里的旧文件）；旧代码里不存在被测对象的除外。删除一律先做整词搜索。界面改动用隔离数据目录起服务、真实浏览器核对。

### 11.1 A：第 5 节的 18 项

| 编号 | 项目 | 结果 | 提交 |
| --- | --- | --- | --- |
| A1 | 智能选模 | 三端全部删除，分四步：桌面、Android 与 iPhone、共享策略模块。详见 11.4 | `61ee56aa` `0024b8cf` `721b5267` |
| A2 | 记忆提供方栈 | 删除 `src/memory/providers/` | `15a109a9` |
| A3 | 外部向量后端 | 删除三个提供方与 `POST /api/memory/connect`；`melo memory status` 改为探测真正在用的内置模型（B7） | `15a109a9` |
| A4 | 旧版桌面搜索规划器 | 删除；依赖它的测试改走产品实际使用的规划器（`src/testSupport/searchPlanFixture.js`） | `15a109a9` |
| A5 | 第二套记忆状态工具 | 删除 | `15a109a9` |
| A6 | Browserless 预设与"未锁定版本" | 删除；每个预设必须指向确切版本的规则改由测试把关 | `07ac0f63` |
| A7 | MCP 连接接口接受任意命令 | 删除这两个分支 | `15a109a9` |
| A8 | Agent 身份行写进记忆库 | 停写。**更正**：我当时说"已写入的数据不动"，实际上派生索引下次同步会把快照里没有的行删掉，已有的身份行会随之消失。它们没有任何读取方 | `15a109a9` |
| A9 | 五个小功能 | 插件的两个接口、HTTP 后台命令任务、技能自升级应用接口、OpenClaw 凭证回退已删。**两处与清单不同**：插件钩子本身（`src/plugins/hooks.js`）留着，回合生命周期在用；`searchTask.js` 没动，它的失败分支在用，成功分支的清理要连同 1,100 行测试一起重构，单独做更稳妥 | `07ac0f63` |
| A10 | 只有测试在用的代码 | `buildReActSystemPrompt`、`persistChatRuntimeFields`、`detectImageGenIntent`（`openai.js` 改用同一份实现）、九个 Agent 动作、语音转写发送路径已删 | `07ac0f63` |
| A11 | 记忆库 Stage-4 校验 | 证实是空操作后删除 | `15a109a9` |
| A12 | 废纸篓恢复 | 新增 `file_restore` 工具，见 11.5。清除入口没有做（C13） | `35a9dd21` |
| A14 | 离线压缩探测本地服务 | 只使用配置里写明的本机连接 | `15a109a9` |
| A13、A15、A17、A18 | 聊天锁定、Telegram / Discord、素材、零碎 | 没动。这四项当时没有给出建议，等用户决定 | |
| A16 | 旧版可视化 | 保留，并修好了它的四个毛病（C9） | `35a9dd21` |

A6、A9、A10 改变了界面：系统工具页少了 Browserless 一行（"7 / 8 已启用"变成"7 / 7 已启用"）和两个一直为空的分节（"插件""后台命令任务"），Agent 页的 MCP 列表少了"browserless · 当前不可用"一行。清理前后 38 张截图，34 张逐像素一致，其余 4 张只差这一行。

### 11.2 B：已核实的 12 项，全部修复（`aaf3d70b`）

B1 社交链接读取只按"关闭"类文字、读屏名称和浮层内的小图标关闭弹层，规则只有一份（`src/web/overlayCloser.js`），两处读取器共用；B2 文件编辑按原文写入；B3 删除对话时同步清掉搜索库里的消息，历史搜索只返回仍存在的对话；B4 剪贴板写入；B5 大文件可以按行读取一段；B6"某日期之后"筛选生效；B7 随 A3；B8 `git pp` 推送的是评审过的那个提交，评审期间的新提交留在本地并提示；B9 英文句子不带句号也能记住；B10 工具参数 JSON 损坏时不执行并告诉模型；B11 退出时停止朗读；B12"我在腾讯工作"记为工作单位。

### 11.3 C：27 条里修了 23 条（`35a9dd21`）

| 编号 | 问题 | 修法 |
| --- | --- | --- |
| C1 | 桌面"开机启动"开不了 | 原生端用能识别布尔值的解析（`desktop-app/main.swift` `handleLocalSettings`）。要重新编译桌面壳才生效 |
| C2 | Android 桌宠停在"想想看…"；失败保护只认旧工具名 | 两处等待改为超时返回空值并报出原因（`PetOverlayService.ask`、`PetDialogue.awaitState`）；三个手机工具名共用一份集合（`ChatPhoneUse.actionTools`） |
| C3 | 流式回复卡住后提示不对，或半截回复被当成完整 | `readSseStream` 在读到结束时先看是不是看门狗取消的；空闲时钟在自己的回调执行期间不走。生图的流同样处理 |
| C4 | 转写失败被缓存七天 | 占位结果不写缓存，已有的占位缓存不再生效（`src/media/index.js`） |
| C5 | 没有类型的附件存成 `.bin` | 数据里没带类型时用附件声明的类型（`externalizeAttachment`） |
| C6 | 流式回复时来源条重复 | 选择器写错了类名（`viewThread.js`） |
| C7 | 朗读开关点一次保存两次 | 删掉点击分支，保留读取控件真实状态的那个 |
| C9 | 旧版可视化四处 | 抛物线滑块、时间线标题、树的悬停说明、流程图连线；流程图的排版同时支持带回路的图 |
| C10 | 记忆本报错写 1–2000 字 | 报错与输入框都按真实上限 600 |
| C11 | `melo memory consolidate` 少两行统计 | 读对字段名 |
| C12 | MCP 状态只分一种 | 启动失败显示"连接失败" |
| C14 | PDF 工具的浏览器会话没人关 | 见 11.6，实际问题比报告大 |
| C15 | MiniMax 生图传了取消信号就没有超时 | 请求和下载都同时受时限和取消约束 |
| C16 | 辅助请求可能带上联网搜索 | 记忆提取、朗读改写、技能起草明确关闭 |
| C17 | 仓库里的本机路径 | 从锁文件和写入脚本里去掉。已进入 Git 历史的那一份没有清，要清需要改写历史，由用户决定 |
| C18 | 意图路由缓存与假绿测试 | 删除缓存、只为它存在的两个辅助函数和四条测试 |
| C19 | "顶栏重叠"检查不可能失败 | 两端一起删除 |
| C20 | 设置验收只记录不断言 | 补上两条有意义的比较（历史回复的角色名不变、只改提示词不改模型），当前都是绿的。另两组是诊断值，仍只记录 |
| C21 | 冒烟脚本的"连续性"检查 | 在产品实际调用的 `buildDynamicContext` 上加了同一组断言。冒烟脚本里的旧检查没有删 |
| C22 | 判断向量可用的函数调用了不存在的函数 | 删除这个没有产品调用方的函数 |
| C25 | 韩文剥离的注释 | 改正注释，删除没人调用的 `stripKoreanForMinimax` 和它的 17 条测试 |
| C26 | 未定义的样式变量 | 9 处里 8 处直接写成回退值（显示不变），剩下一处随 A1 删除 |
| C27 | 文档里两个没人读的环境变量 | 从文档删除 |

没有修的 4 条，都需要用户决定：

- **C8 身份类记忆"以新代旧"从不生效**（`src/memory/dreaming/sweep.js` 把不带正文的行交给 `planIdentitySupersession`）。修好等于打开一个从未运行过的功能，它会把现有记忆里较旧的身份事实标为过期。要么这样打开，要么删掉 `supersede.js`。
- **C13 废纸篓和备份只增不减**（`src/safety/trash.js`、`backup.js`）。代码里写明了"不自动删除、由用户明确清除"，缺的是清除入口。A12 只补了恢复。
- **C23 IDENTITY.md / SOUL.md 的引导残留**（`src/state/stateStore.js` `readSnapshot` 的 `maintenance` 分支、`markdownSync.js` 的三个成员）。在状态加载路径上，正式数据目录恢复之前我没有动。
- **C24 技能来源一律改成"自定义"**（`shared/agent/skill/skillService.js` `buildSkills`）。现在没有任何东西产生被抹掉的那个值；是否保留"内置技能包"的设计要先定。

### 11.4 A1：智能选模的删除范围

产品早已固定使用所选模型，但每个回合仍在创建一个被强制为"固定"的路由会话，并在循环里 14 处查询它。

- 桌面（`61ee56aa`）：`prepareNode.js` 的会话、`invokeModelNode.js` 的 14 处（`melo_escalate` 工具、回合中途换模型、写操作的"强档"拒绝、深度任务加长预算）、`src/services/modelRouting/`、设置接口与设置页模块、模型选择器里的"智能（自动）"。
- Android（`0024b8cf`）：`SmartRouting.kt`、`RoutingTranscript.kt` 与 `SharedChatAgent.kt` 里的十多处。它在"固定"模式下每次回复都调用一次共享内核，返回的就是传进去的模型。
- iPhone（`0024b8cf`）：开关是写死的 `false`，整套代码静态不可达。删除两个文件和 `AgentLoop.swift`、`ChatStore.swift`、`Network.swift`、`ChatGPTAccount.swift` 里的引用；工程文件由 `ios/scripts/generate-project.py` 重新生成。
- 共享内核（`721b5267`）：`shared/agent/modelRouting.js`、内核的 `modelRouting` 操作、`resolveLoopLimits` 的 `route` 参数、`reroute` 事件。内核包从 419,656 字节减到 408,558 字节。

有意保留：以前的回复记录里的"智能选模"一行和旧执行记录的阶段名仍能显示；已保存的策略和停在"智能"的对话照常读取、不改写；同步格式仍带这个字段，手机和电脑不会互相丢字段；合同里的 `loop.deepTask.deadlineMs` 仍是桌面和 Android 的整轮运行期限。

一处行为变化：配置里仍写着"智能"时，收到带图消息时的看图检查以前跳过"选择看图连接"这一步，现在与其它对话一样处理。

手机端要重新安装才生效。

### 11.5 A12：`file_restore`

`file_delete` 一直对模型和用户说"可以恢复"，而恢复函数只有测试在调用。新增工具 `file_restore`（`src/tools/builtins/fileRestoreTool.js`）：`list` 列出可恢复的删除操作，`restore` 把一次操作的文件放回原处。

- 一个对话只能看到、恢复在本对话或本工作区里删除的文件。废纸篓是整个数据目录共用的，不加这条界限，任何对话都能读到别的项目删过哪些文件。别处的操作编号与不存在的编号得到同一个回答。
- 每个文件都经过与写文件相同的审批（`FileSafetyGate.requestWrite`）。恢复函数里不经审批的那条路径是给界面按钮用的，工具不会走到。
- 原位置已经有文件时不覆盖，除非传 `overwrite: true`。
- 它不清除任何东西；完整恢复的那次操作由 `trash.js` 从废纸篓移走，与原来一致。

### 11.6 核实过程中另外发现并修掉的两个问题（`35a9dd21`）

都是实际运行浏览器命令行时发现的，不在任何报告里。

1. **macOS 上一个浏览器会话每个进程只能打开一次**（`src/web/playwrightFetcher.js` `runCli`）。命令行工具把每个会话的套接字放在临时目录下，路径加上 Melo 的会话名超过 macOS 允许的 103 字节，被内核截断；守护进程关闭时找不到自己的套接字，下一次 `open` 以 EADDRINUSE 失败。结果是服务启动后第一次空闲关闭（15 秒）之后，读网页和搜索的浏览器兜底一直不可用，没有任何提示；临时目录里留下了 422 个套接字文件。现在路径放不下时改用一个只有本用户能进入的短目录（`/tmp/melo-pw-<uid>`，创建后检查是真实目录、属主和权限，不符合就不用）。
2. **PDF 工具的浏览器路径生成不了任何 PDF**（`src/tools/builtins/pdfTool.js` `htmlToPdfWithPlaywright`）。它让命令行打开 `file://` 地址并把输出路径当位置参数传，前者被命令行禁止，后者只会打印帮助。所以文字、Markdown、中日韩内容的 PDF 一直失败，每次还留下一个守护进程和一个无头浏览器。它的两条测试以"失败就返回"结尾，所以一直是绿的。现在经本机回环地址把文档交给浏览器、用锁定版本的共享会话（原来是 `@latest`）、渲染排队、完成后关闭会话。本地图片要内嵌进 HTML（工具说明原本就这样写）。

顺带记一条写测试时踩到的：`node:test` 的 `skip` 选项传空字符串时，测试会照常执行但被报告为"已跳过"，失败不计数。

### 11.7 D1（`d0e97c26`）

29 个 `test:*` 命令原来直接执行 `node --test`。现在都经 `scripts/run-focused-tests.js`：在临时数据目录里走门禁的测试池，结束后删除目录；命令里列的文件匹配不到就报错（发现两个命令还列着当天已删除的测试）。`scripts/run-focused-tests.test.js` 不允许 `package.json` 里再出现直接执行的写法。

### 11.8 读代码时看到、没有修的

每条都没有做修复，只记位置：

- 不带工具的 Responses 流如果服务端没发 `response.completed` 就断开，已收到的文字会被当成完整回复（`src/providers/streams.js` `readCodexSseResponse`）。Chat Completions 的读取器会拒绝这种情况。
- 工作区路径经过符号链接时 `file_delete` 会拒绝（`src/safety/trash.js` 的逐级不跟随打开）。数据目录在带符号链接的路径下的用户会碰到；测试里是 macOS 的临时目录触发的。
- `src/services/chat/conversationSelection.js` 仍接受并保存 `mode: 'smart'`（同步兼容），现在没有界面会发出它。
- 手机发起的消息不进历史搜索索引；`chat_title` 返回时带中英文间的空格；"我在想…""我是说…"会被记成说话人事实（只影响已归档的 Telegram 发送者）；给 Camoufox 包装脚本的 Cookie 经命令行参数传递。
- 在测试里启动另一个 `node --test` 而不清掉 `NODE_TEST_CONTEXT` 时，里层不运行任何测试且退出码为 0（`scripts/test-pool.js` 由门禁在测试之外调用，不受影响；写会启动测试的测试时要注意）。

### 11.9 验证

```bash
# 完整校准（门禁脚本有改动）
npm test -- --all
# 推送前集成档
npm test -- --base origin/master
# Android 设备测试（无窗口模拟器，见 android/verification.md）
ANDROID_SERIAL=emulator-5554 npm run test:android:connected
# iPhone：全部 Swift 测试与模拟器整包编译（不签名、不安装）
npm run test:ios
xcodebuild -project ios/Melo.xcodeproj -scheme Melo -sdk iphonesimulator -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
# 桌面壳只做类型检查，没有重新编译或安装
xcrun swiftc -typecheck -parse-as-library -framework Cocoa -framework AVFoundation -framework Speech -framework WebKit -framework CoreLocation desktop-app/*.swift ios/Melo/VoiceInput.swift ios/Melo/SystemSpeechInput.swift
```

- 各批的快速档都是绿的：`run-51IH0G`、`run-1TMU4A`、`run-ClIJeA`、`run-CzstBd`、`run-U61UqY`、`run-lzFDKn`、`run-Vjfm49`、`run-W4E1bd`。
- 完整校准 `npm test -- --all`，`run-QoQUog`：JS 5,162 项全部通过、没有跳过，Android 四项、全部 38 组 Swift、设置浏览器验收通过，239.9 秒。
- 推送前集成档 `npm test -- --base origin/master`：`run-1a76gD`，包含本记录在内的工作树，九个阶段全部通过（文档链接、JS 5,162 项、Android 四项、全部 38 组 Swift、设置浏览器验收），242 秒。
- Android 设备测试 143 项，138 通过。另外 5 项与本轮改动无关：2 项在无窗口模拟器上一直失败（需要 WebGL 帧、桌宠第二次双击），2 项是需要手动开启的真实模型测试，`DeviceAgentTest.changingTheActiveWindowRejectsEvenAnOtherwiseValidNode` 在机器同时编译 Swift 时失败、单独重跑通过。
- iPhone 全部 38 组 Swift 测试通过，整个 App 的模拟器编译成功。
- "自动朗读回复"开关用真实浏览器点了三次（两次鼠标、一次键盘），每次只发一次保存请求。

### 11.10 没有做的

- 桌面壳没有重新编译和安装，C1 和 C19 的原生部分要等下次重编才生效；手机没有重装，A1、C2、B9 在手机上同样要等重装。
- 没有运行 `git pp` 的评审；按用户要求直接 `git push`。
- 正式数据目录仍是 11-10 事故后的状态，本轮没有读写它（见第 8 节）。
