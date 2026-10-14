# Melo 原生工具调用

依据用户指定的 [OpenAI Function calling 文档](https://developers.openai.com/api/docs/guides/function-calling?api-mode=responses)，2026-10-14。

## 实施边界

当前自有工具以 XML 文本声明和回传；Codex Responses 仅发送服务端内置搜索、生图工具。改为在支持 Responses 的通道发送真正的 function 定义，Melo 继续负责权限、白名单、调度和工具执行。其他兼容平台保留现有协议，不假定它们支持 OpenAI 的严格模式。

1. Codex OAuth 和官方 OpenAI API 的任务工具循环使用 Responses function calling；普通文本请求保持现有返回值。主聊天、子任务和技能共用参数编译及调用续接契约。
2. 可安全转换的 schema 使用 strict；可选参数以 nullable 表示，并在执行前恢复省略语义。字典等不能无损转换的 schema 明确 strict:false。执行前以原 schema 校验，错误参数不触发权限请求或实际工具。
3. 严格区分 output item id 与 call_id，处理多个调用和分片参数；只在完整响应完成后执行。逐项保留本轮 reasoning、function call 及 output，不显示或持久化加密推理内容。
4. 函数定义计入上下文预算；本轮续接链不可拆散裁剪。复用既有意图路由与白名单，取消工具描述在 system prompt 和 tools 中的重复注入。
5. 保持写工具串行，限制安全工具的并发和单批调用数量；未完成流、坏参数、未知工具、取消、重复调用均有确定反馈。

## 验证计划

用本机 HTTP/SSE fixture 验证两轮及三轮请求的实际 payload 和执行次数；覆盖严格 schema、可选 null、MCP/skill 名称映射、同工具多调用、分片参数、reasoning 原样续接、工具预算、断流零执行、权限拒绝及原有其他平台兼容路径。专项脚本接入正常自动发现 gate，再跑完整 gate。真实账号调用及 iOS 独立执行链另列边界，不把 fixture 成功描述为线上验证。

用户已授权实施，无需再次确认本方案。此次为行为优化，非逐字节移植。

## 已落地的行为

- Codex OAuth 和官方 `api.openai.com` 的工具循环自动启用原生协议；Melo 主聊天、子任务、可执行技能使用同一套调用契约。其余供应商保留现有兼容路径，未调整用户的模型选择、密钥或权限设置。
- MCP 和 skill 的带冒号、中文或过长 ID 转为稳定的函数别名，只能在本轮白名单内还原。函数参数采用本机 Ajv 校验，不发送到校验服务；未知函数、坏参数不触发授权或执行。无法编译的 schema 在发请求前指出具体工具。
- 严格 schema 把可选字段表示为 nullable，执行时恢复省略语义；保留原本允许的 null。字典或不能无损转换的复杂分支明确使用非严格模式，仍做本机原 schema 校验。支持本地引用、递归根引用；不下载外部 schema 引用。
- SSE 参数仅组装，不边收边执行。完成后按 `call_id` 回传每项结果，保留所有本轮 reasoning/function_call/function_call_output。加密续传内容只留在临时请求链，不进入聊天正文或任务场景。
- 单批最多 32 次调用，安全工具最多并发 4 个；写工具形成顺序屏障。整个当前调用链和工具定义计入上下文预算，超限时明确失败，不切掉中间调用再继续。技能耗尽执行上限不会报告成功。
- 工具执行继续经过 Melo 现有的白名单、授权、取消、账本和执行事件；模型返回工具请求时标为“待执行”，不把请求本身标为操作成功。

## 验证与边界

`npm run test:function-calling`：33 项通过。新文件已通过自动发现进入 `test:unit` 和 `verify-red-green`，无排除或隔离。

实际本机 HTTP/SSE fixture 覆盖主聊天、子任务、技能的三轮调用，检查发出的 `/responses` payload、完整续传、同工具多调用、权限拒绝及参数错误回传。计数器证明断流、提前取消、未知工具、坏参数没有执行工具。另以注入 fetch 验证 OAuth 请求格式。

共享工作树中另有界面与观测改动。仅取本次源码改动加既有基线的独立临时副本，33 项专项和 104 项既有回归均通过，证明本次提交不依赖那些尚未完成的改动。

真实 Codex OAuth 冒烟测试使用本机已有连接及用户当前选择的 `gpt-6.1-sol`，仅发送合成加法任务：两次请求、一次 Melo 临时工具执行，模型正确回传 `42`，服务报告模型同为 `gpt-6.1-sol`。未读取或上传聊天记录，未修改用户连接；隔离临时 home 在测试后清理，摘要保存在 `.tmp/function-calling-20261014/live-result.json`。

最终完整 `npm test` GREEN：3479 项回归、19 组 Swift、设置与运行时浏览器检查、桌面打包安装、桌面目录和 Launchpad 两个原生入口通过。首轮遇到并行界面改动导致的共享渲染资源散列过期，重生成后完整复跑通过；最终日志 `.tmp/function-calling-20261014/gate-final.log`。

官方 API key 通道仍只通过 fixture 验证；未测真实 API key 请求、复杂任务回答质量或提速幅度。iOS 自己直连模型的执行链未迁移。没有引入新的远端 harness，没有自动增加模型调用，也未引入延迟工具发现（tool search）或对工具数硬切为 20。

应急兼容开关为服务进程环境变量 `MELO_FUNCTION_CALLING=legacy`：主聊天及其委派恢复原文本调用方式；这是开发运维回退入口，不是新增系统设置。程序内部显式 `apiProtocol: responses` 供适配与测试使用，未向自定义连接设置增加新的协议选项。
