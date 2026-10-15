# Agent 设置收口（设计 Melo）

用户要求移除 Sharp / Warm 等旧情绪设置和 UI 残留、补齐新增 Agent 入口，并统一设置界面。

## 已确认原因与实现

- 新增按钮位于被神经布局隐藏的旧列表；页头现在有固定的新增入口。创建时防重复点击，失败可重试，成功进入全局设置并直接编辑名称。
- `desktop-ui/app.js` 原有两个 Agent 编辑器。直达 Agent 和旧 Customize/Agents 路径现在共用同一页面；基础资料、人设、模型、能力协作、消息渠道使用统一表单与编辑/保存状态。
- 清除 Mood 控件、聊天选择器/任务卡标签、旧编辑器，以及与正式能力配置重复的旧 Tools/白名单 UI。未实现的 Lark 占位入口退出设置页。Markdown 导入导出、头像、Telegram/Discord、项目覆盖和同步权限确认保留。
- `desktop-ui/agentSettings.css` 使用现有黑金玻璃变量，减少嵌套留白，统一字号和输入控件，保存操作随滚动可达；折叠区保存展开状态。
- `src/services/chat/systemPrompt.js` 和 `ios/Melo/AgentProfile.swift` 停用旧 mood 注入。保留旧存储/同步字段，用户自己写的人设不改；不迁移或删除实际配置。
- 新增默认作用域在 `src/services/agent/agentMutations.js` 写入 global，防止继承上一个项目的设置范围。

## 验证与边界

- 初步专项 27/27 通过：提示词、实际浏览器人设保存/失败草稿/Markdown、同步权限确认。日志 `.tmp/agent-settings-20261015/focused-first.log`。
- 新浏览器验收通过：新增按钮首屏可见、创建失败重试/并发双击只创建一次、项目范围创建切回全局、两个入口同一表单、折叠区保存权限不变、编辑取消/失败草稿、渠道切换、五语、1440/1100/390 宽度不溢出。截图 `editor-{1440,1100,390}.png`，最终日志 `editor-third.log`。
- 首轮新测试实际发现跨渠道编辑丢失：旧 UI 仅挂载当前渠道，保存也仅收集当前渠道。现两侧字段持续挂载、仅隐藏非当前面板，保存同时提交两边；第二轮渠道持久化通过。旧 mood 不再出现在同步冲突摘要。
- 共享树 `npm test` GREEN：3573/3573 JS、845 文件语法、设置/加速两组浏览器、23 Swift 组及共用渲染校验，175.9 秒。日志 `daily.log`；这是日常 gate，不是完整打包发布 gate。
- 已重启实际桌面应用，后端 PID 61208；原生 UI 确认页头“新增 Agent”、统一编辑/保存、能力与渠道折叠区，无 Mood/旧 Tools/旧 Save as skill。未在真实配置新增测试 Agent。
- 重启前后 14 聊天/6 Agent/1 项目一致，43 个持久化文件中 42 个散列不变；主状态仅 settings、revision、频道绑定变化。证据 `runtime/{before,after}.json`，原始副本在同目录 backup。未实际调用远端模型或消息渠道。
- 独立暂存树额外验证 27/27 JS（含真实浏览器创建/持久化）及 21 Swift 组通过；生成资源只纳入本次翻译，不纳入其他线程 WIP。初次独立启动因未链接本机原生 addon 失败，补齐既有 build 依赖后通过。日志 `staged-focused-second.log`、`staged-ios.log`。
- 共享树其他线程 WIP 保留，编辑前副本 `.tmp/agent-settings-20261015/before/`。本轮不运行 git pp 或推送。
- 手机源码只同步停用 mood 注入；本轮不代表实体手机覆盖安装。

源码本地提交：`dc67fa0`。以上日常、独立暂存树及原生桌面验证均完成；本轮未运行 git pp 或推送。
