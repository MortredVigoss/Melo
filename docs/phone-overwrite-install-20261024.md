# iPhone 原位覆盖安装 · 2026-10-24

## 结果

用户要求主线合并门禁改动后 `git push` 并覆盖安装。实体 iPhone（同机、同 bundle `com.melo.iphone.mfpiao`、同 Personal Team）从 **0.7.10 (42)** 原位覆盖到 **0.7.11 (43)**，未卸载、未清空；源码 `f91fb09`（含 Codex 今日的运行时统一 `5222034`、目标保持 `e05e65f`、意图规则共享化 `dbd3035`，以及两档回归门禁 `ccdcb04`）。桌面端同源重建并覆盖安装到 `~/Applications/Melo.app`（Melo 当时未运行），重启后服务在默认端口提供新版 bootstrap。

## 数据保留

锁屏状态下容器里受保护的文件（启动快照、`scene-health.json`）读不出来，整份备份会中途失败；解锁后重新备份：54 文件、184.6 MB，逐文件 SHA-256。安装后（首次启动前）与启动后各回读一次：

| 核对对象 | 安装前 | 安装后、首次启动前 | 启动后 |
| --- | --- | --- | --- |
| 对话 / 消息 | 16 / 163 | 16 / 163，文件一致 | 16 / 163，文件一致 |
| Agent 定义 | 6 | 6，文件一致 | 6，文件一致 |
| 图片文件 | 25 | SHA-256 全部一致 | SHA-256 全部一致 |
| 其他变化 | — | 仅 2 个系统启动快照缓存被替换 | 另有运行日志（execution-records / runtime-events）与 dyld 缓存按预期更新 |

## 验证层级

- 代码回归：合并后在主检出跑集成档 `npm test -- --base af6e89f`（门禁改动扩大为完整日常）：JS 4622 / 4622、设置浏览器验收、Swift 37 组，无隔离复测；证据 `.tmp/test-runs/run-3vQQjt/summary.json`。
- 推送：用户要求直接 `git push`（`458c3c0..f91fb09`），未运行 `git pp`。
- 构建与签名：`ios/scripts/build-personal.sh` Release 自动签名通过；`devicectl` 覆盖安装成功，安装列表回读 0.7.11 / 43；首次启动一次成功。
- 真机功能（本轮未验）：Codex 今日的智能模式 / 目标检查行为由用户在实体屏幕确认。

## 本机证据

`.tmp/phone-install-20261024/`：`before-manifest.json`、`before-summary.json`、`install.json`、`installed-after.json`、`launch.json`、`phone-after-install-preservation.json`、`phone-after-launch-preservation.json`；原始容器三份副本位置只记录在 `private-location.json`，不提交仓库。签名 IPA `ios/dist/Melo-0.7.11-personal-test.ipa`（不入 Git）。
