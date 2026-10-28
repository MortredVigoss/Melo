# Android 模型 Transport 与错误展示修复 — 2026-10-28

## 证据与边界

用户提供的0.10.7截图：注册13个Tool，第一轮模型请求约76060ms后失败，没有Search或原生操作回执。仅凭截图不能区分HTTP错误、Timeout或协议回执错误；不能声称本轮已经读取手机原始Trace或确认其上游故障原因。用户手机未参与本轮。

上次真实模型验收是Bedrock非Streaming路径，没有覆盖此次GPT/Modal连接；这是验收缺口。没有把此前Native、Fixture或Bedrock结果扩展成用户这条连接的验收。

## 已确认并修复的源码缺陷

- Tool Calling Transport强制stream=false，忽略Connection.stream；现按实际连接配置发送，在JSON回执之外支持Chat Completions / Responses / Anthropic的SSE。只在结束回执完整、工具参数校验通过后返回DeviceTurn，不从中途delta执行动作，不自动重发失败模型请求。
- Responses以完整response.completed为准；Chat拼接分片Tool ID/名称/参数并要求finish_reason；Anthropic拼接JSON、合并Usage、检查Block结束、保留后续请求所需的opaque签名。私有thinking/reasoning_content不进入公开进度或回答；现有本地Trace脱敏继续生效。
- HTTP拒绝立即保留安全状态码与Request ID，不等待错误正文；连接/读取Timeout、DNS、TLS、中断、无效回执分别给出安全错误码。Provider原文、URL和凭证不进入用户错误消息。未盲目加长Timeout，不自动降级到手机屏幕，不添加重试循环。
- 第一轮失败会写入对应模型步骤的实际安全原因和停止码。Chat卡折叠时也显示RunRecord.error，重启后仍能看到。运行中按实际接收状态显示等待响应/已连接/生成参数；这些是Transport事件，不冒充模型思考。

## 本地验证记录

先生成本任务plan；新增源码/测试登记并重新生成Module Map后再运行同范围检查。最终代码 JVM **201/201** 通过；API36 Emulator Native **29/29**：Chat7（含真实SSE工具回执继续主Loop、504停止码/原因/零设备调用）、Presentation3（折叠可见错误及重启保留、视觉截图核对）、Search9、Research8、Trace2。快速档 `run-0ZfYaf` 与集成档 `run-lX8oaW` 均为 JS4653 / 4636过 / 2私有桌宠素材失败 / 15跳过 / 0取消，无隔离重试。Android JVM / Lint / Debug / Release通过。

保留失败记录：首次取消Fixture用throttleBody同时限制了请求上传，服务器未收到完整请求；改成真实响应Headers后延迟Body，并保留取消时限/未返回Tool/仅一次请求断言。首次Presentation新用例末尾返回Bitmap.compress的Boolean，JUnit拒绝非void方法；补Unit后重新运行，不跳过或削弱用例。原日志保存在本机.tmp/model-transport-fix-20261028。

先完成隔离HTTP Fixture与API36 Emulator验证，随后找到此前用户已授权复用的Proxy Key，仅在内存中读取，未创建或写入新Key。对同一GPT/Modal服务发出**一次**不含私人记录的公开合成请求，携带Shared Core生成的13个Tool、stream=true：HTTP200 / text-event-stream，Headers与首字节14939ms，完整回执15692ms；模型选择web_search，参数通过Shared Core schema校验，实际执行Tool数为0。原始合成SSE和安全指标仅留本机.tmp，不作为发布附件。

这证明当前服务接受Streaming并能返回有效Tool回执，不证明手机当前Stream配置、此次76秒错误的准确类型，或完整餐厅搜索/导航任务已通过。没有读取或操作远程手机；私人Trace未上传、未作为模型请求内容发送。Streaming不保证降低模型推理耗时。0.10.8（32）修补包的发布与最终Gate见下文。

服务端源码另确认Proxy的request-log / logging-to-file关闭，子进程stdout/stderr不进入Modal日志；未为诊断打开远端请求日志，不能靠这些已关闭的日志回溯此次76秒错误。

## 最终Gate与试用发布

- 已实际执行 `npm run test:full`，本机完整日志 `.tmp/model-transport-fix-20261028/full-gate.log`；自动发现Regression 4659项 / 4642通过 / 2私有桌宠素材失败 / 15跳过 / 0取消。Settings Browser、iOS Renderer/Bridge4、Android JVM/Lint/Debug/Release、语法、Desktop Smoke、Runtime Browser、Bootstrap契约通过。
- 完整Gate退出1：素材store缺文件，macOS Desktop构建/Lifecycle/安装/启动在Linux缺macOS/zsh/open而失败；Swift/JSC明确跳过。没有跳过失败、弱化断言或宣称全平台GREEN，Fold6实机仍未验收。
- Source Commit `8d760360891f463fd31c799c4760f03608de7a8a`；已按本会话Branch试用分发授权推送并发布 [0.10.8 Pre-release](https://github.com/MortredVigoss/Melo/releases/tag/android-v0.10.8-organizer-preview.1)，未合并master，不设置latest，不移动0.10.7 Tag。
- APK `Melo-0.10.8-model-transport-debug.apk`，224648707 bytes，SHA256 `db9ebde39aac09ffd3d6a97bf6d8ff7c3778f7a6a40ee5cb5dadce8300ea40b7`。版本32 / 0.10.8；签名与0.10.7相同，APK条目无删除，未包含凭证/Trace/数据库。GitHub asset digest与本地一致，两附件匿名下载200且Content-Length正确，SHA256SUMS原文核对一致。
- 上传仅APK和SHA256SUMS；原始手机Trace、Proxy合成SSE、截图、完整日志仅本地。模型已返回完整工具回执的检查不等于搜索和导航已实际执行；本轮不要求用户重复任务来替代本地验证。
- 结束时仅本轮拥有的Emulator已停机，Gate自身测试服务已清理。修补包会显示旧RunRecord已保存的error，不能补回原来已被丢弃的底层异常原因。
