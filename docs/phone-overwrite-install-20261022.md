# iPhone 原位覆盖安装 · 2026-10-22

## 结果

用户要求主线等桌宠线程收尾后合并、推送，再给手机覆盖安装。实体 iPhone（同一台、同 bundle `com.melo.iphone.mfpiao`、同 Personal Team 与钥匙串访问组）从 **0.7.8 (40)** 原位覆盖到 **0.7.9 (41)**，未卸载、未清空；源码 `cd134bf`（含桌面与手机对齐 `1b01739`、桌宠并入 `c7ccbd7`、安卓桌宠合入 `8ec684b`）。签名有效至 2026-10-28。

## 数据保留

安装前把整个 App 数据容器复制到用户 Library 下私有 `MeloDeviceBackups` 目录（仅用户可读）并建立逐文件 SHA-256 清单：52 文件、180.6 MB。安装后（首次启动前）与启动后各回读一次：

| 核对对象 | 安装前 | 安装后、首次启动前 | 启动后 |
| --- | --- | --- | --- |
| 对话 / 消息 | 15 / 151 | 15 / 151，文件一致 | 15 / 151，文件一致 |
| Agent 定义 | 6 | 6，文件一致 | 6，文件一致 |
| 图片文件 | 24 | SHA-256 全部一致 | SHA-256 全部一致 |
| 其他变化 | — | 仅 2 个系统启动快照缓存被替换 | 另有运行日志（execution-records / runtime-events）与 dyld 缓存按预期更新 |

没有把启动快照缓存和运行日志的正常变化称为数据丢失，也不声称整个容器逐字节不变。

## 验证层级

- 代码回归：合并后的主线完整日常 `npm test`（扩大范围）GREEN——JS 4516 / 4516、两组设置浏览器验收、Swift 37 组；Android 阶段本机无 Java，由 CI 覆盖。
- 推送门禁：Codex 无额度，按用户指示改由子代理依 `EVALUATION.md` 评估 `fc68a9f..cd134bf`：质量评级 B、风险中（建议集中在安卓悬浮服务失败路径与桌宠 helper 熔断，记入桌宠线程下一阶段），按 S/A/B 规则直接 `git push`，未运行 `git pp`。
- 构建与签名：`ios/scripts/build-personal.sh` Release 自动签名构建通过，`codesign --verify --deep --strict` 通过，Scene 资源与源码一致。
- 安装与启动：`devicectl` 覆盖安装成功，安装列表回读 0.7.9 / 41；首次启动一次成功。
- 真机功能（本轮未验）：桌面与手机对齐的新行为（Agent 页「这台手机上」定位开关、朗读模式）由用户在实体屏幕确认。

## 本机证据

`.tmp/ui-phone-install-20261022/`：`before-manifest.json`、`before-summary.json`、`install.json`、`installed-after.json`、`launch.json`、`phone-after-install-preservation.json`、`phone-after-launch-preservation.json`、`compare.cjs`；原始容器三份副本的位置只记录在 `private-location.json`，不提交仓库。签名 IPA `ios/dist/Melo-0.7.9-personal-test.ipa`（不入 Git）。
