# Shared Agent Search — 2026-10-18

分支 `codex/mobile-use-features`。先保护 Search WIP，再合入远端 `84abfa9`，Merge commit `7a668c7`；上游 Tool records / 三协议 Adapter / MCP isolation / RunBudget / Memory 改动保留。此前 Runtime 检查点见 [2026-10-17](shared-agent-runtime-20261017.md)。

## 本轮行为

```text
Chat → 同源 JS Core Router → 已验证 Hosted Search / 已配置 HTTP Search
                          → 指定 URL 的直接读取
                          → 显式 App 任务的 phone_use
     ← 有界来源、未知 freshness、实际完成 / 停止回执
```

- Node 与 Android 真实 Chat 入口使用同一 Router、通用 Tool Schema、Search Provider 编码、来源归一与 Turn Guard。Android 本机 JavaScriptEngine 执行安装包内 bundle，手机不依赖桌面在线。
- 公共查询和多来源研究不默认启动 Playwright 或占用手机屏幕。Node 保留上游稳定 Tool definitions；本轮 effect 由 Core 独立授权。显式 Browser 请求 / 用户开启的 Legacy fallback 才允许 Browser 路径，HTTP 失败不静默升级。
- HTTP 支持兼容 POST `{query,maxResults}` → `{results:[{title,url,snippet}]}` 与 Brave GET / `X-Subscription-Token`。Brave 默认 endpoint 只定义于 Core；Model / Search Key 分开，凭证不穿过 JS bridge。
- Hosted Search 需用户显式测试。仅 Responses / OAuth / 模型名不能证明支持；只有结构化 completed 回执可以生成连接 proof。proof 绑定 endpoint、protocol、model、Key / account 的不透明身份，24 小时过期。普通文字或仅 citation 不算实际 Search；最终回答还要求来源。
- 普通问答沿用原 Streaming。三模型协议的 Search / Phone Use 使用非 Streaming Tool Calling。没有 Backend 会提示不可用；显式 App 来源与连续追问保留，普通新查询不会沿用旧 App 占屏。
- Core 拒绝重复 call ID / 手机目标和未授权 effects；需要工具的任务缺少成功回执时返回 `MISSING_TOOL_EVIDENCE`。未知工具仍有配对错误回执，不丢失同批有效调用；子 Agent / Skill 不扩大父轮实际授权，缺证据 / Core 停止不再额外调用 Verifier。上游 Tool records / MCP wire name / RunBudget 不被覆盖。

## 设置与资料

Desktop 与 Android 有显式保存的 Search 设置和 Hosted Search 测试入口。Key 绑定 endpoint，空输入保留、明确清除才删除；Desktop config 为本机私有存储，Android 用 Keystore。Search Key 不进入 bootstrap、资料 Sync 或 export，不读取其他模型的 Key。保存设置本身不发送搜索。

配置 Schema / 默认值共用；非秘密 Search 设置尚未自动跨设备同步。Android 的最终回答 / 来源沿用 RunRecord；原始 Search 响应只在当前 Loop 内使用，尚未迁入 Desktop 的完整 ToolInvocationRecord / tool-trace replay。

## 实际验证

- Node 定向 314 tests；上下文 / Tool protocol / MCP / Skill / Sync 等相关回归另批 203；最后 UI 样式对齐后 16 项 UI 检查。均为离线 / 本地 HTTP Fixture；951 文件语法检查通过。
- 42 个同源 Conformance Fixtures 在 Node / Android JS engine 通过；iOS 打包相同 bundle，JS / renderer gate 通过，Swift 明确 skipped。
- Android 0.6.0 (14)：115 JVM，无 failure / skip；Lint、Debug、R8 Release 构建通过。最终 Debug APK 内 Core hash 与 manifest 相符；Debug 签名和四个 native libraries 的 16 KiB alignment 通过。Release 为 unsigned 构建，没有冒称 Release runtime 验收。
- 最终 Debug APK：Cover `968×2376 / 420dpi` 43 项 Runtime 通过；展开 `1856×2160 / 420dpi` Search / Settings 组合 9 项通过，共 52 次测试执行。包含三协议 HTTP Search、Hosted proof / 来源、无 Backend、模型跳过工具、HTTP 失败、取消、普通 Chat / Phone Use / Device / Cache 和设置持久化 / 显式清 Key。
- Runtime 首轮新增测试的 teardown 返回类型不符 JUnit，修复后通过；展开组合首轮设置保存等待超时，单独复跑通过，补初始草稿 / IME 等待后组合 9 项通过。失败日志保留，未降低保存 / Key / recreation 断言。
- Playwright CLI 操作真实 Desktop 页面：编辑 / 保存、取消、刷新后保留 endpoint，Key 输入清空，原模型配置保留，保存不发送 Search。WSL 初始缺中文字体，仅在 QA 环境复用本机已安装字体；最终截图检查通过。旧 favicon 404 / software GPU warning 与 Search 无关。
- 本轮自有 Emulator、隔离 ADB 5048、Browser 和本地 UI Fixture server 已关闭；未访问真实账号 / 模型、私人手机、安装 Fold6、购买 Search 服务、push 或 git pp。

机器证据：[脱敏 JSON](evidence/shared-agent-search-20261018.json)。原始日志 `.tmp/agent-core-audit-20261017/search-*20261018.log`，UI 图片同目录与 `output/playwright/search-settings-20261018.png`；派生产物不入 Git。

## 后续实机安装

用户连接手机后的独立安装回合：0.6.0 (14) R8 Preview 已同签名覆盖 Fold6 / One UI 8.5 并启动，11 Chat / 1 角色及 Accessibility 设置保留，无启动 Crash。该回合未发真实请求或执行 Core；[安装证据](evidence/shared-agent-fold6-install-060-20261018.json) 与前述开发 / Emulator 回合分开记录。

## 尚未完成

- Fold6 / One UI 8.5 的真实 JS engine feature、Service、网络与 Cover / 展开切换验收；尺寸模拟与安装启动不能代替这些功能证据。
- iOS 生产 Search / Loop Adapter 的切换与 macOS / 真机验收。不能将相同 bundle 或 JS gate 称为三端已统一。
- 上游新增 Tool envelope / records、预算、Skill 调度、Context / Memory、摘要 Sync 与 Task Cache 的后续模块迁移。当前仍有平台路径，见 [实施计划](shared-agent-implementation-20261017.md)。
- Android 直接网页读取仅文本 / 静态 HTML，不跟随 Redirect，不承诺动态页面。HTTP / Hosted 来源不独立证明当前营业状态。需要澄清但未调用工具的任务目前可能统一返回“未验证”；显式 needs_user 终态与更自然的澄清需继续随统一 Loop 处理。

## 接口依据

- [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)：真实 `web_search_call` 与来源 / annotations；不证明任何自定义 Proxy 已支持。
- [Brave Web Search](https://api-dashboard.search.brave.com/api-reference/web/search/get)：GET query / count 与认证 header；本轮未配置真实 Key 或发送付费请求。
