# Melo 模型连接（2026-10-08）

用户确定的边界：平台提供模型推理，Melo 保留自己的角色、记忆、权限、工具执行和任务循环。没有嵌入 Copilot SDK、Gemini CLI、Kimi Code 或 Claude Code 的代理运行时；聊天失败也不再回退到 `codex exec`。原有 ChatGPT 模型端的搜索/生图能力仍由 Melo 选择、记录，不因此扩展到其他 API 平台。

## 已接入

| 平台 | 连接方式 | 推理通道 |
| --- | --- | --- |
| ChatGPT | 原有浏览器 OAuth 登录 | Melo 直接请求 Codex Responses |
| OpenRouter | API Key 或新增浏览器 PKCE 授权 | Chat Completions，使用 OpenRouter 额度 |
| OpenAI API、DeepSeek、豆包方舟、Gemini、Kimi Moonshot、通义百炼 | 各自 API Key | 官方兼容 Chat Completions 地址 |
| Anthropic Claude | Anthropic API Key | 原生 Messages API，JSON/SSE |
| 本地模型、自定义服务 | 本地地址或兼容 API Key | 桌面支持 Chat Completions / Anthropic Messages |

Copilot、Gemini CLI、Kimi Code 的客户端登录目前不作为纯推理 OAuth 接口提供。没有把消费端网页登录或第三方代理 SDK 误标成 Melo 已完成的模型授权。豆包等平台需要 API 凭证，普通聊天网站登录不会生成可供 Melo 使用的凭证。

## 使用

桌面入口：**系统 → 模型 → 模型提供方**。选择平台，填写模型 ID（豆包也可用已开通的 ep 接入点），填写 API Key 或完成相应授权，然后点击“测试实际请求”，成功后“设为当前模型”。模型列表来自服务端；不提供列表时可手填，列表存在不等于账号有调用权限。服务地区、地址和密钥应匹配。

每个平台分别保存凭证、地址和模型。留空只保留该连接的已有密钥；清除使用单独选项。修改服务地址后必须重新填写或清除密钥。保存未启用的连接不切换当前模型，也不会破坏原有环境变量配置；切换后聊天、角色及辅助模型请求采用选定连接，角色提示词和 Melo 工具配置保留。聊天顶部仅切换模型时仍保留当前供应商和协议。

测试发送一次简短的 `2+2` 推理请求，不执行搜索/文件/图片操作；展示请求模型、服务端返回模型、耗时和回答。缺少返回标识时显示未提供；失败、截断或模拟响应不会冒充真实成功。测试记录仅对当时的模型/地址/凭证有效，不变的保存、启用和重载保留记录。

OpenRouter 授权使用独立本地回调、PKCE S256、state 校验、超时和取消；授权完成只保存连接，不自动切换。桌面可重新打开或复制授权链接。密钥只保存在本机，配置文件权限为 0600，前端连接数据与内置连接器摘要不含原始模型密钥。手机凭证存在 Keychain。

## 手机

设置 → API 模式可分别保存平台、手填/发现模型、测试、切换和登录 OpenRouter；Anthropic 使用原生 Messages API。原有 ChatGPT 登录保留。手机 API 模式仍为文字对话，尚无桌面工具执行能力，不能因模型已连通而宣称已搜索或操作文件。此轮源码和模拟器构建已验证，未安装实体 iPhone。

## 验证证据与限制

- 实际 Melo 桌面使用现有 ChatGPT OAuth 测试成功：请求与服务返回均为 `gpt-6.1-sol`，回复 `4`，约 2501 ms。没有切换原有全局模型或角色配置。
- 91 项模型专项、133 项设置/复制相关回归、7 组 Swift 程序、共享场景桥接、iOS 模拟器构建通过。协议测试使用隔离 HTTP 服务，覆盖独立凭证、请求路径、返回模型、SSE 完整性、旧设置/环境变量保留、并发修订、OAuth 成功/拒绝/取消和脱敏。
- Chrome 隔离界面验收确认保存→实际 HTTP 请求→启用→刷新后测试记录保留，无前端错误；实际原生 Melo 也显示新连接入口及 ChatGPT 真实测试结果。截图位于 `.tmp/llm-provider-proof/`。
- 扩展全量检查首轮 3156/3157，通过外的 sub-agent 白名单测试在同一工作区并行修改期间使用了旧期望；当前文件独立复测 12/12。未将首轮结果改写为全绿。
- `npm test` 的手机资源清单失败已通过重新打包并运行完整 iOS 门禁解决。另有两项原生启动测试仍断言旧侧栏/New chat 布局，与当前神经工作台不符；原生应用实际可启动。此轮不改写其他线程负责的整体验收规则。
- 尚未获得第三方平台真实 API Key，也未以真实账户完成 OpenRouter 授权。因此这些平台的账号权限、余额、地域、限流和真实推理仍需用户填凭证后点“测试实际请求”；协议通过不等于厂商账号已验证。没有添加虚假的可用状态或承诺复用消费订阅。

## 官方依据

[OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)、[Gemini 兼容 API](https://ai.google.dev/gemini-api/docs/openai)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[Kimi API](https://www.kimi.com/en/help/kimi-api/api-overview)、[百炼兼容 API](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)、[方舟兼容 API](https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh)。这些链接说明协议或授权机制，不能证明当前账号已经授权或调用成功。


## 2026-10-08：图片能力单独验证

连接页的「测试图片识别」发送本机随机数字图，必须正确读出图中文字才记为通过；文字连通、模拟响应或仅返回文字不能代替识图测试。识图结果与普通请求测试分别保存，模型 / 地址 / 凭证改变会使旧结果失效。一次通过不代表所有图片都能准确理解。

系统模型页的「图片能力」可选择独立视觉连接、Codex OAuth / OpenAI Images 兼容 API / 本地 sd.cpp / MiniMax 生图引擎。API 图像模型与聊天语言模型分别配置；同一个 Chat Completions 连接不一定实现 Images API，需以实际生成或编辑返回为准。当前真实验证仍限于已有 ChatGPT 账户；其他厂商保留清楚的未验证状态，不虚构可用性。详细交互、验证记录与手机边界见 [任务空间文档](execution-panel.md)。
