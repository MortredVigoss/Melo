# Android verification — 2026-10-15

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
