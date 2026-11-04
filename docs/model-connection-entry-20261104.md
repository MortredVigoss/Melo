# API Key 连接入口与切换

基准 b80ade3。系统设置、桌面模型页和 iPhone 模型服务共用原有连接存储。用户要求能直接添加 API Key，同时保存和切换多条连接，包括相同平台、地址或模型的两把密钥。

桌面从 localSettings / renderModelPage → llmConnections → POST /api/settings/llm/save 或 activate → 配置锁 → conversationConfig。iPhone 从 SettingsContent → SettingsView → LLMConnectionsView → Keychain，再由 ChatStore 解析对话选择。Android 从 SettingsScreen / 对话设置 → Repository → ChatEngine。同步只传连接身份和模型，不传凭证。核对全局默认、单段对话选择、同地址账户歧义、取消编辑以及旧连接读取。停止在现有模型传输和凭证存储边界，验收使用隔离配置及假密钥。

## 入口与账号边界

- 桌面系统设置顶部进入“模型连接与 API Key”。模型页先显示添加按钮与已保存的默认连接，再显示模型与高级选项。从聊天模型选择器可单独指定账号与模型。
- iPhone 系统设置顶部与聊天模型按钮打开同一页，可直接新增具名 API 连接，也可管理 Codex 登录。保存新连接与切换默认分开，原有单连接配置可读取。同一服务的每条新连接都有独立 ID。
- Android 将添加按钮和密钥输入提前，当前对话显示连接名。导入的选择先按 ID、协议与地址核对，同地址的多个账号无法确定时要求重新选择。聊天沿用系统默认时不把当时的账号同步成固定选择。

## 验收

| 环境 | 实际检查 |
| --- | --- |
| 桌面浏览器 | 从系统设置点击添加，同一地址和模型保存 5 条连接。系统默认选择账号 2，单段聊天固定账号 3。截图在 `.tmp/settings-design-check/five-key-connections.png`。 |
| 桌面传输 | 本地 HTTP 服务收到系统默认与固定对话各自的 Authorization。切回已有 Codex 配置后，API 账号仍可使用。定向回归 18 项通过。 |
| iPhone 模拟器 | 使用模拟器钥匙串保存 5 条连接。验证默认账号 2、对话账号 3，退出进程并再次启动后仍匹配，见 `.tmp/connection-entry-20261104/ios-first.json` 和 `ios-reopened.json`。 |
| Android 模拟器 | 通过普通聊天发两次请求，本地 HTTP 服务依次收到默认账号 2、对话账号 4 的凭证。改服务地址时拒绝沿用旧 Key。设备测试 1 项通过，见 `.tmp/connection-entry-20261104/android-instrumentation.xml`。 |

本次使用测试凭证与本机 HTTP 服务。iPhone 使用模拟器钥匙串和原生连接解析。真实供应商、用户账号和实体手机不在本次验收范围。

最终快速档 `run-t78jZl` 在 31 个任务文件上运行。4,843 项 JavaScript 测试、38 套 Swift、Android JVM / Lint / Debug / Release 和设置浏览器通过。完整摘要在 `.tmp/test-runs/run-t78jZl/summary.json`。

首次核对源码 b80ade3。开发期间另一条线程将 iPhone 后台恢复合并到 master，本次测试使用合并后的工作树。未修改用户设备上的账号、配置或应用。

## 保存交互复查

基准 b148a3a。旧版在保存后清空密钥编辑框，iPhone 重新打开时恢复默认连接或 OpenAI。单看编辑框无法判断刚保存的账号。此次按用户动作核对桌面 `editLlmConnection → handleLlmConnection → saveLlmProfile → renderLlmConnections`、iPhone `LLMConnectionsView.prepared → runSave → LLMConnection.save → Keychain → restoreDraft → test`。检查保存成功、失败时保留输入、重新打开及出站凭证。验证停止在本地模型服务的实际请求与用户可见结果。模拟器和独立浏览器使用测试密钥，真实账号、已安装 App 与第三方服务不参与。

### 复现和修复

