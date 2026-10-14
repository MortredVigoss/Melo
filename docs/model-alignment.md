# 模型选项与真实调用核对

最新接入状态见 [模型连接](llm-connections.md)；下文保留各次核对时的历史状态。

2026-10-06：用户要求对齐 GPT-6.1 Sol 与 GPT-6 Astra。

## 选择与配置

Codex 默认模型改为 `gpt-6.1-sol`，提供 `gpt-6-astra` 和 `gpt-6-luna` 选项。前后端默认值、内置目录和独立图片工具的语言模型默认值共享 `src/shared/modelCatalog.js`。

API-key 模式也提供这些模型，保留该模式原有的经济型默认值 `gpt-4.1-mini`；自定义端点、密钥、角色模型覆盖和明确选择的旧模型不自动替换。图片生成工具自身的图像模型与语言模型是不同概念，本次没有更换语音/转录/嵌入模型。

Codex 的“刷新模型”读取本机 Codex 在最近 24 小时内获取的账号目录，过滤隐藏模型；目录缺失、过期或损坏时使用内置目录。保留当前明确选择的模型。目录提供候选项，不等同于调用成功证明。

这台机器实际使用的 `.tmp/melo-home-user/config.json` 已从 `gpt-5.5` 切到 `gpt-6.1-sol`。写入前在该 home 的 `backups/model-config-*.json` 保留原配置，只修改模型、选项和自动保存版本号；其他已有字段校验未变。

## 协议兼容与证据

- Codex 保持 Responses 通道与原工具调用机制，不强制切换用户选中的模型。
- GPT-6 图片输入纳入能力识别；Sol 6.1 / Astra 6 的 `none`、`minimal` 推理设置归一为 `low`，支持 `max`。不把 Codex 应用特有的 `ultra` 直接发送到此 Responses 通道。
- 成功回复保存 `metadata.modelResponses`，包含请求模型、服务端返回模型、通道、是否模拟。主生成和通过相同调用器执行的核验请求都可记录。
- 诊断页和 doctor 分别显示 Requested / Provider reported。服务端没返回模型时明确显示未提供，不把配置值冒充服务端证明；CLI 回退与模拟回复也不伪造模型返回值。

模型自称“我是某型号”不作为验证依据；本次以 Responses 返回的 `response.model` 核对。

## 本次验收

真实 OAuth 直接请求各验证一次，Sol 与 Astra 均 HTTP 200、完成回复，返回模型与请求一致。随后启动隔离 Melo 服务，通过实际 HTTP 聊天流程各验证一次：设置选择、请求模型、服务端返回模型、消息持久化与重载后记录一致；两项真实诊断均 GREEN。

浏览器验证两个模型选项、设置重载和 Provider reported 展示，无未捕获前端异常。全量 3,091 项测试、语法检查通过。源码与用户配置已更新；未安装或重启原生应用，也未推送。

证据保存在本地 `.tmp/model-alignment-20261006/`：`live-provider-results.json`、`live-app-results.json`、`applied-config.json`、浏览器截图和测试日志。没有进行真实图片生成、语音合成或 API-key 通道付费请求；这些通道仅有参数及兼容回归验证。

官方依据：[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[GPT-6 迁移指导](https://developers.openai.com/api/docs/guides/latest-model)。

## 2026-10-07 多供应商 API 与浏览器授权核对

桌面 API-key/local 通道实际发送 OpenAI-compatible Chat Completions 请求；并非只保存配置。用隔离本地 HTTP 服务验证了 JSON、SSE、Bearer、方舟 `/api/v3`、Gemini `/v1beta/openai`、OpenRouter `/api/v1` 前缀与模型发现。手机 API-key 通道发送完整 HTTPS 聊天端点、解析非流式正文，尚无此通道的原生搜索工具和服务端模型身份记录。桌面工具仍是 Melo 的文本工具协议，不能把 ChatGPT 原生搜索/图片能力自动归给其他 API。

复现并修复三类兼容问题：空 JSON 被当成功；SSE EOF/长度截断被当完整答案；`vendor/model` 形式的返回模型名被清空。现在空正文、未完成的流和长度/内容过滤/不支持的工具终态会报错，标准 stop 或 DONE 可正常结束；返回模型名可含 `/`，诊断记录同步保留。新增本地 HTTP 协议回归，加入模型检查门禁。80 项模型专项、70 项相关回归、手机 Swift 网络测试、修改文件语法与 diff 检查通过。本地 fixture 不等于厂商真实推理，当前桌面配置没有豆包等第三方聊天 Key，未验证其账号权限、额度或真实返回。

仍需产品接入：按供应商保存独立端点/凭证/模型，统一模型填写入口（高级连接器已有手填框，主模型设置页仍只有下拉框），区分模型发现与实际连接测试；按供应商声明并验证搜索、图片、工具与流式能力。桌面使用 Base URL，手机当前要求完整 `/chat/completions` URL，需统一引导。先接豆包方舟、DeepSeek、Gemini API，再接 OpenRouter PKCE；新授权方案本轮仅调研，未注册新应用或创建账号。

官方来源（2026-10-07 实际读取）：
- [豆包 / 方舟 OpenAI 兼容说明](https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh)：API Key + Base URL + model；文档示例 Base URL 为 `https://ark.cn-beijing.volces.com/api/v3`。用浏览器读取了 JS 渲染正文。本次未找到面向第三方 Melo 的公开豆包消费账号 OAuth 推理接入文档，不能把登录豆包网页当 API 授权。
- [DeepSeek API](https://api-docs.deepseek.com/) 与 [Gemini OpenAI 兼容 API](https://ai.google.dev/gemini-api/docs/openai)：协议路线可复用，仍需真实 Key 实测。
- [OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)：官方第三方跳转授权，返回用户控制的 API Key；可用于本地回调。它走 OpenRouter 的模型与计费，不继承各厂商消费订阅额度。
- [Gemini CLI 授权](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx)：官方 CLI 可 Google 浏览器登录，已有授权可用于 headless；可评估桌面官方 CLI 桥接，不能据此声称存在供 Melo 手机直接使用的同类消费订阅 OAuth API。
- [Kimi Code 会员接入](https://www.kimi.com/en/help/kimi-code/membership-guide)：官方客户端 OAuth、CLI/ACP；第三方工具采用 API Key，自建通用产品应看 Kimi Open Platform。
- [Claude 第三方认证说明](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)：开发第三方产品走 Console API Key 或支持的云服务；[兼容层](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)主要用于评估，长期完整能力宜接 Messages API。
- [Qwen Code 身份验证](https://qwenlm.github.io/qwen-code-docs/zh/users/configuration/auth/)：当前官方文档标注 Qwen OAuth 免费套餐于 2026-04-15 停用，不采用旧教程作为可用性证明。
- [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)：有面向开源/本地应用的官方计划用量授权；手机现有动态注册与桌面 Codex 登录桥是两种实现，不可直接推广为任意厂商通用授权。
