# Fold6：已打开设置却反复执行的实机修复

## 失败与原因边界

用户授权直接使用已连接的 Samsung Fold6 和原有 Modal 模型连接测试。SM-F956B，Android 16 / API 36，One UI 系统属性 80500；0.3.0 同证书覆盖安装，安装前后原有 2 段聊天 / 1 个角色计数保留，随后新增独立测试 Chat。

0.3.0 的 OPEN_RETRY 已在手机显示设置，却反复 open_app，最后 30 步上限变为 blocked。这说明本次完成判断失败，不能把已打开 App 或 Fixture 通过当作任务完成。

- 进展检测包含 JPEG hash，页面动画变化可以逃过旧的重复状态判断；缺少独立于画面的同目标 launch 限制。
- Fold6 展开设置存在两个可见窗口：左“设置”、右“连接”；旧工具只观察 active 右侧窗口，遗漏同屏左侧信息。这是已确认的观察缺口，不能声称已经读到模型内部判断的完整因果。
- 第一次 3 步试跑被取消与测试器接入默认 UiAutomation 有关；不将它计入模型完成能力结论。默认 UiAutomation 会抑制其他 AccessibilityService，后续只在任务停止后读取 UI。参考 [Android UiAutomation 文档](https://developer.android.com/reference/android/app/UiAutomation)。

## 0.3.1 修复

同一目标无有效导航连续请求两次后，第三次在 host 拦截，和截图变化、screen_id、夹杂 observe 无关。第二次在目标已经前台时返回 fresh observation / already_foreground，不再重启。它只限制重复操作，不自动把复杂目标标为成功。

观察返回窗口 title、选中窗口的截图范围、同 App 的其他可见并列窗口。observe(window_id) 可以选另一侧，finish 重新校验相同窗口；所有临时 Node / screen ID 和坐标仍按本次 observation 使用。

只使用公开 Window API，不读取隐藏 taskId。另一窗口须同 App、同 Display、仍可见且与 active 窗口基本不重叠；同 App 的覆盖式 modal 继续使旧窗口失效，不能把它当作并列 pane 来绕过 freshness guard。

## 实机结果

已安装的第一份 0.3.1 Preview SHA-256 为 `fc294578d3e86f50f7678ff6365c4941fe9747217679c36386ace8f1aec93915`，使用原本在手机 Keystore 的模型连接；未读取或迁移 Key。

- 覆盖安装前后保留 3 段聊天 / 1 个角色（含上一轮创建的测试 Chat）。安装后发现原先 Melo 辅助服务关闭，恢复原有服务启用项，保留其他辅助服务。
- `FOLD6_031_OPEN`：5 步，observe → list_apps（266 个当前 Profile App，匹配 1）→ open_app → observe → finish。任务卡为“已验证可见结果”，finish 重新检查成功；Activity 重建后可回看记录。
- `FOLD6_031_BLUETOOTH`：10 步，进入 Bluetooth 页面，系统窗口 metadata 显示“蓝牙”与“设置”；最终 finish 重查成功，任务卡为“已验证可见结果”。目标明确禁止切换 Bluetooth 或改动选项。
- 没有测试购买、发送消息、游戏对局或修改系统开关；这两次结果不能外推任意 App 的完成率。

后续增加了“同 App modal 不可作为 sibling pane”的防护和回归；该变更以最终 JVM / Emulator gate 验证，以上两次实机属于该防护加入前的 0.3.1 签名包，不混同 APK hash。

最终源码 67 JVM tests、25 Android 16 Emulator runtime tests（零失败 / skip）、Lint 0 errors、Debug / R8 Release 通过；signature / ZIP 与四 ABI ELF alignment 通过。最终 Preview SHA-256 为 `9bf43f7ed8ecad30b404b77b1d1c8fe44ecc25592f5282536cabd637538918d0`，不是上面的实机首份包。

## 证据与后续

本会话 Windows work/fold6-030-validation 和 work/fold6-031-validation 保存脱敏目标、状态和安装计数；原始设置画面只留本机 work，不发布到 repo。当前 gate 日志为 WSL `.tmp/mobile-use-031-final-check.log`、`.tmp/mobile-use-031-connected.log`，签名与 alignment 记录随最终 Preview metadata。

用户进一步确认 Task Cache：Exact Hit 零模型请求，Similar Hit 可精简改写，Miss Probe，成功自动缓存并支持编辑 / 删除。设计见 [Task Cache 规格](specs/2026-10-16-android-device-scripts-design.md)；与本次 0.3.1 循环修复分开提交。
