# 测试成本与手机相机方案 · 2026-10-21

## 当前实施范围

### 应用内拍照的实现与证据

| 平台 | 实际入口与数据流 | 已验证 | 待验收 |
| --- | --- | --- | --- |
| iPhone | `ImageComposerBar` 拍照按钮 → `CameraCaptureView` → 系统内嵌静态拍照/重拍/确认 → `ChatStore.importCameraPhoto` → `ImageLibrary.storeCameraPhoto` → 追加当前草稿；原有发送链处理图片 | 图片存储、旋转、传输缩小和冷加载回归；unsigned Simulator App 编译；隔离模拟器实点权限拒绝、取消返回、相册选图和原草稿保留 | 10-21 已覆盖 0.7.8（40），用户确认后置拍照/重拍/确认/取消四流程，原图与数据保留；详见[装机回执](phone-camera-install-20261021.md)。前后镜头切换、画质和后台恢复另验 |
| Android | 对话“添加图片”菜单 → 拍照 → `CameraCaptureDialog`/CameraX → `PhotoCaptureDraft` → `Repository.importCameraPhoto` → 追加当前草稿；原有模型图片请求使用传输副本 | JVM 文件所有权回归；隔离 Android 16 模拟相机真实跑两条界面测试：拍照/重拍/确认入库/原件保留、取消清理；0 失败/0 忽略；127 条 JVM、Debug/Release/R8、Lint 与测试 APK 编译 | 实体 Android 镜头/厂商系统后台恢复 |

行为边界：确认前不入库、不发送；只申请相机权限。iPhone 原生控制器负责前后镜头和确认，`request.id + chatID` 拦截取消/切换后的回调；Android 的临时文件状态机拒绝重复确认和过期回调，退出时解绑 CameraX。Android 的模拟器 CI 明确使用 emulated 前后镜头，不读取主机摄像头。

存储规则：保存本次采集交给 App 的完整分辨率 JPEG（不是传感器 RAW）。原有图片和索引不迁移；预览和模型请求按既有尺寸预算创建副本，旋转在副本上纠正。iPhone 原件上限 64 MB、单次图片传输合计 40 MB；Android 原件上限 64 MB、请求副本 2048 px/4 MB；两端原有请求约束保留。取消与重拍的 Android 临时文件清理；确认后由导入方接管。

本机证据：`.tmp/test-cost-camera-20261021/camera-swift.log`、`camera-ios-build.log`、`camera-android.log`、`camera-android-flow.log`、`camera-test-runner.log`、`ios-camera-{denied,fallback,draft}.png`。Android 测试源码为 `CameraCaptureFlowTest.kt` 和 `PhotoCaptureDraftTest.kt`；iPhone 图片回归在 `ImageWorkflowTests.swift`。模拟器分别为本轮新建的 `Melo-Camera-QA-20261021` 与 `melo_camera_qa_20261021`，无账号、无模型调用；不把模拟器记录称为真机完成。

最终组合回归：显式相机任务文件触及原生权限、依赖和图片存储，计划保守扩大为全部 504 个 JS 文件；JS 阶段 4421/4421、37 Swift、两组浏览器、Android 127 JVM/Lint/Debug/Release/R8 均通过，9 个阶段退出码均为 0，合计 1061.1 秒。相机依赖的冷构建及共享 Swift 图片输入变化触发重编译，不能与先前热校准的 209.6 秒直接计算提速。报告 `.tmp/test-runs/run-s8QN1n/report.json`；汇总 `camera-daily.log`。最终 24 个任务文件重新生成计划仍选中同一完整范围；期间补的 CI 模拟镜头参数另经 YAML 解析和 CI 专项 3/3 验证，文档单独查链接。

