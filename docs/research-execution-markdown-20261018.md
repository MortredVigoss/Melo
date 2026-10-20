# Android 0.7.0 — Research、执行记录与 Markdown

产品代码 `1e292e9`，分支 `codex/mobile-use-features`。[已认可规格](specs/2026-10-18-research-execution-markdown-design.md) / [机器证据](evidence/research-execution-markdown-20261018.json)。仅本地提交，未 push。

## 用户可见行为

`推荐 brunch 并导航 → web_search → 按需 fetch_url → 已明确要求的 phone_use → 实际结果`

共享 Router 现在识别 brunch / 导航复合任务和历史执行追问。Search 缺少 verified Hosted 或 configured HTTP Backend 时明确停止，不自动占屏；Search 的成功来源是后续导航的 prerequisite。网页读取只接受明确请求的 URL 或本轮 Search 返回的 URL；空结果不能编造目的地。普通推荐按需读取支持理由的页面，深入 Research 要求比较来源与不确定性，不凑固定调用次数。Hosted 只把实际结构化 web_search_call 记成 Tool，声明 capability 只算 pipeline。

Chat 每次请求在答案前显示默认折叠的执行卡，展开可查真实 Tool、开始时间、耗时、有界输入/结果和来源。搜索摘要与已读网页分别标记，部分完成、受阻、失败、取消各自保留；不因 HTTP 正常返回就声称任务完成。记录随阶段落盘，中断后保留已完成步骤但不自动重放；旧记录明确显示缺少明细。解释上次执行时取最近三条有界记录，未知保持未知。凭证字段和常见敏感模式脱敏；原始屏幕/tree 不进入执行卡。Phone Use 仍引用原生子任务步骤。

公开 Reasoning Summary 仅接受服务实际返回的 summary_text；不读取 encrypted/internal/thinking 内容，不额外请求模型生成“思考过程”。Android Compose 消费安装包内共享 ReplyDocument 解析，支持标题、列表、引用、粗体/斜体、代码、安全链接和可横向滚动的表格；用户原文、复制/分享保持原有内容，HTML 不执行。

## 已完成验证

- 147 Node 定向 tests、117 JVM tests 全通过，无失败/跳过；Lint 零 Error、Debug、R8 Release、instrumentation APK 构建成功。45 Conformance Fixtures，11 模块的同源 bundle 为 81,828 bytes，SHA-256 `3f494860518213f568e0c069d1037d8dbccb9c8d6a4cac44238a1f0a345417ed`。
- Android 16 Emulator：Cover 968×2376 / 420dpi 共 48 项（22 + 26），展开 1856×2160 / 420dpi 10 项，合计 58 次最终执行。三协议 HTTP Fixture 覆盖 Search → 读取 → fixture 导航 → 回复，以及空来源/未执行导航/未观察 URL 拒绝；实际 Service、Device、Cache、取消、设置与 UI 回归也通过。另有 2 次 UI seed，用于下面的 Release 检查，不重复计入 58。
- 最终同证书 R8 Preview 在自有 Emulator 覆盖安装，APK 回读 hash 一致，18 Chat / 10 runs / 5 agents、完整测试文档、UID、首次安装时间及 Accessibility 设置均保留。重启后执行卡仍可读、默认折叠，展开有实际 Tool/来源/部分完成原因；最终 Release 的共享解析、Markdown 及 Cover/展开尺寸切换通过，当前进程无 Fatal。此 Smoke 的 Accessibility setting 为 null，不借此声称 Service 验收。
- 签名、四 ABI 的 ZIP / ELF 16 KiB alignment 通过。Preview 0.7.0 (15)，target 36，4,073,031 bytes，APK SHA-256 `6b5807f8054c7919c2974af607d378986cdb697e94551341bf7e505760d58b34`；证书与历史 Fold6 Preview 一致。

初轮 UI 因测试替换 Activity Intent 破坏 ActivityScenario 生命周期而失败，已改走真实 Chat history UI 后通过；初始编译/旧工具列表断言及 R8 辅助脚本 appId 匹配失败也保留，不把它们算产品通过。原始失败、最终日志与截图 hash 在机器证据；日志/图片/APK 属于本机忽略产物。

## 交付与边界

Windows 当前会话的 `outputs/Melo-Android-0.7.0-preview.apk` 是最终签名交付，另有 SHA、verification JSON 和四张 Release UI 截图。开发回合原先未发现 Fold6；用户随后连接解锁，0.7.0 (15) 已同签名覆盖安装。实际包 hash 一致，原 13 Chat / 1 角色、UID / 安装历史及两项 Accessibility 设置保留，展开 MainActivity 启动稳定、当前进程无 Fatal。[独立装机证据](evidence/research-fold6-install-070-20261018.json)。装机回合没有读取私聊正文/配置值/凭证，也没有真实模型/Search 请求；Fixture 导航不证明真实 Maps 或推荐质量，外屏与姿态切换未复验。

Router 仍是关键词策略，不承诺任意措辞；Phone 不可用的复合请求目前会整轮 preflight 停止，工具前需澄清的情形仍可能返回证据不足。网页仅静态文本/HTML、无 Redirect，来源时间不等于营业状态。Markdown 是既有语法子集，不是完整 CommonMark。Node 同步新契约并回归；iOS 只有相同 bundle，生产 Swift/UI 未切换或原生验收。Skill 调度、全部 Context/Memory/Cache 同源化仍按原计划推进。

本轮自有 Emulator 5580 / 隔离 ADB 5048 已关闭；Windows ADB 5037 保留。没有运行完整 repo release gate、远端 CI、git pp 或 push。
