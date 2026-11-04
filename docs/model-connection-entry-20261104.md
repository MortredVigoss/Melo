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
