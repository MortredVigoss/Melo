# Melo Android

原生 Kotlin + Jetpack Compose 客户端；代码位于独立的 `android/` 工程。以现有 iOS 的手机使用流程、共享 scene 和 mobile-sync 协议为基线。

## 环境与构建

已验证：JDK 21、Gradle 9.6.0、AGP 9.4.1、Kotlin / Compose Compiler 2.4.21、KSP 2.3.12、Compose BOM 2026.09.00、Room 2.8.5、Lifecycle 2.11.0、Activity 1.13.0、WebKit 1.17.1、Coroutines / Serialization 1.11.0、OkHttp 5.5.0。所有版本固定，无动态版本或 preview 依赖。

`compileSdk 37`，`targetSdk 36`（Android 16），`minSdk 28`。SDK Manager 中安装 `platforms;android-37.0`、`build-tools;36.0.0` 和 `platform-tools`。设置 `ANDROID_HOME`，或用 Android Studio 打开本目录并配置 SDK。Gradle Wrapper 校验下载 SHA-256。

```bash
# 在仓库根目录运行；Android 构建本身不依赖 npm install
npm run build:android
npm run check:android
# 已连接 Android 16 Emulator 后：
npm run test:android:connected

# 或直接运行
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

`test:android:connected` 会启动隔离的本地 Node mobile-sync Fixture，通过临时 ADB reverse 供 Emulator 访问，完成后关闭服务和 port mapping；不使用真实模型或现有用户数据。直接运行 Gradle 的 connected task 时，未提供该服务的 integration test 会标记 skipped。Node golden normalization Fixture 可用 `node android/scripts/generate-portable-fixtures.mjs` 从现有协议实现重新生成。

WSL 默认 checkout：`/home/zhouy/workplace/Melo`。本机共用 SDK：`/home/zhouy/workplace/.android-sdk`，npm runner 会在没有显式 SDK 设置时识别它。新机器可以使用任何 SDK 位置。

Debug APK：`app/build/outputs/apk/debug/app-debug.apk`；安装命令 `adb install -r <apk>`。Debug 使用 Android 开发签名。Release 经 R8 和 resource shrinking 构建为 `app/build/outputs/apk/release/app-release-unsigned.apk`，需要发行方自己的签名后才能发布；仓库不保存 signing key。

```bash
python3 android/scripts/verify-apk.py android/app/build/outputs/apk/debug/app-debug.apk --sdk "$ANDROID_HOME"
```

检查 APK signature、16 KiB ZIP alignment 和每个原生库的 ELF LOAD alignment。共享 scene 和 schema 在构建时从现有 iOS / shared 目录直接复制，不改写上游 renderer。

## 使用流程

1. 「系统 → 添加模型连接」：填写完整 Endpoint、Model 和 API credential。支持 Chat Completions、Responses 和 Anthropic Messages。协议选择不会推断或修改 Endpoint，例如 Responses 需要填写 `https://api.openai.com/v1/responses`。
2. 创建对话，可绑定角色、项目和该对话使用的连接。支持多轮 Streaming、取消、失败重试、图片输入、系统语音输入、系统 TTS 和回复分享。
3. 「资料」保存项目指令、文字资料和显式记忆；「任务空间」查看真实请求状态与共享 execution scene。桌面任务可以创建接力请求，同步成功也不会被显示成“已执行”。

## Chat Phone Use（0.5.0）

在普通 Chat 直接说“查一下 Surry Hills 现在营业的餐厅”或“去小红书搜索这家店”，模型按需 invoke 内置 Phone Use，再把观察结果带回当前对话。不需要切换「操作手机」模式或进入独立助手。每 Chat 的「对话设置 → 允许调用手机」可关闭能力；普通问答不会创建设备会话。

设备任务卡片与停止按钮留在 Chat；历史图标可管理操作 Cache。使用该轮捕获的模型、角色和项目，一次只允许一个设备任务，其他 Chat 可独立问答。停止 Chat 会取消其子任务；失败 / 取消 / 需用户时不会自动续跑。research 强制实时 Probe，不复用旧查询事实；action 可复用已验证 Cache 步骤。查询成功后尝试返回所属 Chat。

本版 Phone Use 开启时采用非 Streaming Tool Calling；关闭后与本地 Fixture 沿用原 streaming chat。使用现有三种模型协议，无需安装外部 Skill / MCP / AutoInput。

完成必须调用 `finish`，声明 achieved / blocked / needs_user；achieved 要求最近 screen_id 和明确的 App / 精确页面文字，执行器重新观察后校验。它验证可见事实，不保证付款到账等不可见业务效果。模型只返回结束文字时不会自动标记完成；历史 completed 记录保留原语义。

同一窗口中其他节点更新不会阻止已重新校验的 Node 操作；目标本身、窗口、尺寸或有效期改变仍拒绝。坐标点击需在目标 App 的 Melo 悬浮按钮确认，明确的发送 / 删除 / 付款等节点也要求本步确认；确认后再次校验屏幕。此风险分类不覆盖所有自绘或未知按钮语义。随时可点击「停止 Melo」。

默认记录只包含目标、模型连接名称、关联会话和步骤摘要 / call ID / 耗时 / 错误码；不保存或同步屏幕、UI tree、输入参数和凭证。长任务按完整 Tool Call / Result 对裁剪，保留最近观察、当前搜索结果与截图；超过字符预算明确停止。

首次在「系统 → 手机控制设置与诊断」打开 Android 辅助功能设置，在已安装服务中启用「Melo 手机助手」，返回普通 Chat 发送自然语言目标即可。例如：`打开设置，搜索蓝牙，停在搜索结果页面`。诊断页仍保留独立手动执行与 Display 设置。若系统提示 App 的设置受限制，请按系统提示在该 App 的信息页面允许相应设置；App 不会自行启用辅助功能。

