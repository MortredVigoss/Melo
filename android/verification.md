# Android verification — 2026-10-17

## 0.5.0 Chat Phone Use（2026-10-17）

普通 Chat 按需调用 phone_use，结果在同一对话续答；模式切换已移除。109 JVM / 39 Android 16 runtime 全通过，无失败 / skip；Lint 零 errors、Debug / R8 Release、同证书签名和四 ABI 16 KiB alignment 通过。

最终同包安装 Fold6 / One UI 8.5 保留 7 Chat / 1 角色。unfolded 1856×2160 真实模型普通问答未启动设备；Maps 当前结果查询 Probe 9 steps / 53.543s，“第二家”上下文追问 Probe 5 steps / 31.531s，均回 Chat 独立续答。没有预订、致电、路线导航或发送消息；另留一个 QA Chat。

SHA-256 `d2328c41574e9b7c71eb5950b5a6c4eb9fd578d042048815af95f5c8d03c4a1e`，已安装包一致。产品 `954b382`；[交付与分层边界](../docs/chat-phone-use-20261017.md) / [脱敏回执](../docs/evidence/chat-phone-use-fold6-050-20261017.json)。Phone Use 开启暂非 Streaming；小红书和本版 folded 未实测，微信输入及 Fold Cache 分区待后续。未运行远端 CI / 整个 repo gate。

## 0.4.2 WeChat 启动窗口与双屏截图（2026-10-17）

0.4.1 在 unfolded 成功、folded 仍捕获 sidegesturepad 的反例推动本次修复。0.4.2 有界等待目标窗口交付，前台系统 dialog 或目标不可见时停止；不会继续让模型对替代窗口操作。

99 JVM / 34 Android 16 runtime tests 全部通过、无失败 / skip；Lint 零 errors、Debug / R8 Release、同证书签名与四 ABI 16 KiB alignment 通过。同证书安装 Fold6 / One UI 8.5，7 Chat / 1 角色及其他辅助服务保留。

同一最终 APK 的 folded 968×2376、unfolded 1856×2160 各一次强制 Probe（均 3 steps / 3 requests），captured package 均 com.tencent.mm，模型明确确认截图清晰而非黑屏；tree 均 0 节点，finish 可见证据重查通过。只读，没有重跑原微信发送任务。

APK SHA-256 `8cfc8231026b522ec628b4b6311c6ff1cadd7b7d380e44ff1660ca9b3b44f06a`，已安装包散列一致。[诊断及分层边界](../docs/wechat-window-capture-20261016.md) / [脱敏证据](../docs/evidence/wechat-window-042-20261017.json)。外部 ADB 仅验证搜索框坐标点击与 ASCII 输入，未接 Melo / 中文 IME；Fold Cache 布局隔离仍未完成。未运行远端 CI 或整个 repo 发布 gate。

## 0.4.0 Task Cache

Exact / 参数模板 Hit 在本机重新定位和校验终态，零模型；Similar 用一次受约束 plan，再本机执行；Miss 才 Probe。可验证成功后自动写入，仅本机保存；Chat 内可运行、编辑名称 / JSON、删除和强制 Probe。

当前包通过 91 JVM tests、33 Android 16 runtime tests（无失败 / skip）、cover / unfolded 各两项 UI flow、Lint（零 errors）、Debug / R8 Release 与签名 / 四 ABI 16 KiB alignment。Fold6 / One UI 8.5 已同证书覆盖：首轮 Probe 自动写回、入口变化安全回退、Exact 0 模型 1.182 秒、Similar 1 模型 7.169 秒、Miss Probe、冷启动保留、编辑待验证 / 手动运行及删除均实测；保留原聊天 / 角色和模型 Key。JSON 步骤编辑以 Emulator UI 验证。

APK SHA-256 `180949a7334378c407250899e23e699a19d45c32027f85ff23e9e513d05e3cde`。详细分层证据、真实入口失效回退、限制见 [Task Cache 验证](../docs/android-task-cache-20261016.md)；未运行远端 CI 或整个 repo 发布 gate。

## 0.3.1 Fold6 实机循环修复

真实 Fold6 的 0.3.0 已打开设置，却重复 launch 并耗尽 30 步；这次失败推翻“Fixture 已通过就等于实机完成”的推断。0.3.1 增加独立 launch 限制、already_foreground、新的并列 pane 观察 / 选择和所选窗口完成重查。

第一份 0.3.1 Preview 已覆盖安装，3 段聊天 / 1 个角色计数保留，原模型 Key 没有读取或迁移。真实模型在“打开设置”5 步、“进入 Bluetooth 页面且不切开关”10 步均通过 finish 重查；系统窗口 metadata 和任务记录分别核对。后续同 App modal 防护以最终本机 gate 验证；APK hash / 验证层级分开，见 [实机证据与边界](../docs/mobile-use-fold6-20261016.md)。

