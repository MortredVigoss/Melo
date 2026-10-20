# Melo Android 0.3.0 — Mobile Use Core 与 Chat 内嵌

用户认可 [repo 审视](mobile-use-repo-review-20261016.md) 的顺序并要求开始。本轮不更换模型平台，不使用真实 API credentials，不操作实体机。设计边界见 [规格](specs/2026-10-16-mobile-use-core-design.md)。

## 交付行为

聊天输入框上方选择「操作手机」后发送目标，设备任务按时间顺序出现在当前 Chat；后续文字回复显示在该任务之后。卡片包含目标、模型连接、真实步骤、结果和停止按钮。独立助手页保留权限、Display、截图选项与本机全部历史入口。

```text
Chat 的不可变角色 / 项目 / 模型上下文
    → 单一设备任务 → 模型 Tool Call
    → Native 目标校验 / 必要的本步确认 → Accessibility action
    → 新观察 → 完成证据检查或有界恢复
    → 同一 Chat 的本机任务卡片
```

- 模型通过 `finish` 声明 achieved / blocked / needs_user。achieved 必须引用最近 screen_id，并声明 expected_package 或与节点完全匹配的 visible_text；Host 重新观察再检查。普通最终文字经过一次协议纠正后仍无证据则归 needs_user，不能用“工具曾成功”代替完成。校验只证明声明的可见事实，不保证任意业务效果或模型对用户意图的解释正确。
- Node tap / type 不再因无关节点更新一律失效；执行前 refresh 并核对原节点身份、文字、能力、窗口与 bounds。坐标 / swipe 仍要求画面 generation、窗口、尺寸和有效期未变；观察只做有上限的稳定等待。Home 修复继续保留。
- 坐标点击和可识别的发送 / 删除 / 付款等节点需要原生本步确认。悬浮按钮显示目标文字或坐标；允许后重新检查原目标和画面，拒绝、取消或超时不会复用许可。过短 / 原地 swipe 被拒绝，不能作为绕过坐标点击确认的方式。风险标签分类不能覆盖所有自绘、未知语言或特殊触摸语义，不宣称通用语义安全证明。
- 连续动作错误不会被成功 observe 清零；反复观察 / 搜索已见状态会触发无进展停止。状态 Hash 同时参考节点与截图，避免游戏空 UI tree 在画面变化时被误判；Hash 仅在内存中保留。完整 catalog 搜索与一次缺 App 恢复保留，普通最终回复和结构化 finish 都不能跳过该次恢复机会。
- 历史按完整 Tool Call / Result 对裁剪，保留原目标、最近观察、当前搜索结果和最新截图。160k text characters / 2M wire characters 与 32k 角色 / 项目指令限制是本机字符预算，不是 provider token 精确计量；超预算明确停止。

## Chat、持久化与取消

ChatEngine 按 chatId 管理 Job、partial 与取消；A 结束或取消不会清除 B 的执行状态，通知保留至最后一个文字请求结束。同一 Chat 的重入和设备控制冲突明确提示并保留输入。通知的停止动作明确为取消全部文字生成。

设备任务在调度前捕获 chat / agent / project / connection 和指令，执行时不重新读取全局模型选择。全设备只允许一个 DeviceAgent；同一 Chat 不能同时执行文字生成与手机操作。关联 Chat 被同步删除后，下一次设备动作前停止，不继续使用已删除上下文。

DeviceRun 新字段都有兼容默认值，旧 `completed` 只显示为历史模型结束。恢复进程时的 running 记录仍转为 interrupted，不自动恢复动作。设备任务不进入 portable snapshot；本机保存目标、步骤摘要、call ID、耗时、错误码与恢复次数，不保存参数、原始 UI tree、截图或凭证。用户目标及模型最终摘要本身仍属于本机记录。

## 工程检查

最终本机结果：59 JVM tests、24 Android 16 Emulator runtime tests、9 项工程 gate tests 全部通过，无 skip；Lint 0 errors，Debug / R8 Release 与 856 个 JS 文件语法检查通过。cover 968×2376 与 unfolded 1856×2160 / 420 dpi 的 UI 检查各通过一次，并人工检查截图。Preview APK 3,794,157 bytes，证书与 0.2.3 相同，signature / ZIP / 四 ABI ELF 16 KiB alignment 通过。

优化后的签名 Preview 还在 Emulator 上从 Debug 覆盖安装并冷启动，首页本机 2 段测试聊天 / 1 个角色计数保持；这证明本轮该 Fixture 的更新 / 初始化路径，不等同 Fold6 或全部用户资料迁移验收。证据 `.tmp/mobile-use-release-smoke.json`。

Android / 共享 schema / iOS scene 改动加入 daily Android gate；仅 Android 改动不再误选全部 Node / Swift。完整发布 gate 包含 check:android，缺少 JDK / SDK 明确失败。新增 Android CI 定义覆盖 JVM、Lint、Debug、Release 和 Android 16 Emulator。Node engines 与现有 node:sqlite / README 下限统一为 22.13。

运行时 Fixture 会创建测试聊天、写入假凭证并启用 Accessibility，因此 runner 在任何修改前要求 ADB server 上只有一台 ready Emulator；有个人手机、第二台设备、offline 或选择不符均拒绝。不使用真实模型或用户手机作为自动 suite 的目标。

```bash
npm run check:android
ANDROID_SERIAL=emulator-5554 npm run test:android:connected
node --test scripts/android-target.test.js scripts/test-plan.test.js scripts/test-discovery.test.js scripts/check-syntax.test.js
npm run build
```

开发中发现旧 Fixture lifecycle 测试按固定 Prompt / 全局 Run 匹配历史记录，重复运行会超时或读错旧 Chat；现按本次 chatId 与唯一 Prompt 校验，没有增加 Timeout 或跳过断言。

证据保存在本机 `.tmp/mobile-use-core-{jvm,check,connected}.log`、`.tmp/mobile-use-engineering-tests.log`、`.tmp/mobile-use-build.log`，以及 Gradle 的 JVM / connected / Lint 报告。交付目录附有 APK verification JSON、SHA-256 和 Emulator 两种 viewport 的 UI 截图。

## 验收边界与后续

- Fold6 / One UI 8.5 权限、折叠 / 分屏、Samsung 省电策略、真实模型 Tool Calling 与任务完成率，本轮未验收。Emulator 的 cover / unfolded 尺寸只验证布局，不能等同 Samsung firmware。
- 远端 CI 尚未推送或执行；没有运行 macOS 完整发布 / 安装 gate。Preview APK 使用已有 development certificate，不是正式发行签名。
- 原审视的 6 个 WSL Node File identity 失败，以及 Chrome / Ruby 环境缺口，本轮没有修复，也没有将其隔离成绿色。新的 Kotlin 团队行为契约、存储容量 benchmark 与增量持久化仍是后续工作。
