# Shared Agent Core / Search 统一设计

日期：2026-10-17。基线：`c4fe0cc`，`codex/mobile-use-features`。

状态：用户已要求统一三端业务逻辑、公共信息查询优先检索；本文是具体 Runtime 方案的审阅稿，尚未实现或通过用户对该 Runtime 选择的确认。设计记录不代表 Android 已有 Web Search。

## 1. 问题与已确认约束

- Node Chat Runner、Swift ChatStore、Kotlin ChatEngine / ChatToolLoop 各自决策。共用 Sync Schema / 部分 Fixtures 没有消除执行逻辑分叉。
- Android 只向普通 Chat 暴露 phone_use；当前 Skill 要求餐厅查询使用手机。修改 Prompt 而不提供 Search executor 不能修复能力缺口。
- Desktop 既有 Codex OAuth 的服务端 web_search，也有 Melo 自己的 web_search。后者主路径使用 Playwright 抓取 Google；迟于 2 秒会启动 Jina Reader 读取 DuckDuckGo Lite，两者竞速。这里没有调用 Google Search 官方 API。
- Swift 已用 JavaScriptCore 执行同源的 memory extractor，存在本机加载共用 JS 的先例，但尚无共享 Agent Core。
- 用户要求手机独立运行；不以桌面保持在线为前提。保留 Kotlin / Compose、SwiftUI、Desktop UI，以及账号、聊天、Task Cache、凭证和原有设备保护。
- 解释修正：模型 API 传输、服务端 Hosted Tool、Melo Agent Loop 属不同层。API 请求可以启用服务端 web_search；这不能推导为运行了 Codex CLI，也不能推导为服务端能操作手机。

## 2. Runtime 方案

### A. 同源可移植 JavaScript Core，在各端本机运行（推荐）

- 维护同一份 Core 源码与带版本 / hash 的 bundle。Desktop 用 Node，iOS 用 JavaScriptCore，Android 优先验证 Jetpack JavaScriptEngine / JavaScriptSandbox。
- 保留原生 UI；Core 处理决策和状态，Host Adapter 执行网络、存储、权限、设备动作。Android 的 JS engine 不创建可见浏览器，也不承担网页抓取。
- 优点：沿用主要 JS 业务实现；手机独立运行；策略改动只维护一处。代价：增加两端 Host bridge、生命周期管理和跨引擎验收。
- Android 官方说明需要 API 26+ 且 WebView implementation 支持，必须检测 isSupported / feature。不能据 Android 16 或 One UI 8.5 版本号直接声称实际设备支持。先做 Emulator / Fold6 feature 与 Service 生命周期验证，再切换生产入口。

### B. 所有客户端请求同一个 Node Runtime 服务

- 复用现有 Node 能力较快，但手机依赖可达的服务器，并引入服务部署、鉴权、可用性和请求资料边界。
- 桌面充当服务器会违反手机独立运行约束；用户目前没有要求部署独立服务，因此本轮不选。

### C. 改写为 Kotlin Multiplatform 或 Rust Core

- 可以得到共用本机实现，但需迁移现有 JS 主业务、补 Desktop / Swift bindings，改动及回归范围显著更大。
- 当前目标是收敛既有逻辑并接通 Search，先不改写全部语言栈。

## 3. 统一边界

```text
Desktop UI / SwiftUI / Compose
             |
      同一份 Shared Agent Core
      Tool Registry / Skill Policy / Router
      Loop / Budget / Result / Cancellation
             |
       显式 Host Adapter
      Model HTTP / Search HTTP / Storage / OS
```

