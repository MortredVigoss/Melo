# Android verification — 2026-10-15

## 0.2.2 App discovery 与失败后的恢复

用户的真实记录为 observe 成功 → list_apps 成功 → open_app 找不到唯一名称 → 模型结束并报告列表没有该游戏。当前用户主 Profile 的 Launcher 查询有 265 个 package，旧工具只返回排序后的前 200 个，既无搜索也无分页信息；因此该记录不足以证明目标游戏未安装。用户确认平时由独立图标打开。

改为对当前 session 的完整可启动 App catalog 先搜索、后分页。支持完整 / 部分名称、Activity / application label aliases、包名片段、Unicode / 大小写 / 标点 normalization，以及有界 edit distance 的相似候选。空 query 可通过 next_offset / has_more 遍历全部结果；没有静默截断。相似候选不自动启动，仍要求确认唯一名称或确切 package。返回明确的 current-profile scope，Launcher shortcut、cloud game 和其他 Profile 不能被当成未安装。

open_app 失败返回候选与结构化原因。若模型紧接着过早结束，只为 app_not_found 增加一次恢复机会，提示改用搜索或 Launcher UI；不会无限续跑。名称歧义、登录 / 权限等不触发这次补充。最后一个 Tool 仍失败时保存 blocked，结束提示为未完成；原有安全规则、30 步 / 10 分钟上限和取消机制继续生效。list_apps 的本地执行摘要增加总数、匹配数、本页数与剩余分页，不保存完整 App 列表、UI tree 或截图。

新增 schema 回归先 RED（缺 query / offset / limit），修复后 36 项 JVM tests 全部通过，含 265 条完整遍历、首屏之后的直接搜索、英文 / 中文 typo、重复入口与 aliases、歧义不代选和分页参数边界。16 项完整 Android runtime tests 通过：实际 PackageManager 分页 / 模糊候选 / 搜索并打开 Settings、HTTP 驱动的失败后搜索恢复、补充次数上限与歧义停止；保留原截图、点击、输入、取消、息屏、聊天和同步检查。Lint 零 errors、Debug 构建通过。开发只用 Fixture；真实游戏入口验证独立记录。

优化后的 Release APK 0.2.2（versionCode 5）构建成功，沿用同一 development certificate 签名，APK signature / 四 ABI 16 KiB alignment 检查通过。SHA-256：784ad91e3b570999a8b6a9d4b9a7b05e981efcf548603190faac90f0e8020da9。

## 0.2.1 Modal Proxy 结束回执兼容修复

Fold6 的实际记录显示 observe / open_app / observe 均成功，随后报 Tool Calling 回执错误；App 无 ANR。使用已授权 Proxy Key 和纯合成上下文进行两次最小协议检查，确认 HTTP 200 / application/json、finish_reason=stop、非空文字回答，且 message.tool_calls 显式为 null。仅保存字段类型和数量，不输出凭证、回答正文或手机界面内容。

旧代码对 JsonNull 调用 jsonArray，新增回归先复现失败，再将显式 null 与字段省略统一作为“没有工具调用”；仍拒绝缺失调用的 tool_calls 终态、未知工具和并行操作。HTTP Fixture 与真实 Android 多步循环的最终回执都采用同样的 null 形式。结束时增加系统文字提示，让用户停留在其他 App 时也能知道任务已结束或失败。

