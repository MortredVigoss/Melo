# Discord 暂时归档

用户于 2026-10-17 决定暂时归档 Melo 的 Discord 接入（与 2026-10-16 归档的 Telegram 并列）："暂时归档 telegram discord 这些，这些功能暂时不用他们"。范围仅为 Melo 运行时；不删除远端 Bot，不改 Discord 开发者门户配置。

## 行为与保存边界

- 不启动 Discord 轮询、定时器或轮询锁；直接调用 `processDiscordPollingCycle` 返回 `{ archived: true, hasActiveChannel: false, processedUpdateCount: 0, encounteredError: false }`。
- 所有 REST 出口（`discordApiRequest`、`sendDiscordMediaReply`、`pingDiscordChannel`、`fetchDiscordUpdates`）与语音运行时（`_getClient` 建 Gateway 客户端、`handleTextCommand` 的 `/join` `/leave`）在任何网络动作前抛 `CHANNEL_ARCHIVED` / HTTP 410 / `permanent: true`。旧配置 `enabled: true` 不能重新启用。
- 连接测试 `POST /api/agents/channel/test` 返回 410，不保存临时凭证。
- Discord 定时提醒保留本地对话消息；外发标记为永久失败，停止重试（Telegram 同）。
- Agent 设置页：频道区不再渲染 Discord 标签页与表单（token / 服务器 ID / 频道 ID / 测试按钮），只保留共用语音卡片（语音回复模式、Edge TTS 音色、语音风格要求）。说明文案改为"Telegram 与 Discord 已暂时归档"。
- 配置状态仍保留 Discord 的 token、guildId、channelId、轮询偏移、语音选项；全局和项目覆盖都保留。归档状态只由运行时派生（`bootstrap.js` 的 `archived: true` / `statusLabel: 'Archived'`），不把存储中的启用值改成 false。
- 历史 Discord 对话保留，可在桌面阅读；prompt 不再声明 Discord 处于连接状态。

## 实际入口

- `src/shared/channelAvailability.js`：`ARCHIVED_AGENT_CHANNELS = ['telegram', 'discord']`，前后端共用；错误文案按频道标签生成。
- `src/server.js`：`discordPollingStopped` 初始值跟随归档政策；归档时不取 `discord-poller.lock`、不调度轮询、关机时不释放未取的锁。
- `src/services/remote/discordPolling.js`：轮询入口归档短路。
- `src/services/remote/discordApi.js`：`discordApiRequest` / `sendDiscordMediaReply` 入口断言（覆盖 ping / fetch / 发送全部路径）。
- `src/services/remote/discordVoiceRuntime.js`：`_getClient` / `handleTextCommand` 入口断言，不建 Gateway、不加入语音频道。
- `src/services/agent/channelConnection.js`、`src/reminders/delivery.js`、`src/services/desktop/bootstrap.js`、`systemPrompt.js`、`channelRoutePrompt.js`：原有按 channelId 的通用归档逻辑，无需改动。
- `desktop-ui/app.js`：`VALID_CHANNEL_TABS` 与标签页切换按 `isAgentChannelAvailable` 过滤；Discord 卡片仅在可用时渲染。

## 恢复条件

恢复须由用户明确要求；没有环境变量或隐藏开关。届时从 `ARCHIVED_AGENT_CHANNELS` 移除 `discord`，设置表单、轮询、语音运行时自动恢复（代码与数据模型仍在原位置）。恢复前核对离线消息积压与原 `lastUpdateId` 偏移，避免突然回复旧消息；重新验证轮询、`/join`、提醒、媒体发送与配置保存。

## 验证

- `src/services/remote/discordArchive.test.js`：旧启用配置下轮询、连接测试、REST、语音运行时均零请求、零状态写入；全局与项目覆盖的 Discord 配置在无关编辑后保持原样。
- `src/services/remote/telegramArchive.test.js`：原"Discord 仍可连接"的断言改为同样 410。
- `src/reminders/delivery.test.js`：Discord 提醒本地保留、外发零次且永久失败。
- `desktop-ui/telegramArchive.browser.test.js`、`agentSettings.browser.test.js`：无 Discord 输入与标签页、语音卡片仍可编辑、保存后 Discord 配置保留（浏览器测试需 macOS Chrome，在用户机器上运行）。