- 桌面先保存 Key、把模型留空，旧代码会在能力表生成空字符串属性。界面回传这条记录补模型时，服务端报 `Invalid model capability id.`。已修正新记录的写入，并在编辑旧记录时丢弃这个无效属性；同一地址继续使用已保存的凭证。
- iPhone 旧的保存动作清空编辑框，重新打开时显示系统默认的连接或 OpenAI。修复后，桌面和 iPhone 在连接旁显示「API Key 已保存」；只存了 Key 时说明还需要选模型。重新打开能回到刚保存的账号。手机将按钮标为「编辑连接」和「保存连接」，便于区别同一页的其他设置。
- 初次交付时，桌面浏览器只验了一次填齐 Key 和模型的表单；iPhone 五账号用例直接走存储方法。这次增加按键、键盘输入、冷启动及正常聊天的检查。

| 操作 | 实际结果和证据 |
| --- | --- |
| 桌面浏览器 | 填错服务地址后保存失败，输入仍在。改地址并仅保存 Key，刷新后能看到回执。随后补模型、设为默认并从聊天输入框发送。测试服务按请求头确认原 Key，界面显示服务回复。`.tmp/key-save-ui-20261104/desktop-wire-receipts.json`、`desktop-chat.png`。 |
| 已有桌面数据 | 构造旧版空模型条目，通过普通保存和探测接口更新后，测试模型服务仍收到同一把 Key。`node --test src/providers/llmConnections.test.js desktop-ui/llmConnections.test.js`，19 项通过。 |
| iPhone 原生界面 | 修改前的 b148a3a 在 XCUITest 中点击保存后缺少可见凭证回执。修复后在独立模拟器点保存、终止进程、打开设置、留空密钥补模型并保存，再点击测试、设为当前、开启对话和发送。HTTPS 夹具收到预期账号的探测请求和普通聊天，用户界面显示对应回复。旧界面证据 `.tmp/key-save-ui-20261104/before.xcresult`，最终 `.tmp/key-save-ui-results/run-qon70v5q/test.xcresult`、`receipts.json`。 |

在 macOS 上运行 `python3 ios/scripts/test-connection-save-ui.py` 可重跑原生用例。它创建临时模拟器及只在该模拟器信任的本地证书，校验两次请求后清理。日常设置浏览器覆盖先保存 Key、刷新、补模型，不需要外部服务。测试用的是自有夹具，实际供应商授权及实体机未测。

本轮最终快速档 `run-EjySBh` 通过 4,844 项 JavaScript 测试、38 套 Swift、Android JVM / Lint / Debug / Release 与设置浏览器，无跳过或隔离复测。

### 2026-11-04 主线发布与 Mac 安装

GitHub master 从 `889174f` 快进到 `3379718`，推送后已回读远端 SHA。此批还包括 iPhone 后台恢复、内部 Agent 分工及任务空间分类。发布时无待合并到 master 的 PR。

首次集成检查 `run-q0I1Va` 的系统 Chrome 在首页用例启动时收到 SIGKILL。改用现有的 Chrome for Testing，单独验证该文件后，以同一基线完整重跑 `run-2njTtf`。4,844 项 JS、38 套 Swift、Android 四项和设置浏览器通过。随后 `npm run release:verify` 的 17 个阶段全绿，包含覆盖安装与两个 Mac 原生启动入口。实际安装的可执行文件与通过验证的构建逐字节相同。比对安装前后的账号配置、聊天正文与媒体文件哈希通过。备份与试验日志仅保存在本机；发布回执在 `.tmp/master-release-20261104/`。

从 Launchpad 正常启动并允许桌面目录访问后，确认运行版本为 `882eba7`，界面加载真实工作区与两份最新连接设置脚本。配置、聊天正文及已核对的媒体文件与安装前一致。只读回执保存在 `.tmp/master-release-20261104/installed.json`。

### 2026-11-04 iPhone 原位安装

安装同一主线 `882eba7` 的 Release 包，沿用 0.7.13（45）、开发团队、bundle 标识和钥匙串归属。安装前两次读取完整应用容器并逐文件校验 SHA-256；安装后和首次启动后分别回读。手机报告包位置已更新，启动 PID 与实际进程一致，应用产生新的 `launch`、`active` 事件。聊天、偏好、草稿及图像逐字节一致；执行记录重新编码后 JSON 内容一致。系统启动缓存和运行日志按预期更新。此次真机验收覆盖安装、前台启动与数据保留，未发出真实模型请求。脱敏安装摘要在 `.tmp/iphone-overwrite-20261104-1855/complete.json`，完整备份仅保存在本机私有目录。
