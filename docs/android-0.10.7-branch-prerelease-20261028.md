# Android 0.10.7 Branch Pre-release — 2026-10-28

用户问为什么不直接 Release、能否针对当前 Branch 单独发布；这构成本轮 Branch 试用分发授权，取代此前仅保留本地的限制。不合并主线，不运行 git pp / 自动 Review，不上传私人 Trace。

## 来源与下载

- Branch：`codex/android-organizer-20261026`，本轮推送该 Branch 的源代码。
- Tag：`android-v0.10.7-organizer-preview.1`；annotated Tag 的 peeled Commit 为 `fd3bd0d14113595dc8dbb06b27fdbdc114a5c161`。Release Target metadata 也指向该 Branch。
- [Pre-release 页面](https://github.com/MortredVigoss/Melo/releases/tag/android-v0.10.7-organizer-preview.1)。`isDraft=false`、`isPrerelease=true`，创建和发布均使用 `latest=false`。
- [APK 直接下载](https://github.com/MortredVigoss/Melo/releases/download/android-v0.10.7-organizer-preview.1/Melo-0.10.7-unified-loop-debug.apk)：227355895 bytes，versionName `0.10.7` / versionCode `31`。
- [SHA256SUMS](https://github.com/MortredVigoss/Melo/releases/download/android-v0.10.7-organizer-preview.1/SHA256SUMS.txt)。APK SHA256：`ac2490028265132569827ffe514c94d6ec81c8dff717fd226896b096877d3bf8`。
- 本地与 GitHub asset API 的 digest / size / uploaded state 一致；两附件匿名 HTTP HEAD 均返回 200 和正确 Content-Length，校验文件匿名 GET 与本机原文一致。无须电脑保持开机。
- 已验证 APK 签名有效，且与此前 0.10.6 试用包的证书 SHA256 相同，可以覆盖安装；没有重新制作或替换已验收 APK。

## 发布前检查的实际边界

- 先 `test:plan -- --base fddf833`，再同基准集成档：`.tmp/test-runs/run-dkvzlN/summary.json`，全部552个JS文件；4653项 / 4636通过 / 2失败 / 15跳过 / 0取消。失败仍仅私有冬季桌宠素材两项，无隔离重试。Android JVM / Lint / Debug / Release 和前置检查通过。
- 实际执行完整 `npm run test:full`，退出码1；本机证据 `.tmp/android-release-0.10.7-20261028/full-release-gate.log` 和提取的 `full-summary.json`。自动发现Regression 4659项 / 4642通过 / 2素材失败 / 15跳过 / 0取消，数字不与集成档累加。
- 完整 Gate 中 Settings Browser、iOS Renderer / Bridge、Android JVM / Lint / Debug / Release、语法、Desktop Smoke、Runtime Browser、Bootstrap 契约通过。Bridge 4项；Swift / JavaScriptCore 明确因 Linux 跳过。
- 红色还包括桌宠素材 store 验证和依赖macOS的Desktop构建、Lifecycle、安装、两种启动路径。当前环境缺macOS / zsh / open，不伪造通过、不削弱或跳过断言；不称全平台可发布。因此发布类型为 Android 实验性 Pre-release。
- 原有 Android Core240 / JVM190 / Native50，最终 APK Chat6 的验收和真实模型五样本见[单Loop验收](android-unified-loop-20261028.md)；未新增模型请求，未操作 Fold6。One UI实机仍待验收。

## 附件与本地数据

仅上传APK与SHA256SUMS。私人手机快照、数据库、模型凭证、原始Trace和完整测试日志没有作为发布附件，也没有进入Git。原始Trace仍留本机，现有脱敏分析文档与Trace实现源码属于Branch代码。

Release已用gh CLI创建（现有GitHub Connector不提供Release附件上传接口）；先Draft上传核对，再更新完整检查结果并发布。后续仅文档提交不移动此Tag，APK来源始终是固定的fd3bd0d。