回归过程中修复两处测试环境时序：辅助服务 teardown 等待真实解绑完成；Compose test rule 采用 v2 的 StandardTestDispatcher，避免 v1 UnconfinedTestDispatcher 在网络工作线程触发 WebView 重组。生产聊天与 renderer 未改动。依据：[Compose v2 migration](https://developer.android.com/develop/ui/compose/testing/migrate-v2)。

最终 29 项 JVM tests、14 项完整 Android runtime suite、Lint（零 errors）、R8 Release 构建及签名 / 四 ABI 的 16 KiB alignment 检查通过。APK 为 0.2.1（versionCode 4），沿用 development certificate 覆盖安装，未卸载或清除数据。

用户明确同意短暂控制 Fold6 后，用 App 内已有 Modal 连接及已启用的 AccessibilityService 实测 `Open Android Settings and stop.`。Melo 完成 observe → open_app 两次成功工具操作（均有截图），实际 Samsung Settings 前台画面停留在“连接”页面，未修改设置。任务正常显示“模型已结束任务”，总结为“已打开 Android 设置，停留在‘连接’页面，未进行其他操作。”，并在 Settings 前台出现结束 Toast；停止浮层已移除。返回 Melo 后核对保存记录，原失败记录仍保留。此结果证明该连接的最小任务和结束回执已通过，不代表复杂任务、折叠切换或省电行为全面验收。

## 0.2.0 手机助手增量

用户在已认可 AccessibilityService + Tool Calling 方案后要求立即实现。开发仍使用隔离 Fixture；不读取或注入现有 Proxy Key，不调用真实订阅。本轮手机未连接 ADB，未替用户切换 Fold6 的辅助功能权限。

- Android 16 Emulator 的完整 runtime suite：14 项通过。其中五项手机助手检查启用实际 AccessibilityService：窗口截图与像素尺寸、密码节点排除、节点点击、缩放坐标点击、中文输入、旧 observation 拒绝、App discovery / launch、本地 HTTP 根据返回 Node ID 驱动 observe → tap → observe 验证、取消在途模型请求后零设备动作、实际息屏取消且唤醒不自动恢复。
- 原有聊天、取消/重试、Activity recreation、前台服务、草稿恢复、Keystore、shared scene、现有 Node sync，以及新增凭证缺失 / 旧对话连接选择检查一起通过。
- 手机助手记录不进入 portable snapshot；实际 HTTP 检查 Tool Call ID 和 JPEG 图片回传，持久化记录排除原始 tree / 截图。Screenshot callback / Gesture callback 使用系统 API，不使用 root、ADB input 或 AutoInput 来实现 App 运行时能力。
- 修复验证中发现的观察失效问题：只由目标窗口的内容事件失效，后台窗口与停止浮层不误伤；窗口身份和尺寸仍在动作前独立检查。测试 Fixture 的 Button 禁用默认 all-caps，避免混淆显示文本与原始文本。
- 28 项 JVM tests 通过，涵盖三种原生协议的实际 HTTP Tool Call / Result + screenshot round trip、丢弃旧画面、异常工具参数 / 截断回执、在途取消与错误消息不泄露 provider body。Lint 零 errors；Debug 与 R8 Release 构建、同证书签名和四 ABI 的 16 KiB alignment 检查通过。

新增 Agent 的真实模型任务完成率、Modal Tool Calling/图片输入支持，以及 Fold6 / One UI 8.5 的权限、折叠/分屏、锁屏与省电行为仍需实机验证。既有 0.1.0 的实机安装和冷启动证据不代表新增助手已实机通过。

## 0.1.0 基线

目标：Galaxy Z Fold6 / One UI 8.5。按用户指示，本轮完成代码和本地自动验证，不连接实体手机，不调用真实模型。

## 已验证范围

- JDK 21 / Android API 36 Emulator，compileSdk 37、targetSdk 36、minSdk 28。
- 21 项 JVM tests：HTTPS / Redirect policy、Unicode / CRLF SSE、三种 completion receipt、终态 output reconciliation、取消请求、unknown-length JSON、共享 merge / deletion / conflict 行为。
- JVM tests 中包含全部 40 个既有 Node / Swift schema Fixture，以及由现有 Node portableValue 生成的 11 个 normalization golden record。日期按服务端相同的 millisecond precision 比较。
- Android runtime suite 共 7 项：Fixture 对话 / 取消 / 重试 / Activity recreation，Keystore ciphertext 与 export 隔离，后台 Foreground Service，草稿与 interrupted turn 恢复，共享 neural renderer 实际 5 connections，导入 execution evidence 后的真实 WebGL frames，现有 Node sync 服务的双向 round trip / 连续同步 / 删除确认。
- cover viewport：968 × 2376 px、420 dpi；展开 viewport：1856 × 2160 px、420 dpi。它们是 Emulator 布局检查，未模拟 Samsung firmware。
- `npm run check:android`：JVM tests、Lint、Debug APK、R8 + resource shrinking 的 Release APK。Lint 为零 errors；保留的 warnings 包括刻意 target API 36、Gradle 的版本建议、API attribute / KTX 建议和已实现 onRenderProcessGone 的静态检查误报。
- `npm run build` 语法检查通过；`node --test --test-concurrency=1 mobile-sync/*.test.js` 共 71 项通过。未把 macOS 专属桌面打包 gate 计作本机已验证。
- APK signature（安装包）、ZIP 16 KiB alignment、四个 ABI 的 AndroidX graphics.path ELF LOAD alignment 均通过。Bundled iOS scene / shared schema 按原字节打包。

交付的 Preview APK 由优化后的 Release 产物以本机 Android development certificate 签名，约 3.5 MB；它可以安装，但不是正式发行签名。另保留可复现的 unsigned Release 构建，不将 signing key 放入仓库。

## 可复现命令

```bash
cd /home/zhouy/workplace/Melo
npm run check:android
ANDROID_SERIAL=emulator-5554 npm run test:android:connected
python3 android/scripts/verify-apk.py android/app/build/outputs/apk/debug/app-debug.apk --sdk /home/zhouy/workplace/.android-sdk
node --test --test-concurrency=1 mobile-sync/*.test.js
```

Gradle 报告：`android/app/build/reports/tests/testDebugUnitTest/`、`android/app/build/reports/androidTests/connected/` 和 `android/app/build/reports/lint-results-debug.html`。
本轮独立日志与各 viewport 的 JUnit XML 在任务目录 `work/android-validation/` 和 `work/melo-android-*.log`；不包含真实 API keys 或用户聊天。

## 后续实体机验收

仍需在用户的 Fold6 上检查实际 One UI 8.5 build、cover / 展开 / 分屏切换、Samsung Keyboard、Back gesture、通知权限、锁屏 / 省电策略、系统 TTS / 语音输入和配置真实 provider 后的网络行为。本轮不将 Emulator 结果表述为 Samsung 实机通过。

Android 第一版使用 API credentials。ChatGPT OAuth、图片生成 / 编辑和桌面 tool execution 不在当前已实现能力内；文字 sync 不传输本机图片文件。
