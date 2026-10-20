# Android Task Cache — 2026-10-16

用户已确认 Exact / parameter template Hit 零 LLM、Similar Hit 自动改写、Miss Probe、成功自动缓存和编辑 / 删除；设计见 [已认可规格](specs/2026-10-16-android-device-scripts-design.md)。分支 `codex/mobile-use-features`，Android 0.4.0（versionCode 9）。

## 使用与运行边界

`Chat → 操作手机 → 目标 → Cache lookup → Exact / template replay | Similar plan → replay | Probe → verified Cache`

- “操作缓存”可手动运行、修改名称 / JSON 步骤 / 参数 / 完成断言、删除或停用；编辑后待验证，手动运行通过终态校验才重新参与自动命中。“强制 Probe”绕过查找。
- Exact / template Hit 不创建模型客户端、不读取 Key、关闭 JPEG，只调用 Native Executor；即使删除全部模型连接也能命中。Similar 在已有目标 / selector 上做一次 text-only plan，不能发明 package、节点或减弱完成断言；校验失败才 Probe。
- 每步重新 observe，唯一匹配稳定 selector，使用本次 screen / node ID。纯坐标、无稳定目标、歧义或未验证成功的任务不生成可运行 Cache。
- 页面变化后停止。仅没有潜在点击 / 输入效果时可从当前页面转 Probe；已执行或结果不明的点击 / 输入不会自动重放。每次成功必须重新观察完成断言。
- Cache 只进入本机 Room document，不进入 mobile-sync / Snapshot。保存脚本与成功 receipt 同一事务；并发编辑、删除、取消不复活旧条目。原始输入值只用于本次绑定，不自动写入脚本；任务目标与既有 DeviceRun 记录规则保持一致。
- Exact key 只裁剪外侧空白，保留大小写 / Unicode / 内部空白；Similar 的本机检索可归一化。最多 3 个 Similar 候选 / 100 个条目，有限步骤与等待，无任意代码或循环。旧版本 Run 摘要不含原始目标参数，不能转换成脚本。

## 本机验证

- 91 JVM tests：参数 / 单次替换 / 大小写隔离、验证器、临时 ID 不入缓存、新鲜节点、歧义、失败不重放、取消、Similar grounding 等。
- 33 Android 16 Emulator runtime tests，零失败 / skip。新增 Cache flow 验证 Probe 写回 → 重新加载 Repository → 无模型连接 Exact Hit（请求仍为零）、Similar 一次 plan、执行后失败不重复点击、并发编辑不信任旧 revision、删除运行脚本先取消，以及真实 UI JSON 步骤编辑 / 删除。
- Android ICU 与 JVM Regex 存在差异：最初 Native 测试发现未转义 `}}` 导致初始化异常；修复并增加 Android 原生回归，未用 JVM 通过替代 Native 验收。
- 额外 cover 968×2376 与 unfolded 1856×2160 / 420 dpi UI 检查各两项：Chat 时间线 / recreation / 草稿，以及 Cache JSON 编辑 / 删除。截图人工检查；这是 Emulator viewport，不等同完整 Samsung 硬件场景。
- Lint 零 errors，Debug 与 R8 Release 成功；同证书签名、ZIP 16 KiB 与四 ABI ELF LOAD alignment 通过。
- 日志：`.tmp/task-cache-{check,connected,package,layouts}.log`，以及 `task-cache-{chat,library}-layout-{cover,unfolded}.log`。产物为本会话 `outputs/Melo-Android-0.4.0-*`。

## Fold6 真实验证

同证书覆盖安装到 Samsung Fold6 SM-F956B / API 36 / One UI property `80500`，5 段 Chat / 1 个角色计数保留；未读取或更换 Keystore Key、未清除资料，其他 Accessibility Services 保留。测试使用独立 `TaskCacheFold6QA` Chat 与已有用户授权 Modal 连接，仅观察 / 打开 Settings，不切换系统选项。

- 首次 Probe：8 次模型请求 / 8 个步骤 / 46.577 秒，终态验证后自动缓存。
- 入口变化：首次脚本包含从旧 Bluetooth 子页返回的路径；再次启动已在 Settings 首页时，旧前置页面不匹配。Runner 未继续执行 Back，在仅 open_app 后安全转 Probe，2 次请求 / 15.716 秒重新验证并更新脚本。此轮不能称零模型 Cache Hit；原失败预期与实际结果保留。
- 更新后的相同目标：Cache Hit，0 次模型请求 / 2 个步骤 / 1.182 秒，终态验证成功。
- 相似目标增加 “Please / the”：Similar Hit，1 次模型请求 / 2 个步骤 / 7.169 秒，改写执行并写回新 Cache。
- 全新等待目标：Miss → Probe，2 次请求 / 10.542 秒，成功自动缓存。
- 冷启动后 3 个 Cache 条目保留；相同目标再次 Cache Hit，0 次请求 / 1.284 秒。
- 在真实手机 UI 改名后变为待验证；手动运行编辑版本 0 次请求 / 1.192 秒成功，再删除该 QA 条目。JSON 步骤修改 / 校验 / 删除以 Emulator Native UI 验证，不虚称实机已改动作。

上述秒数来自本机 DeviceRun receipt，仅代表这些任务。脱敏回执随仓库保存：[Fold6 Task Cache evidence](evidence/android-task-cache-fold6-20261016.json)；原始 QA 记录位于本会话 `work/fold6-040-validation`。测试过程不在 Agent 运行时调用默认 UiAutomation，以免禁用被测 AccessibilityService；Windows ADB 使用独立 5039 端口避免与 WSL Server 版本冲突。

## 交付与限制

APK 3,892,461 bytes；SHA-256 `180949a7334378c407250899e23e699a19d45c32027f85ff23e9e513d05e3cde`；与 0.2.3 使用相同 development certificate。未自动推送、运行 git pp 或远端 CI；Node WSL identity 基线问题未纳入本轮 Android gate。

Similar 是有限候选检索，不保证任意语义改写命中；计划不可靠时仍使用 Probe。游戏的纯画面坐标操作与复杂条件分支不在第一版 Cache 范围；One UI 锁屏 / 省电 / 折叠切换全场景仍须单列验收。