API 依据：[Apple 原始照片回调](https://developer.apple.com/documentation/uikit/uiimagepickercontroller/infokey/originalimage)、[CameraX 架构](https://developer.android.com/media/camera/camerax/architecture)、[CameraX 稳定版](https://developer.android.com/jetpack/androidx/releases/camera)。本次使用 CameraX 1.6.2；用户明确暂缓实时会话，因此 iPhone 采用系统拍照控制器，不提前建设实时视频服务。

测试降本已完成本地实现与校准：工具专项 25/25；完整日常 209.6 秒（JS 阶段 4421/4421、37 Swift、两组浏览器和 Android 检查）。Android 追加日常执行确认 JVM 测试每次运行、编译复用。代表 UI 的 JS 文件数 103→26、98→40、80→22，未删除测试。三份工作流 YAML 解析通过；重放真实文档提交得全部重型 job=false，4 份文档/109 链接通过。详细日志 `.tmp/test-cost-camera-20261021/`，完整阶段日志 `.tmp/test-runs/run-CcaWzh/`。本机缺 Java 环境变量的首次校准已失败停止，补用已有 JDK/SDK 后通过；该校准不证明 GitHub 的实际运行时间；10-21 后续按用户指令推送，远端已回读确认，CI 结果另核。

- 先完成本地选组、CI 选组、编译缓存和日志降本。保留全部测试及核心/未知边界的完整校准；不缓存测试通过结果。
- 随后实施应用内单张拍照。iPhone 使用系统应用内拍照控制器，复用系统前后镜头、重拍与确认；Android 使用 CameraX 原生预览与拍照。实时语音、连续画面解答及相关服务接入暂缓。
- 仅用户打开相机时申请相机权限，不附带申请麦克风；确认照片进入当前草稿，手动发送才提交给模型。取消、权限拒绝、切换聊天和延迟回调需要覆盖。
- 不覆盖原账号、历史图片或聊天，不自行安装或推送。

用户澄清：架构优化的实际目标是降低测试成本，同时希望手机可直接拍照。初始方案基线为 `2ee8da7`。随后用户授权先完成测试降本，再实施双端应用内拍照；实时语音、连续画面解答暂缓。后续用户授权推送并将手机安装留到晚上：`8304aab`、`6fba8db` 已在 `origin/master`；墨尔本 10-21 20:00 单次跟进设备状态，备份后已完成原位覆盖与用户真机确认，见[装机回执](phone-camera-install-20261021.md)。

## 1. 测试成本：初始基线与实施选择

以下基线来自实施前 `2ee8da7` 的计划预览，数量为测试文件而非测试用例；实施后的结果见顶部。基线已有按影响范围选择、阶段去重、Swift 编译缓存，本轮在其上收窄误选并让 CI 复用计划。

| 修改文件样例 | 实施前计划 |
| --- | --- |
| README.md | 只查文档链接，0 JS |
| Customize view.js | 103 个 JS 文件 |
| chat/controller.js | 98 个 JS 文件 |
| chat/chat.css | 80 个 JS 文件 |
| iOS ImageViews.swift / ChatStore.swift | 1 个 JS 预检 + 全部 Swift；这两个文件未纳入独立编译组 |
| Android MainActivity.kt | 2 个 JS + JVM / Lint / Debug / Release |

独立证据：`.tmp/test-cost-camera-plan-20261021/selection-samples.json`。GitHub 对纯文档提交 `2ee8da7` 实际启动了 Cross-platform verification（run 39547394182）和 File safety（run 39547394208）；工作流定义无文档过滤，后者含 Linux/macOS 两个 job。此处只说明触发成本，不宣称所有 CI 已完成或通过。

### T1 优先：CI 与本地使用同一份影响计划

- 增加始终运行的轻量 plan / 汇总检查，在昂贵的依赖安装之前决定所需 job。纯说明文档仅跑链接；源码、共享规则、权限、存储、测试基础设施按实际风险选组。
- 采用现有严格文档白名单，不能把所有 Markdown 都忽略：人设、技能和运行时资料仍可能参与行为。
- 处理 PR merge-base、push before-SHA、新增 / 删除 / 改名与失效地图；未知依赖继续扩大。避免仅用 paths-ignore 使必需检查一直等待。
- 核心或发布仍跑完整集成；取消同一分支旧提交的重复运行，补足尚无该策略的工作流。保留跨系统文件安全覆盖，不把两个操作系统当作重复测试删除。

### T2：按依赖收窄日常检查（已实施范围）

- UI 改动保留所属功能的整组 UI 测试，后端测试按反向依赖、源码读取、安全与桥接边补选；后端改动仍保留整功能组。更细的聊天展示/附件/流式职责拆分暂不增加，避免仅为选组制造新的维护成本。
- 相机图片保存、方向和副本回归加入既有 `ImageWorkflowTests`；UIKit 外壳单独做 iOS App 编译和模拟器交互。未纳入独立编译输入的 Swift UI 仍保守执行全部套件，未用纯 Swift 通过代替 App 编译。
- Android 的局部反馈使用相关 JVM / Lint / 增量 Debug 编译，Release/R8 在涉及构建、依赖、混淆、共享边界和集成发布时执行；此规则已在 `test-plan.js` / `android.mjs` 实施，JVM 每次执行，编译可复用。
- 拆分以减少不必要的依赖传播为目标，不单按行数。阶段测试不能删、失败不能跳过、断言不能弱化。

### T3：耗时可见、构建复用、输出简洁

- 每阶段 / 套件输出结构化耗时、选中原因、工具链和缓存命中；成功日志落本地文件，面向开发者只给摘要，失败保留完整日志入口，减少等待和反复阅读输出的成本。
- 复用已有 Swift 编译缓存，并补齐适用的 CI 构建 / 依赖缓存；缓存键覆盖源码、依赖、生成物、SDK 与工具链。测试成功结果暂不缓存，选中的断言仍执行。
- 只在各自隔离 home、端口和临时目录后并行独立组；先测机器资源，避免 CPU / 内存争用反而变慢。
- 验收记录同一组代表性改动的选组数、冷/热耗时、是否触发无关平台。没有改前后实测，不承诺固定百分比提速。门禁本身修改需要专项测试和一次完整日常校准。

## 2. 实施前的相机与图片能力（基线记录）

- iOS `ImageViews.swift:65` 是 PhotosPicker，只选相册；未找到视频相机捕获实现，Info.plist 也没有 NSCameraUsageDescription。
- Android `MainActivity.kt:192` 是 PickMultipleVisualMedia；manifest 没有 CAMERA 权限，未实现应用内相机。
- iOS 已有 `ChatStore.importImage → ImageLibrary → ImageReference → 图片请求`；Android 已有 `repository.importImage` 与图片消息链。语音输入和朗读也存在，但尚无实时双向会话适配。
- iOS 当前导入保留的是最长边不超过 4096 px 的副本，不能宣称现有导入会保留相机原始字节；新拍照若要保留原片，应独立保存采集文件并派生发送副本，不覆盖旧照片或更改已有账号、数据。

## 3. 三级体验与实施边界

| 阶段 | 用户体验 | 模型连接要求 | 相对工作量 |
| --- | --- | --- | --- |
| C1 原生拍照 | 对话里点拍照，前/后摄预览，拍摄、重拍、确认后进入草稿，再发送 | 复用当前已支持图像输入的连接 | 小 |
| C2 看画面问答 | 相机保持预览；说完一句话或点“问当前画面”，取当前帧 + 问题，流式回答并朗读 | 视觉模型 + 已有语音识别 / TTS；延迟取决于连接 | 中 |
| C3 实时视觉语音会话 | 持续语音、按需更新画面、可打断回复、保持对话上下文 | 新增低延迟实时语音与图像会话适配，实际验证授权和协议 | 大 |

C2 是逐轮看图问答；C3 才追求更接近用户所说的“豆包式边看边聊”。不能据此推断豆包内部实现，也不承诺所有当前模型都有同样的实时能力。

### C1 实施选择（用户明确只做拍照后收窄）

- iPhone 以独立 `CameraCaptureView` 嵌入系统静态拍照控制器，AVFoundation 只负责按需权限；不提前建设帧输出服务，也不把相机生命周期塞进 ChatStore。Android 用 CameraX 的 Preview + ImageCapture，保持拍照 / 确认 / 草稿交互。
- 系统/CameraX 管理采集；预览和请求副本受尺寸预算约束。确认后接既有附件导入，切聊天、退出和迟到回调按会话标识隔离。
- 用户点相机时申请相机权限，拒绝后仍可选相册；拍照不附带申请麦克风，语音会话启动时再申请。打开预览不发送图像，拍照确认进入草稿，由发送动作提交给模型。
- 取消 / 重拍清理本次临时文件；明确确认照片的持久保存及删除规则。原图与上传压缩副本分开，已有图像不被重编码覆盖。

### C2 / C3 的后续设想（用户暂缓，未实施）

- 独立 `LiveVisionSession` 管理 idle / starting / listening / responding / interrupted / ended，绑定 chatID / sessionID；本地采集、会话控制和供应商协议三层分开。
- C2 默认用户每次提问抓取一张当前图；C3 使用有上限的变化采样，前一次发送未完成时保留最新帧、丢弃过时帧，绝不每帧启动完整 Agent loop。帧带采集时间，防止旧画面当成当前现场。
- 预览保持流畅与模型采样频率分别控制；实时帧用有界内存缓存，只保存用户明确保留的照片和对话需要的关键帧，不持续把所有预览帧写进图片库。
- 退出、退后台、锁屏或中断时停止摄像头/麦克风与待发送帧；重连不自动重复播放旧回复。只在用户启动的可见会话内采集和发送。
- 建立独立的整场时长/流量/费用预算与单轮截止；支持暂停画面、静音、打断、结束，显示连接和采集状态。复用现有能力和工具审批边界。
- Realtime 可用 WebRTC 承载音频、数据通道提交图像；不能把官方 image input 当作接受任意视频流。现有 Codex OAuth `/responses` 路径没有实时适配和授权证明，不假设其可直接获得 Realtime。优先保留 C1/C2 的兼容连接；C3 需另行核实提供方、API 授权与计费。平台统一提供方密钥由服务端换短期凭证；用户自带密钥沿用本机安全存储，不能硬编码到应用中。

## 4. 验证与成本控制

- 权限 / 生命周期 / 采样 / 图像方向 / 限流 / 迟到事件用模拟相机、固定帧和假时钟测；网络适配用记录的协议事件，不在日常测试调用付费模型。
- 少量真机验收覆盖前后摄、重拍、拒绝权限、切后台、切聊天、通话中断、真实图片回复；实时阶段再验证蓝牙/扬声器、回声、打断、断网恢复和长会话发热。
- iOS 模拟器无法证明真实相机可用；签名、安装、前后数据核对与实体相机实测单列。
- 当前已按用户指令采用 T1/T2/T3 → C1；C2/C3 暂缓，后续另行决定。

## 5. 官方依据（2026-10-21 查阅）

- Apple [AVCam](https://developer.apple.com/documentation/avfoundation/avcam-building-a-camera-app)：AVFoundation 拍照/预览与相机生命周期；具体实现以本项目最低系统版本为准，不直接搬最新示例的高版本要求。
- Android [CameraX architecture](https://developer.android.com/media/camera/camerax/architecture)：Preview、ImageCapture、ImageAnalysis 与生命周期绑定。
- OpenAI [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)：实时语音、单独图像输入、VAD 与中断；[WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime)：连接与短期凭证机制。

最初调研只做 dry-run 选组、源码/工作流核对；用户授权后的实现和验证以顶部“应用内拍照的实现与证据”为准。未调用真实模型或访问用户账号。
