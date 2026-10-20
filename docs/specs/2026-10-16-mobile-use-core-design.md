# Mobile Use Core v1

用户已认可 repo 审视给出的顺序并要求开始。本轮在 `codex/mobile-use-features` 完成 Core、Chat 接入和 Android gate，不更换模型、不使用真实凭证、不操作实体机。

## 执行契约

- `android_device.finish` 显式声明 achieved / blocked / needs_user。achieved 必须引用最近 screen_id，声明 expected_package 或 visible_text，并由 executor 重新观察后检查；只能证明这些可见事实，不等于任意业务效果已由系统验证。没有可校验证据的普通模型结束归 needs_user；旧 completed 记录显示为历史模型结束，不追认。
- Node tap / type 在窗口、尺寸、观察有效期未变时 refresh 并逐项核对节点身份、标签、能力及 bounds；其他节点变化不阻止目标操作。坐标仍要求原画面 generation；折叠/窗口变化必须重新观察。观察等待短暂稳定并返回稳定状态，不无限等待动画。
- 成功 observe 不能清除未解决的动作错误。重复动作失败、重复观察无变化和总步数/时间分别限制；App 搜索保留一次改策略机会。保存 call ID、action、耗时、错误码、恢复次数，默认不保存参数、UI tree、图片或输入文本。
- 保留最近完整观察和少量历史 Tool 回执，以完整 call/result 对为单位裁剪；用户目标始终保留，超出预算则明确停止。
- Native executor 对坐标点击和明确的提交/删除/付款节点要求本步确认，确认绑定当时动作和屏幕，取消/屏幕改变不能复用。节点风险识别有语义边界，不宣称任意自绘控件都能被分类。

## Chat 与状态

- ChatEngine 按 chatId 管理独立 Job、partial 和取消；重复提交同一 Chat 明确提示。通知保留至最后一个 Chat 完成。
- Chat composer 显式切换“对话 / 操作手机”，设备任务捕获 chat / agent / project / connection 的不可变上下文；全设备只允许一个任务，冲突明确反馈且保留草稿。
- Chat 内展示设备任务状态、步骤和停止操作；独立设备页保留为权限、Display / 截图与全部历史入口。设备任务与截图不进入 portable sync。

## 验收与实施顺序

1. 新增纯 Kotlin loop / policy 的 Fixture 测试：拒绝假完成、证据新鲜度、诚实阻塞、无进展和错误恢复、协议配对与 Context budget、取消。
2. 接原生 executor 与确认 UI，Emulator 验证动态 Node、旧坐标、目标改变、窗口改变、真实点击输入与中途取消。
3. 接 per-Chat 并发与嵌入任务，验证双 Chat 不丢请求、取消隔离、上下文不串线和 Device 独占。
4. 将 Android 路径纳入 daily test plan，增加明确可运行的 Android CI；运行 JVM、Lint、Debug / Release 与隔离 Emulator suite。WSL file identity 6 项属独立 Node 安全边界，本轮不仓促修改其授权模型，记录为未解决基线。

实体 Fold6 / One UI 8.5、真实模型完成率和发布签名仍单列待验；编译或 Fixture 通过不能替代这些结果。
