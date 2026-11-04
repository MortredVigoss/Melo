# Android verified action / subflow Cache — 2026-10-27

## 用户拍板与范围

用户明确“成功不是整个任务成功，比如打开汽水音乐就是成功”。这次修改把已验证部分的持久化与整项任务的终态分开；不再让后续搜索、广告、播放失败抹掉已验证的打开动作。沿用此前获批的统一 `phone_workflow` Tool + Skill Manifest，原生重放不另开设备模型 Probe。没有推送或合并旧 Android 分支。

## 执行与证据边界

```text
Chat 主循环 -> phone_use -> 原生 open_app -> 当前前台 package 已核对
                                      -> 立即事务保存 action recipe
              后续探索 -> checkpoint -> 独立核对页面事实 -> 保存 subflow recipe
              后续失败 -> 原任务 blocked；已保存部分保留

下一次 Chat 请求 -> 当前 Skill Manifest -> phone_workflow(id, revision, parameters)
                                     -> ScriptRunner + 新 observation
                                     -> 子目标回执 -> Chat 继续剩余工作
```

- `open_app` 的成功来自原生启动后取得的确切前台 package 和 observation，不能仅凭 Intent 已 dispatch 保存；该子目标不受 App 内动画影响。
- `checkpoint` 不终止原任务。它必须提供单独子目标、最近 screen_id、expected_package 和实际节点中的精确 visible_text，Host 再观察验证；只发布从已知 App 入口开始的稳定 selector 流程。输入值参数化，临时节点 ID / screen_id / 像素不入 recipe。
- 单动作 recipe 只允许一个 open_app 和 package 断言。其他页面操作须使用 subflow；不把普通手势回执自动解释成业务成功。缺少稳定 selector 的纯坐标流程仍不发布为可重放 recipe。
- 每个已验证部分立即写入本地 Room document，在下一次模型请求之前完成；Run 的 learnedScriptIds 与整项任务 cacheId / status 分开。失败、取消或重启不会自动撤回先前的可信部分。
- 主 Chat 每轮取得完整、当前、已授权且兼容的 Workflow Manifest；不按“重试”等关键词隐藏目录。共享 JS Core 提供 schema / metadata / 参数验证，Android Host 检查 scope / 权限 / revision，并执行原生 ScriptRunner。
- `phone_workflow` 的子执行模型请求为 0；主 Chat 的选择、规划以及未命中后的探索仍可能消耗模型 Token。重放重新核对当前 UI，不重用历史搜索内容或旧答案。
- 展开/折叠、窗口布局、App 版本按已有 CacheEnvironment 约束。未知环境不发布；中途姿态或版本变化不继续写入旧子流程。
- 同一任务内相同语义目标和环境只发布一次，避免随后 checkpoint 或 App 别名再次创建刚删除的条目。任务开始前已有条目的删除/编辑/停用也不会被异步发布覆盖。
- 编辑/删除继续复用操作缓存库；编辑后需原生重验证才重新进入 Manifest。完整任务的 Similar 改写不会把单动作或子流程当作整个请求的成功候选。

## 验证状态

RED：`.tmp/action-cache-red-native.log` 重现 open_app 已成功而下一次模型请求开始前 Cache 仍为空。

先后两次多 Class 参数运行的报告实际只有首个 Class，不能据命令里的名称声称全部通过。已改为逐个 Class 执行并核对 XML 中的 suite 名称；证据 `.tmp/action-cache-native-by-class/summary.json`，8 个 Class 共 69 项全部通过，包含真实 Accessibility 的 Chat -> Workflow -> 原生执行 -> Chat，以及即时保存/重启/失败/编辑/删除等回归。

随后补查到共享 Loop 的 requiredTools / toolDependencies 尚未把 Workflow 当作同一手机能力的执行器：新增两项 RED 回归，修正后 Core **222/222**。前置 Research 仍按原 plan 执行，不增加固定搜索次数/页数。JVM **170/170** 已通过。

最终快速档 `.tmp/test-runs/run-MkvxRs/summary.json`：语法 / 生成器 / 共享渲染预检、Android JVM / Lint / Debug / R8 Release 均通过；JS 4629 项中 4612 通过、2 失败、15 skip、0 cancelled。仅失败项为 `desktop-pet/tests/winter-pack.test.js:17/:38` 缺少本机私有原画素材，与本次 Cache 无关；未修改或跳过这两个断言，不能称全仓 GREEN。先前浏览器启动失败是测试环境沿用了 macOS 默认路径，改用已有 Linux Chromium 后，最终快速档不再出现这些失败。

最后 Core 修正后的 Native 回执：`.tmp/action-cache-final-native-by-class/summary.json` 逐个核对 8 个 Class、**69/69 全通过**。包含 Workflow 2、TaskCache 17、DeviceAgent 16、动态广告 4、Research 8、Search 9、ChatPhoneUse 5、Organizer 8。没有把前一轮结果冒充最后 bundle 的结果。

已导出 `Melo-0.10.3-verified-actions-debug.apk`（versionCode 27）；ZIP 中的 `assets/agent-core/agent-core.js` 与当前 dist 逐字节一致。没有推送。

## 未包含

当前 `phone_use` 仍保留设备子循环与原有受阻策略。本次不宣称所有复杂 App 操作或广告处理都已解决；不把独立 action 的成功报告成搜索、播放或 SIM 切换成功。完整统一设备单步主循环另有后续工作。Windows ADB 检查未发现 Fold6，没有真机覆盖安装或汽水播放成功证据。