独立助手页使用全局模型，Chat 内使用该对话选择；模型需支持 Tool Calling，开启截图时还需支持图片输入。Chat Completions、Responses、Anthropic 均使用各自原生 Tool Call / Result 格式；每轮使用非 Streaming 请求，一次只执行一个操作。`android_device` 提供 observe、list_apps、open_app、tap、type_text、swipe、back、home、wait、finish，屏幕操作后回传新画面。模型根据实际观察选择下一步，不录制固定脚本。

2026-10-17 后续源码优化（尚未覆盖手机）：已知准确 App 名称 / 包名时优先直接 `open_app`，名称由 Android Adapter 在本机解析，打开后已带新画面；只有缺少目标或候选不足时才 `list_apps(query=...)`。查询仍覆盖完整 Launcher Catalog，但默认仅返回 10 个候选、定向查询上限 20；精确命中时只返回精确候选，重名保留多个结果，模糊匹配不自动启动。空查询或大页面需显式 `browse=true`，仅用于用户需要浏览 App 清单的任务。观察用于屏幕动作，已有动作回执的当前画面无需重复 observe；最终 finish 仍重新观察验证。此为平台 Adapter 的发现和回传优化，共享 Core 与 Search 接入仍待实现。

官方 OpenAI 的 GPT-6.1 Sol / GPT-6 Astra Tool Calling 使用 Responses API；OpenAI-compatible proxy 的 Chat Completions 是否能转换工具请求由该 proxy 决定。App 保留用户连接协议，不自动替换已填 Endpoint。依据：[官方 Function Calling 文档](https://developers.openai.com/api/docs/guides/function-calling)。

手机任务的界面文字与截图会发给当前模型服务；可在对话设置关闭 Phone Use，也可随时停止。截图仅保留在运行中的内存，不写入相册、日志、Room 或 sync；密码节点不导出，系统禁止的截图不会绕过。API 30 起支持截图，API 28/29 只提供节点观察；API 34 起优先窗口截图以排除停止浮层。可选择 Display；节点与图片坐标属于同一窗口，窗口变化后旧操作会被拒绝。back/home 是系统全局动作，只在主 Display 提供。

任务期间有悬浮「停止 Melo」，也可以回到页面停止。最多 30 次工具调用 / 10 分钟，连续三次失败停止；进程或服务中断后不会自动恢复操作。执行记录保存在本机，只记录目标、工具名、简短结果及模型结束语，不保存原始界面、截图或输入字段内容；不进入 portable export/sync。模型结束语需结合真实步骤核对，不视为任意 App 的任务成功保证。用户请求的查询摘要与最终回复属于正常 Chat 文字，参与既有文字资料同步；本机设备记录仍不导出 / 同步。

开发只用 Fixture：Debug 的「系统 → 添加本地 Fixture」会明确显示模拟回复，不访问模型服务。Release 禁用 Fixture。不会从环境变量或桌面目录读取现有账户或凭证。

生产连接要求 HTTPS，认证请求不跟随 Redirect。Credentials 仅保存在设备本地 Keystore AES-256-GCM 中，不进入 Room 文档、sync、export 或 WebView。Android backup 和 device transfer 均排除本机数据；使用显式文字资料 export/import 迁移，凭证需要重新配置。

## 数据与跨端同步

可配置现有 mobile-sync 服务的完整 HTTPS `/v1/sync` Endpoint 和至少 32 字符 Token。服务部署方式见仓库 `mobile-sync/`。Debug HTTP 仅允许 localhost、127.0.0.1 和 Android Emulator 的 10.0.2.2。

共享 schema 和 8 MiB budget 会在数据进入本机前校验。删除使用 tombstone；workspace 并发版本保留到显式处理；消息、任务与接力的身份冲突会拒绝合并并保留原数据。Credentials、图片文件和本机偏好不参与 portable snapshot。文字资料 import 是合并操作。

运行中的 user prompt 先落盘，assistant 仅在有效 completion receipt 后落盘；partial 内容单独记录。Activity recreation 不取消请求，后台请求使用带取消按钮的 Foreground Service。系统终止进程后，下次启动标记 interrupted，允许显式重试；不会自动重新发起计费请求。

## Samsung / Fold 验证边界

目标机型 Galaxy Z Fold6 / One UI 8.5。0.5.0 最终签名包已在实际 SM-F956B（Android 16 / API 36，One UI property 80500）覆盖安装；展开模式真实模型普通 Chat → Maps 当前查询 → 上下文追问 → 原 Chat 续答通过。0.4.2 曾分别验证两种模式的微信截图；这些历史结果不能替代本版 folded 实机查询。详见 [Chat Phone Use 交付](../docs/chat-phone-use-20261017.md)。

小于 600 dp 使用 bottom navigation，展开至 600 dp 以上使用 NavigationRail。无固定 orientation 或 aspect ratio；使用 system bar / IME insets，scene viewport 随窗口更新；页面、所选对话和文字草稿随 Activity recreation 保留。

自动验证与实际证据见 [verification.md](verification.md)。后续真机验收仍需覆盖 cover → 展开 → 分屏、Samsung Keyboard、权限、Back gesture、锁屏和省电策略。本版小红书、folded 查询、Samsung TTS / 语音服务、分屏 / 省电和 Fold Cache 布局隔离仍未验收；微信独立输入后置。

当前 Android 连接采用 API credentials；未移植 iOS 的 ChatGPT OAuth、图片生成/编辑和桌面 tool execution。手机图片输入使用用户选定图片；同步不传输图片文件。这里不声称与桌面或 iOS 的全部功能等价。
