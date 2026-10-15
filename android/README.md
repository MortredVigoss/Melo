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

## 手机助手（0.2.0）

首页「手机助手」，或聊天页顶部的手势图标进入。先用页面按钮打开 Android 辅助功能设置，在已安装服务中启用「Melo 手机助手」，返回后输入自然语言目标并点击「开始执行」。例如：`打开设置，搜索蓝牙，停在搜索结果页面`。若系统提示 App 的设置受限制，请按系统提示在该 App 的信息页面允许相应设置；App 不会自行启用辅助功能。

复用全局模型连接；模型需支持 Tool Calling，开启截图时还需支持图片输入。Chat Completions、Responses、Anthropic 均使用各自原生 Tool Call / Result 格式；每轮使用非 Streaming 请求，一次只执行一个操作。`android_device` 提供 observe、list_apps、open_app、tap、type_text、swipe、back、home、wait，工具执行后回传新屏幕。模型根据实际观察选择下一步，不录制固定脚本。

官方 OpenAI 的 GPT-6.1 Sol / GPT-6 Astra Tool Calling 使用 Responses API；OpenAI-compatible proxy 的 Chat Completions 是否能转换工具请求由该 proxy 决定。App 保留用户连接协议，不自动替换已填 Endpoint。依据：[官方 Function Calling 文档](https://developers.openai.com/api/docs/guides/function-calling)。

开始前页面明确告知界面文字与可选截图会发给当前模型服务。截图仅保留在运行中的内存，不写入相册、日志、Room 或 sync；密码节点不导出，系统禁止的截图不会绕过。API 30 起支持截图，API 28/29 只提供节点观察；API 34 起优先窗口截图以排除停止浮层。可选择 Display；节点与图片坐标属于同一窗口，窗口变化后旧操作会被拒绝。back/home 是系统全局动作，只在主 Display 提供。

任务期间有悬浮「停止 Melo」，也可以回到页面停止。最多 30 次工具调用 / 10 分钟，连续三次失败停止；进程或服务中断后不会自动恢复操作。执行记录保存在本机，只记录目标、工具名、简短结果及模型结束语，不保存原始界面、截图或输入字段内容；不进入 portable export/sync。模型结束语需结合真实步骤核对，不视为任意 App 的任务成功保证。

开发只用 Fixture：Debug 的「系统 → 添加本地 Fixture」会明确显示模拟回复，不访问模型服务。Release 禁用 Fixture。不会从环境变量或桌面目录读取现有账户或凭证。

生产连接要求 HTTPS，认证请求不跟随 Redirect。Credentials 仅保存在设备本地 Keystore AES-256-GCM 中，不进入 Room 文档、sync、export 或 WebView。Android backup 和 device transfer 均排除本机数据；使用显式文字资料 export/import 迁移，凭证需要重新配置。

## 数据与跨端同步

可配置现有 mobile-sync 服务的完整 HTTPS `/v1/sync` Endpoint 和至少 32 字符 Token。服务部署方式见仓库 `mobile-sync/`。Debug HTTP 仅允许 localhost、127.0.0.1 和 Android Emulator 的 10.0.2.2。

共享 schema 和 8 MiB budget 会在数据进入本机前校验。删除使用 tombstone；workspace 并发版本保留到显式处理；消息、任务与接力的身份冲突会拒绝合并并保留原数据。Credentials、图片文件和本机偏好不参与 portable snapshot。文字资料 import 是合并操作。

运行中的 user prompt 先落盘，assistant 仅在有效 completion receipt 后落盘；partial 内容单独记录。Activity recreation 不取消请求，后台请求使用带取消按钮的 Foreground Service。系统终止进程后，下次启动标记 interrupted，允许显式重试；不会自动重新发起计费请求。

## Samsung / Fold 验证边界

目标机型：Galaxy Z Fold6，One UI 8.5。0.1.0 已在实际 SM-F956B（Android 16 / API 36，One UI property 80500）安装并冷启动；0.2.0 开发时手机未连接，新增 AccessibilityService 操作仍需实机验收。Android 16 Emulator 验证不能代替 Samsung firmware 验收。

小于 600 dp 使用 bottom navigation，展开至 600 dp 以上使用 NavigationRail。无固定 orientation 或 aspect ratio；使用 system bar / IME insets，scene viewport 随窗口更新；页面、所选对话和文字草稿随 Activity recreation 保留。

自动验证与实际证据见 [verification.md](verification.md)。后续真机验收仍需覆盖 cover → 展开 → 分屏、Samsung Keyboard、权限、Back gesture、锁屏和省电策略。暂未做真实 provider、Samsung TTS / 语音服务或手机 firmware 验证。

当前 Android 连接采用 API credentials；未移植 iOS 的 ChatGPT OAuth、图片生成/编辑和桌面 tool execution。手机图片输入使用用户选定图片；同步不传输图片文件。这里不声称与桌面或 iOS 的全部功能等价。
