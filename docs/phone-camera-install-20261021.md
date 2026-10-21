# iPhone 拍照版覆盖安装 · 2026-10-21

## 结果与范围

按用户“晚上再手机安装”及本线程设备、Xcode 登录、钥匙串授权回复，仅对原 iPhone 原位覆盖一次。实体设备回读为 **0.7.8（40）**，同 bundle / Personal Team / Keychain access group；未卸载、未清空、未恢复旧快照覆盖现有数据。源码基线 `6746eea`，包含已推送的测试降本 `8304aab` 与原生拍照 `6fba8db`，本阶段仅调整 iOS 发布版本元数据及文档。

新签名有效至 **2026-10-28 20:52（Australia/Melbourne）**。桌面与 Android 本次未重新安装；实时语音和连续画面解答继续暂缓。没有运行 `git pp`，此安装回执本地提交，不自动推送。

## 数据保留

安装前将整个 App 数据容器保存到用户 Library 下私有 `MeloDeviceBackups` 目录，并建立逐文件 SHA-256 清单；目录仅用户可读。原始容器约 177.6 MB / 49 文件。备份没有导出系统 Keychain 中的登录凭证；账号保留以签名访问组一致、配置指纹、启动界面及用户实际回复反馈分层核对。

| 核对对象 | 安装前 | 安装后、首次启动前 | 启动与拍照验收后 |
| --- | --- | --- | --- |
| 原聊天 / 消息 | 12 / 137 | 原样保留 | 原 12 / 137 逐条一致；另有 2 段验收新对话 |
| Agent 定义 | 6 | 全部一致 | 全部一致 |
| 原图片文件 | 21 | SHA-256 全部一致 | SHA-256 全部一致 |
| 账号连接偏好 | 4 个字段指纹 | 全部一致 | 全部一致 |
| 相机照片 | 无本轮采集 | 未采集 | 新增 1 张 4032×3024 JPEG，555182 字节；草稿引用保留 |

安装前后仅两个 iOS SplashBoard 启动快照缓存消失，持久业务文件无缺失。启动后聊天列表、草稿、图片索引及运行诊断正常变化；原消息内容和原图没有被重写。没有把正常缓存变化称为数据丢失，也没有声称整个运行容器逐字节不变。

## 实际验证层级

- **代码回归**：`npm run test:ios` 通过，37 组 Swift；发布元数据的显式文件计划保守扩大，`npm test -- --files ios/Melo.xcodeproj/project.pbxproj MELO_OVERVIEW.md PROGRESS.md` 八阶段全部退出 0，4421/4421 JS、37/37 Swift、两组浏览器，零跳过，总计 260.07 秒。Swift 复用编译产物后实际重跑测试。
- **构建与签名**：Release 无签名构建通过；用户完成原开发账号重新登录和系统钥匙串授权后，Release 自动签名构建通过。严格验签通过，设备在新 profile 内，应用标识、团队及 Keychain 访问组与原版相同；打包后的 Scene / Agent Core 资源与源码一致。
- **安装与启动**：`devicectl` 覆盖安装成功，安装列表确认 0.7.8 / 40。首次启动曾被系统安全校验拒绝，重试已成功并返回运行 PID；未通过修改安全设置绕过校验，也未将首次错误武断归因于未信任证书。
- **真机界面（Codex 直接观察）**：Device Hub 中实际打开 Melo 首页和原有聊天，账号状态、12 段原对话及旧消息可见；相机入口、首次授权、拍摄确认界面和照片草稿可见。镜像相机区域黑屏且远程操作结果不稳定，因此完整拍照流程交由用户在实体屏幕确认。
- **真机拍照（用户确认）**：用户将后置相机对准普通物品，并确认取景、拍摄后重拍、使用照片进入草稿、再次打开后取消保留原草稿四项全部正常。回读独立证实新增完整分辨率 JPEG 和草稿存在。
- **真实模型连接（用户确认）**：用户按提示发送验收文字后答复“已收到正常回复”。该层来自用户现场反馈；本轮回读快照仍为 137 条消息，不宣称在存档中独立核验了该次新增回复或完整供应商链路。

前后镜头切换、相机后台恢复、长后台运行、逐档画质与拍照图发送后模型识别不在上述结论中。本次仅做 iPhone 覆盖安装，没有运行会覆盖桌面的 `test:full`；当前源代码此前的双端组合回归详见[拍照实现与测试](test-cost-camera-plan-20261021.md)，不能将本次范围检查称为完整桌面发布门禁。

## 本机证据入口

- `.tmp/camera-phone-install-20261021/`：`before-manifest.json`、`before-summary.json`、账号字段指纹、`build-verification.json`、`install.json`、`installed-after.json`、`launch-retry.json`、`phone-after-install-preservation.json`、`phone-after-qa-preservation.json`、`camera-data-check.json`。
- 私有原始容器的位置只记录在上述目录的 `private-location.json`；`phone-before`、`phone-after-install`、`phone-after-qa` 三份保留，不提交仓库。
- `signed-build-retry.log`、`unsigned-build.log`、`phone-regression.log`、`release-daily.log`；回归完整报告 `.tmp/test-runs/run-rpfIe6/report.json`。
- 发布文件 `ios/dist/Melo-0.7.8-personal-test.ipa`；二进制与 IPA SHA-256 记录于 `build-verification.json`，不把 IPA 放入源代码提交。
- 系统登录、密码和验证码均由用户在系统窗口完成；仓库报告不写凭证、账号标识或图片内容。

## 单独跟进项

远端查询发现代码提交 `6fba8db` 的 Android / Cross-platform 工作流被后续文档推送取消，后续文档提交的工作流总体成功不能证明前一代码提交的重型任务执行完成。工作流的 `cancel-in-progress` 与纯文档选组组合存在需要单独处理的覆盖缺口；本次依靠已记录的本地完整组合与手机发布回归，不冒称远端完整代码 CI 全绿。此项未在安装阶段修改。