- Core：统一 Tool 的名称、Schema 与逻辑能力身份；Skill 选择；搜索 / App 操作路由；业务配置默认值；预算与重复失败策略；完整 call/result 配对；来源、失败、终态和取消语义。按模块逐步迁移，不能将只有 Schema 共用称为 Core 完成。
- Host：HTTP / TLS、凭证引用解析、平台存储、原生执行事件、A11y / 截图 / 点击、原生确认、Android Service 与 iOS lifecycle。Adapter 不另写餐厅路由、Skill 判断或 Loop 决策。
- 全端可用 Tool 为“共用 Registry ∩ 本机 executor 能力 ∩ 本轮 Agent 授权”。注册存在不代表当前连接支持。平台不具备的 Tool 明确不可用，不能声明成功或静默换成占屏。
- 共用配置结构和默认策略；凭证值仍在各机 Keystore / Keychain / 本地安全存储，以非秘密引用绑定连接。统一逻辑不等于把所有密钥加入现有资料同步；自动密钥同步不属于本轮。

## 4. Search 行为

```text
公开信息 -> Shared Search Router -> 已验证的 Provider Hosted Search
                                   或已配置的 HTTP Search Backend
        -> 来源 / 时间 / 正文 -> 当前 Chat

指定 App 的内部资料或明确手机动作 -> phone_use -> 原生 Adapter
指定 URL -> fetch_url -> 来源 / 正文
```

- Native Search 以实际连接与端点的 capability 为准，区分 unknown / verified / unsupported。不能只凭 model name、Responses 字样、OAuth 或支持 Function Calling 推断支持 web_search。
- `web_search` 是共用的逻辑能力。支持 Hosted Search 时 Adapter 可以编码为 Provider-native Tool；普通模型则使用共用 Function Tool Contract 并由搜索 executor 执行。二者使用相同授权边界和可见来源语义，不伪造相同的底层 call ID。
- 默认优先已验证的 Hosted Search，其次已配置的 HTTP Search Backend。具体供应商作为共用配置项，不能按 Android / iOS 分别硬编码；本轮设计不默认申请新 API Key、不购买或部署服务。HTTP Search Backend 尚未配置且无 Native capability 时，返回可操作的 Search unavailable，不能冒充已经完成查询。
- 现有 Jina / DuckDuckGo 抓取保留为显式 legacy backend，说明其不是正式结构化 Search API。Playwright / Google 降为用户显式启用的 browser fallback；普通公开查询和多来源研究均不以启动浏览器为默认前提。抽取时先保持旧行为，策略改变另开独立 commit。
- 用户明确指定小红书时保留来源约束：公开网页未覆盖的内容可以使用 phone_use；不能用普通 Web 结果冒充已搜索 App 内资料。公共检索失败本身不授权自动接管屏幕。
- 统一结果包含 title / URL / snippet 或正文引用 / fetchedAt / backend / freshness / evidence / error；Hosted Search 的 annotations / source items 由 Adapter 归一，不编造不可观察的抓取时间或未提供的正文。
- “现在营业”等动态结论依赖当前时间、地点 / 时区与实际来源，缺失则澄清或保留未知。Cache 必须保留观测时间 / stale 状态，Task Cache 只复用流程，不把旧结果当实时事实。

## 5. Core 与 Host 的执行约束

- Core 接收版本化的 JSON input / event，产出待执行 effect 和新状态。稳定字段包括 runId / turnId / callId / capability snapshot / connection revision；Host 只执行与当前 run 匹配的许可 effect。流式增量以事件返回。
- Core 不依赖 Node fs / process.env / DOM；时间、随机 ID、配置和权限在本轮入口捕获并显式注入。第一刀逐字迁移既有函数，再独立变更策略，遵守 CLAUDE.md 的移植约定。
- 仅执行安装包内 Core；用户消息、网页、模型回复都是数据，不能拼成可执行脚本。Host bridge 不开放任意文件、任意原生函数或凭证读取。图片使用受控资源引用，避免跨 bridge 搬运整份图片 / UI tree；正文有大小限制。
- 按 Chat 隔离状态，设备仍单任务独占。Core 取消后拒绝新的 effect；Host 原有 OS 权限、确认、旧 screen 拒绝和 finish 重新观察保留，取消不能提前释放尚未排空的写任务。
- JS engine 不支持、crash 或进程回收必须显式报 Runtime unavailable / interrupted。恢复时不自动重放已派发的点击、发送或其他写 effect；不得暗中回到另一份 Kotlin / Swift 业务实现。

