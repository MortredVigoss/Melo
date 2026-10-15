# Telegram 暂时归档

用户于 2026-10-16 决定暂时归档 Melo 的 Telegram 接入。范围仅为 Melo；不修改独立 OpenClaw 的 Telegram 配置，也不删除远端 Bot。

## 行为与保存边界

- 不启动 Telegram 轮询、定时器或轮询锁；直接调用轮询入口返回归档状态，处理数量为零。
- 连接测试、发送文本和媒体返回 `CHANNEL_ARCHIVED` / HTTP 410，执行前拦截。旧配置 `enabled: true` 或同步回来的旧值不能重新启用频道。
- Telegram 定时提醒保留本地对话消息；外发标记为永久失败，停止重试。Discord 提醒照常执行。
- Agent 设置页移除 Telegram 的启用、凭证、测试入口，默认显示 Discord。共用语音设置移到频道区独立卡片，仍可编辑。
- 配置状态仍保留 Telegram 的 token、ID、轮询偏移、语音选项；全局和项目覆盖都保留。频道归档状态只由运行时派生，不把存储中的启用值改成 false。
- 历史 Telegram 对话保留，可在桌面阅读；prompt 不再声明 Telegram 处于连接或等待外发状态。用户账号、Agent 人设、其他频道和资料不迁移。

## 实际入口

- `src/shared/channelAvailability.js`：归档政策，供前后端共用。
- `src/server.js`：静态共享模块路由、轮询生命周期。
- `src/services/remote/telegramPolling.js` / `telegramApi.js`：轮询与网络边界；原实现保留。
- `src/services/agent/channelConnection.js`：测试连接前拦截，不保存临时凭证。
- `src/reminders/delivery.js`：提醒外发边界。
- `src/services/desktop/bootstrap.js`：`archived` / 状态标签；`systemPrompt.js`、`channelRoutePrompt.js`：移除已归档频道的活动提示。
- `desktop-ui/app.js` / `translations.js`：入口、语音字段和五语文案。

## 恢复条件

恢复须由用户明确要求；没有环境变量或隐藏开关。届时从归档清单移除 Telegram，恢复 Agent 设置表单和标签页，重新验证轮询、提醒、媒体发送、权限及配置保存。旧表单可从归档提交的父版本读取，服务代码和数据模型仍在原位置。恢复前核对离线消息积压与原偏移，避免突然回复旧消息。

## 验证

专项使用独立 `MELO_HOME`、假网络计数器和本地 HTTP 接收器，没有向真实 Telegram 或 Discord 发消息。

- `telegramArchive.test.js`：旧启用配置、轮询、测试连接、文本/媒体/音频发送均零请求；拒绝操作不写状态；其他 Agent 编辑保留全局和项目 Telegram 配置；Discord 假接口仍可调用。
- `telegramArchive.browser.test.js`：真实 HTTP 410、无轮询锁、旧启用配置不发请求、设置入口与语音编辑、保存后配置和历史保留。
- `reminders/delivery.test.js`：本地提醒保留、外发零次且不重试，Discord 行为保留。
- `agentSettings.browser.test.js`：沿用统一 Agent 页的创建、保存和布局验收，频道测试改按归档后的入口断言。

最终测试结果、真实应用重启和数据核对回执记录在 `MELO_OVERVIEW.md` 的本线程交接；日常回归不等同完整安装或真机验收。
