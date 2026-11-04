# Android Organizer 0.10.0 真机安装（2026-10-27）

用户要求“现在安装一下我试试”，重新授权本次 Fold6 覆盖安装；本次范围为安装与启动核对，没有自动执行手机任务或真实模型请求。

- USB ADB 核对型号 SM-F956B，状态 device；检查 5037 时 Client 自动重启了旧版 Server，之后使用已识别 USB transport，没有再重启 ADB。
- 已验证上一轮测试 APK 的 SHA256：`b0a5c48b4f6bf7fc1f8063d6b3fda4e06cbfdc1b2ca1a7bb1e897b951d746e57`，源码 commit `818c09b`。
- 安装前停止 Melo，备份本机 databases / shared_prefs；执行 `adb install -r`，从 0.9.0（22）升级到 0.10.0（24），返回 Success。没有清数据或卸载。
- 安装后核对 Package Manager 的版本、Melo MainActivity 前台和进程存活；本次读取的进程日志中未发现 FATAL。原有数据库文件存在，四个偏好文件中两个字节相同，另外两个在启动后变化；不据此声称所有设置逐字节不变。
- 备份与脱敏安装回执保存于外层任务的本机忽略目录 `work/organizer-install-20261027/`，不提交私人数据库或偏好内容。

本次未测试真实汽水广告、未触发强提醒，也未把前一轮 Emulator 结果升级为 One UI 实机功能验收。已交回用户自行试用；先前已知的宠物手势/原始素材测试失败仍见 [实施回执](android-organizer-implementation-20261026.md)。未推送。
