# Android Organizer 实施与验收（2026-10-26）

基准：`7c331f3`；分支：`codex/android-organizer-20261026`。用户认可[整体设计](specs/2026-10-26-android-organizer-design.md)，曾授权 Fold6 测试，随后说明手机不在电脑旁并要求改用 Emulator；本轮不操作或覆盖安装真机。

## 已实施

- 独立 Todo / Calendar 页面，展开屏 Rail、窄屏 Drawer + 原五项底栏；编辑草稿使用 Saveable State，关闭 Drawer 不向 Accessibility 暴露重复入口。
- 共享 Core 的九项 Organizer Tool Schema、读写分类、输入校验与带请求 ID 的幂等命令；Kotlin Repository 使用独立 Room 数据库 `melo-organizer.db`，没有把个人 Todo 混入 Agent Task / Run。
- 本地日程、已授权系统 Calendar Provider（只读）和 HTTPS/webcal ICS 订阅；ICS 链接仅放本机加密凭证，原文缓存在应用私有目录。iCal4j 3.2.19 负责解析和重复展开，外部提醒默认关闭；刷新失败保留旧数据，304 也重展缓存以适配查询窗口和时区变更。
- Chat 每轮从 Core 获取 Organizer 目录，与页面共用 Repository；关闭 phone_use 不会关闭本地待办/日历工具。Goal Check 无工具，成功写入的重复调用返回原回执。
- AlarmManager、通知、最长两分钟的闹钟音频、锁屏入口与 Snooze；稳定身份/版本防止旧 Alarm 复活。系统通知/精准闹钟/全屏权限分别显示，未获得权限不冒称相应强提醒能力。
- 启动、系统时间/时区变更、重启、升级和后台 WorkManager 刷新进行 reconcile；只有实际 Receiver 到达、发布通知、响铃和用户处理才更新对应状态，保存排程本身不算提醒送达。

## 本轮验证记录

- 共用 Core：212/212 JS 回归通过。Organizer 覆盖幂等、输入/日期校验、编辑删除、外部记录只读与跨 Host Effect；额外修复不可用 Search 丢失 research 标记，以及无效 URL 仍注册 web_search 的问题。
- Native Organizer 覆盖真实 Room、Compose、Android ICS 解析、Receiver / AlarmManager / NotificationManager / FGS、Snooze、陈旧通知拒绝、重建后草稿和三轮 Chat Tool 调用；最终组合结果见下方完成回执。
- iCal4j 4.2.5 在 Android R8 发现不支持的 ZoneRulesProvider 依赖；保持 Provider 接口，改用 3.2.19，并在实际 Android Runtime 验证 TZID recurrence。启用 desugaring，关闭 ICS 库的远程时区更新。
- Fixture 调整保留原安全和调用配对断言：识别主线新增的无工具 Goal Check；点击后等待 UI 更新用独立只读 observe，不重复写操作。没有删除测试或绕过失败。
- 全仓快速档首次暴露桌面依赖/Chrome 配置和私有宠物媒体缺失；安装 package-lock 指定的生产依赖，并用 MELO_TEST_CHROME 指向已安装 Chromium 后，对全部失败文件重跑，30 项中 28 通过，剩余两项需要不在 Git 中的原始 winter 媒体与 frame audit。未伪造素材或跳过测试。
- 全部模型/网络调用使用 localhost Fixture；没有调用用户真实模型或 Search 订阅，没有读取模型密钥。Fixture 证明控制流，不代表真实模型语义质量。

### 快速档完成回执

`npm test -- --files <本任务全部实现和测试文件>`：`.tmp/test-runs/run-o4vt92/summary.json`。语法、文档链接、依赖地图/生成器、共享渲染预检、Android JVM / Lint / Debug / Release 通过。JVM 160/160；JS 4619 项，4602 pass、2 fail、15 skip、0 cancelled。两项 fail 均为 `desktop-pet/tests/winter-pack.test.js` 缺少上述原始素材；skip 为原有平台/环境约束，没有为本次改动新增跳过。快速档总体 RED，不能宣称全仓通过。

### 完整 Native 与失败边界

`.tmp/organizer-native-complete-final.log`：88 项中 87 通过，剩余 `PetOverlayFlowTest.clipsDecodeAndTouchesDriveTheOverlay` 在拖动断言失败。Organizer、动态广告、Chat / Search / Context / Research 均通过。尝试的宠物 Fixture 调整未解决问题，已全部撤回，该文件保持 HEAD 原样；未删测试或放宽断言。原始失败和实验日志均保留，后续应单独定位宠物手势问题。

### 最终当前树专项

`.tmp/organizer-current-native-focused.log`：26/26 通过（DynamicAd、Organizer、SharedSearch、Context、ResearchExecution）。这是修复后 APK 的真实 Android 16 Emulator 运行结果；没有用专项通过覆盖上述整套 Native 失败。

`.tmp/organizer-final-settings-browser.log`：设置页真实 Chromium 验收通过。`.tmp/organizer-final-swift.log`：运行器明确提示 Swift 需要 macOS，本机未执行，不能按 exit 0 称为 Swift 通过。

折叠尺寸 1080×2400 的 Todo 与展开尺寸 1856×2160 的 Calendar 已截图检查；这只是 Emulator 分辨率适配，不等于 Fold6 真实折叠硬件事件/One UI 权限验收。未进行合并/推送；本批不以快速档替代未来合并前的 integration gate。Release 完成 R8 构建不等于已进行 minified Native 测试；debug instrumentation 不能直接验证 R8 后的应用类路径。

## 真机数据保留基线

Windows ADB 已识别 Fold6、用户授权期间暂停用机。安装前完整备份本应用数据库与偏好至外层本机忽略目录 `work/organizer-fold6-20261026/`，保存脱敏计数与设置/聊天/草稿/操作缓存/加密凭证散列。基线 22 对话、64 消息、7 个 Device Script；备份不打印聊天或凭证正文。

## 明确边界

- 第一版 Organizer 仅本机；不声称和 Mac/iPhone 同步。Google / Outlook / Exchange 独立 OAuth 未接入，按用户选择通过系统已同步日历或 ICS 使用。
- 系统/ICS 只读；只有用户启用的来源由 Melo 提醒。已缓存外部范围为过去 90 天至未来 180 天，超出范围不是“没有日程”的证据。
- 本地每月重复以原日期为锚，短月落在月末，之后恢复原日；ICS 按来源 RRULE 语义，不强行改写为本地短月策略。
- 最多提前排程最近 64 个提醒，后台和到期后补位；关机、强制停止、权限阻断和省电限制不能保证送达，不绕过 DND。
- 原分支 Workflow Tool / History / Progress 修复仍未合入。此批聚焦 Organizer，不宣称旧手机操作循环问题全部解决；见[主线复核](master-loop-recheck-20261026.md)。
