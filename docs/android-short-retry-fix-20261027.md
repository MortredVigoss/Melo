# Android 短句“重试”丢失手机任务（2026-10-27）

## 来自手机记录的事实

用户在安装 0.10.0 后反馈无法使用。本次只读取最新相关对话/Run、当前画面、进程和 OS Accessibility 状态；私人数据库、偏好和画面保存在外层任务忽略目录 `work/organizer-debug-20261027/`，未提交。

- 首次“打开汽水音乐，搜索歌曲并播放”返回 device_unavailable：当时执行器为空，在建立 DeviceRun 前停止。现存记录不能证明是更新导致权限关闭，也不能据此归咎广告。
- 后续用户输入“重试”，Core plan 为 none/conversation，Goal.original 变成字面“重试”；没有 phone_use 调用，文字拒绝被当成普通回答交付，显示 completed。
- 调试时 OS 的 enabled 与 bound services 均包含 Melo；没有用 ADB 改写手机 Accessibility 设置或授予权限。
- 当时日志中的 tools=[] 仅是 plan.tools 路由建议，并非完整请求目录；不能据此断言所有工具未注册。实际 Android 在此路径仍提供 Organizer 等工具，但缺少 phone_use。

## 修复

共享 Core 的 continuation matcher 漏掉了“重试”，原先支持“再试一次/继续/retry”。新增“重试/重试一次/重试一下/请重试”，复用原有历史边界与限制规则；取消、禁止手机操作和缺少历史不能恢复权限。

```text
原任务 -> 权限失败 -> 用户“重试”
  -> 恢复原始目标和当前权限 -> phone_use Schema + requiredTools
  -> 执行并取得回执，或明确 blocked
```

Android 执行记录将路由建议标为 suggestedTools，另列本轮 registeredTools，包含历史回读、Organizer、phone_use、可用原生 Search 和 Smart Routing control。它显示注册目录，不把已注册当成已执行。

未新增 Agent Loop、关键词强制搜索或自动绕过权限。原有 MISSING_TOOL_EVIDENCE 校验在恢复目标后生效：模型没有执行要求的手机任务时不能标 completed。

## 验证

- `.tmp/retry-short-red.log`：同一原句重现 none != phone；修复后 Core 213/213 通过。
- `.tmp/retry-fix-native.log`：11/11（ResearchExecution + ChatPhoneUse），覆盖真实启用的 Emulator Accessibility 与父子调用；新用例在 Chat Completions / Responses / Anthropic 三协议分别验证调用成功和拒绝执行两条路径。
- 最后补齐目录中的 Smart Routing control 后重新构建；`.tmp/retry-fix-final-native.log` 通过同一新用例的六个组合，所用 APK 即 0.10.1（25）。
- 快速档 `.tmp/test-runs/run-xAkI0L/summary.json`：Android JVM/Lint/Debug/Release、语法/生成器/共享渲染通过；JS 4620 中 4603 pass / 2 fail / 15 skip。两个失败仍为私有 winter 原始媒体缺失，未删除、伪造或跳过。没有宣称全仓 GREEN；此批未重复完整 Native 宠物测试或 macOS Swift 验收。

## 手机补丁安装与待验

0.10.1（25）已用 install -r 覆盖安装到 Fold6；SHA256 `3a6d72cb16d1d93cdb322924244e44cf8c571ee746d3ac4ae3f1ee2f0dd01ec2`。未清数据；安装前另存数据库/设置备份，当前聊天无未发送草稿。安装后核对版本、启动 Intent 和 Accessibility bound 状态。

手机随后处于锁屏，已向用户请求解锁或自行试用；在回答前不执行依赖解锁的操作。当前没有实机汽水搜索/播放成功证据，不把 Emulator Fixture 当成真实模型/广告验收。