## 6. 实施顺序与验收

1. Runtime spike：同一 bundle 在 Node / Android JS engine / iOS JSCore 消费相同输入，验证 JSON bridge、隔离、超时、取消和 lifecycle。先证明 Android Service 中可用，失败时保留当前生产路径并明确阻塞；不先迁移 Chat 再补运行时。
2. 逐字提取既有 Search / request policy 的纯决策，环境依赖改为 Host 注入；保持 Desktop 原有行为与公开接口，专项回归 GREEN 后本地提交。Node-only 执行器暂留 Host，不把整个 Node graph 打包给手机。
3. 独立提交加入能力选择、API-first 搜索策略和共用 Registry / Skill；按 capability 接三端真实 Chat 入口，替换各端对应旧判断。HTTP provider 采用用户已有的可用配置；没有可用 Backend 必须诚实反馈。
4. 迁移通用 Tool Loop / Budget / Result / Cancellation；设备 target / window / native confirmation 仍由 Android executor 执行。Task Cache、复杂记忆和媒体链逐模块处理；未迁移能力列清楚，不在首个 Search 增量称全库统一。
5. Conformance：同一输入、能力、时间、工具事件得到同一 route / 允许 Tool / 预算 / 终态；覆盖禁止联网、指定 App、直接 URL、native unsupported、搜索失败、陈旧缓存、引用、重复错误、取消后迟到结果和未知 call ID。
6. 集成：普通问答不联网不读屏；餐厅公共检索在 Search Backend 可用时不占屏；明确 Maps 导航才操作手机；各端真实入口保留来源和停止操作。Android 三模型协议、JVM / Lint / 构建 / Emulator；Fold6 folded / unfolded；iOS 需 macOS 构建和原生验证，Windows 不能代称完成。

完成边界：同源 bundle 接通三端对应功能、跨引擎 Conformance 和各端功能验收分别有证据，才称该模块统一。现有 APK、账号能力和 One UI 支持均未因本文改变。

## 7. 依据

- 当前源码：`src/retrieval/searchRouter.js`、`src/tools/builtins/webSearchTool.js`、`src/openai.js`、`src/services/chat/chatExecutionRunner.js`、`ios/Melo/WebSources.swift`、`ios/Melo/MemoryFacts.swift`、`android/app/src/main/java/com/melo/android/chat/ChatPhoneUse.kt`、`android/app/src/main/java/com/melo/android/chat/ChatEngine.kt`。
- [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)：Responses 可配置 Hosted web_search；此公开文档不证明用户的 Proxy 或 repo 的 OAuth endpoint 已有相同权限。
- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)：自定义 Tool 由应用接收调用并执行，再回传结果。
- [Android JavaScriptEngine](https://developer.android.com/develop/ui/views/layout/webapps/jsengine)：无 WebView 实例的 JavaScript 执行、Service 使用与 support / feature 检测。
- [Apple JSContext](https://developer.apple.com/documentation/javascriptcore/jscontext)：Swift / Objective-C 内执行 JavaScript。

## 8. 自审与待用户选择

已检查：共享源码与共享 Schema 不混称；手机独立运行；API transport 与 Hosted Tool 不混称；凭证不进入资料同步；禁止以搜索失败自动占屏；Runtime 不支持时不维护另一份业务 fallback；保留逐字抽取与行为改变的提交隔离；三端验收不互相替代。

待审阅的是方案 A 的 Runtime 选择及上述 Search 行为。用户认可后再开始产品代码和 Runtime spike；本稿未新增依赖、未调模型、未操作手机、未构建安装或推送。
