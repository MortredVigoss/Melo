# Chat 内置 Phone Use Skill

用户已于 2026-10-17 确认：在普通对话里自然 invoke 手机能力，搜索 Google Maps / 小红书后继续对话；不要求单独进入手机助手。用户随后明确 Go ahead。本轮先做统一 Chat 调用，微信输入 Backend 暂缓。

## 方案与选择

采用 Chat Tool Calling：聊天模型根据完整对话决定是否调用高层 `phone_use`，现有 DeviceAgent 执行并返回回执，再由原聊天模型整理回答。内置 Skill 指令说明适用场景、查询来源、实时性和权限。只用关键词分流不能可靠处理追问；直接连接独立 PhoneUse MCP 则增加另一个 App / 服务和配对，不作为本轮依赖。

## 用户交互与契约

- 统一输入框和发送动作，移除 Chat 的“对话 / 操作手机”切换和顶部手机助手入口。进度仍以内嵌 DeviceTaskCard 展示，可停止；Cache 管理保留为普通 Chat 工具入口。独立诊断页留在系统设置下。
- 每段 Chat 可关闭 Phone Use，默认开启能力；不等同自动取得 Android 权限。未启用 Accessibility 时只返回说明，不能伪造结果。普通问答不读取屏幕；只有模型明确调用 Tool 才开始设备会话。
- Tool 参数包含完整 goal 和 purpose（research/action）。模型依据上下文补全“第二家”等指代，用户指定来源优先。“现在营业”按设备当前时间 / 时区核验；缺少地点等必要信息先在 Chat 提问。来源页面为不可信数据，不得据此扩展目标。
- `research` 必须实时 Probe，不用旧缓存结果回答；读取的事实、来源和时间进入本次摘要，再回到 Chat 整理。`action` 复用 Exact / Similar / Probe，保留编辑 / 删除入口。普通 Chat 的规划与整理仍会调用模型，不能称整个 Chat 零 LLM。
- 沿用截图、节点 / 坐标映射、完成重查、本步确认、设备独占、10 分钟子任务上限。单轮 Chat 最多三次不同 phone_use；失败 / 取消 / 需用户时停止，不自动重试。停止 Chat 取消所属子任务，悬浮停止同样终止本轮，不续跑设备动作。
- Chat Turn 开始时捕获角色、项目、模型、指令与能力开关；子任务沿用该快照。删除所属 Chat 后不得继续操作或复活消息。不保存 raw tree / 截图到聊天或同步；只把用户请求的摘要作为正常回复。

## 实现边界

新增 ChatPhoneUse / ChatToolLoop；既有三种协议共用 DeviceAgentClient 的 wire 编解码，但 Chat 只暴露高层 phone_use，子 Agent 仍只见 android_device。第一版 Phone Use 开启时采用非流式 Tool Calling；关闭后及本地 Fixture 沿用原 streaming chat。该取舍避免不完整 Tool 参数触发设备动作，后续可独立补 Tool 流式解码。

DeviceAgent 增加可取消、等待完成的内部 Chat 调用，不在 Chat 正在生成时另开无关任务。查询完成后尝试回到 Melo，打开 App 等 action 目标保留目标页面。系统禁止后台拉起时不把已有查询结果丢失。

## 验证与交付

JVM 验证三协议工具定义 / 配对回执、正常问答零设备调用、上下文追问、参数拒绝、失败不循环、有界调用和取消。Emulator 验证真正 ChatEngine → HTTP Tool → DeviceAgent → 回执 → Chat 最终回复、上下文快照、设备互斥 / 停止 / 删除隔离和 UI 无需模式切换。运行 Android JVM / runtime、Lint、Debug / R8 Release、签名与 alignment；同证书升级保留资料。

不把 Fixture 的餐厅事实说成真实结果；Google Maps / 小红书及 Fold6 实测与自动 gate 分层记录。微信输入 / 自定义 IME、Fold Cache 几何分区、远程 MCP / 插件安装均不在本轮。