以下 0.3.0 gate 是当时 Fixture 结果，不代表后续实机或新代码验收。

## 0.3.0 Mobile Use Core 与聊天内嵌

- 当前源码通过 59 项 JVM tests、Lint（0 errors）、Debug 与优化 Release 构建；24 项 Android 16 Emulator runtime tests 全部通过，无 skip。另有 9 项工程 gate tests 与 856 个 JS 文件语法检查通过。
- 新增验收包括：显式完成 / 可见事实重查、无关动态节点可点击 / 改名目标和旧坐标拒绝、原生坐标 / 提交按钮确认、拒绝 / 取消 / 确认期间变屏零误点、双 Chat 并发和取消隔离、捕获角色 / 项目 / 模型、关联 Chat 同步删除后零设备动作、Chat 卡片时间顺序 / Activity recreation / 草稿恢复。新 Context 测试验证三种协议完整配对、保留当前搜索和截图、字符预算及游戏空 tree / 变化画面的进展判断。
- cover 968×2376、unfolded 1856×2160 / 420 dpi 的独立 UI 检查均通过，截图人工确认布局与任务 / 回复顺序；它们是 Emulator viewport，不等同实际折叠硬件或 One UI。
- Preview APK 3,794,157 bytes，证书与 0.2.3 相同；APK signature、ZIP 16 KiB alignment 和四 ABI 的 ELF LOAD alignment 通过。本轮源码、证据与边界见 [`docs/mobile-use-core-20261016.md`](../docs/mobile-use-core-20261016.md)。
- 优化签名包已在 Emulator 覆盖安装、冷启动，并保持本机测试聊天 / 角色计数；未将其表述为真实手机迁移验收。
- 仅使用本地 HTTP / 本机 Fixture，没有使用真实订阅、操作或覆盖 Fold6；真实模型任务完成率、One UI 8.5、Samsung 电池策略仍待验。远端 CI 未推送 / 执行；原 Node WSL identity 六项失败未修复，本轮不声称整个 repo 或完整发布 gate 通过。

日志 `.tmp/mobile-use-core-check.log`、`.tmp/mobile-use-core-connected.log`、`.tmp/mobile-use-layout-{cover,unfolded}.log` 与 Gradle reports；交付在本会话 outputs 的 `Melo-Android-0.3.0-*`。

## 2026-10-16 主线合并后的检查

已保存 0.2.3 修复为 `554776b`，合入 `origin/master` 的 `2e8b533`（merge `7c2fe6f`），并切换至 `codex/mobile-use-features`。README / PROGRESS 冲突保留双方说明与进度；Android 源码逐字保持，主线的 iPhone scene / sync schema 原样保留。

合并后 36 项 JVM tests、Debug APK 构建、90 项 mobile-sync tests、41 项 schema / contract tests 通过。日志为本会话 `work/melo-mobile-branch-android.log` 与 `work/melo-mobile-branch-sync.log`。本轮未运行 Android runtime / Release / 实机或真实模型，以下结果是各历史版本当时的验收范围；0.2.3 上轮已实看 Home 成功回到 Launcher，完整游戏启动复测因中断尚无结论。

## 0.2.3 让 Home 导航不被进度更新误判为过期

0.2.2 已覆盖安装到 Fold6（保留配置和记录）。用户明确同意暂时停止使用手机，由 Melo 使用现有 Modal 连接执行“搜索并打开 Hearthstone，仅停在启动画面，不进入对局”。真实记录共 9 个工具步骤：搜索已遍历 265 个可启动 App catalog（Hearthstone / 炉石 / blizzard 均无匹配），模型随后主动使用 observe → home 回退 Launcher；但 Melo 自身运行进度与记录更新改变目标窗口 generation，使每次 Home 都被 freshness guard 拒绝。模型如实报告未打开游戏；此轮未进入对局、安装 App 或更改权限 / 设置。

Home 不引用任何目标按钮或坐标，因此仅对该动作忽略内容 generation 变化；仍要求当前 session、最近 screen_id、90 秒时限、相同窗口与 bounds，并继续限制主 Display。tap / type_text / swipe / back 的内容 freshness guard 保持不变。新增实际 Android 窗口回归先 RED，复现“文字更新后 Home 被拒绝”，并同时要求过期画面的坐标点击必须拒绝；修复只针对 Home。

最终完整检查通过：36 项 JVM tests、17 项 Android runtime tests（零失败 / 跳过）、Lint（零 errors）、Debug 与 R8 Release 构建。0.2.3（versionCode 6）同证书覆盖安装成功，APK signature / 四 ABI 16 KiB alignment 检查通过；SHA-256：d61a11f808cc75c9ef39526306590708bd4e43c5b277d6d2e0e6b62c14ab2cca。

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
