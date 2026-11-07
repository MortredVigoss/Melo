# 模型连接设置整理

基准 `cc115e8e8ba7a13cf6e6dd41cf5f147786b21587`。共享树原有 MELO_OVERVIEW / PROGRESS 的 Claude 用量统计改动保留。本次只整理模型连接设置和用户要求关闭的智能选模选项，保持首页、配色、神经网络与其他功能。

## 执行链路与边界

- 桌面：系统入口 → `renderModelPage` → `renderLlmConnections` / `editLlmConnection` → `handleLlmConnection` → `/api/settings/llm/save|activate` → 配置锁与连接存储 → 会话请求。选择浏览方式不激活账号；保存和设为默认仍分开。表单结构必须随登录方式、服务、连接身份改变，避免 DOM 复用保留上一个账号的值。
- iPhone：`SettingsView` → `LLMConnectionsView` → CodexLoginCard 或 API 表单 → `prepared/runSave` → `LLMConnection.save` / Keychain。保留已有凭证、未保存草稿、失败重试与同平台多账号。
- Android：`SettingsScreen` → 连接编辑弹窗 → `Repository.saveConnection` → ChatEngine。Android 当前仅有 API 接入，不添加未实现的 OAuth 入口。
- 智能选模：设置 → 保存策略 → 桌面 routingPolicy / PhoneRoutingPolicy / Android SmartRouting → 共享 selectRouting / escalateRouting。按用户“关闭”要求停止产品入口的自动选模，旧策略保留但不生效；默认与每段对话都使用明确模型，设置接口拒绝重新启用跨连接/升档，通用路由引擎和历史回执保留。桌面 prepareNode 在调用路由前转换固定模式；iPhone guard 与 Android ChatEngine 同步关闭。
- 验证边界：隔离配置与假凭证下检查切换后显示、保存、取消、失败、旧账号读取、手动模型、无横向溢出；Swift 编译及模拟器，Android 构建/回归。停止在现有凭证存储和供应商请求协议边界，不使用用户密钥做测试，不安装或推送。

## 结构参考

参考 [Cherry Studio 模型服务设置](https://github.com/CherryHQ/cherry-studio-docs/blob/main/pre-basic/settings/providers.md) 的服务 → 凭证 → 模型 → 高级设置层次。沿用 Melo 黑金样式与现有组件，不引入整套外部 UI 库或复制其密钥轮询语义。

## 覆盖清单与停止条件

| 路径 | 本轮检查与保护 |
| --- | --- |
| `desktop-ui/llmConnections.js:editLlmConnection/renderLlmConnections/handleLlmConnection` | 连接方式、账号与服务商共同决定表单；未保存草稿拦截切换；服务商变化重建表单节点，防止保留上个服务的密码值。保存失败、版本冲突、取消和重新载入沿用现有编辑会话。 |
| `desktop-ui/app.js:renderModelPage`、`modelPresentation.js` | 移除智能模式入口；具体模型仍可手动选择；默认参数与连接诊断折叠，现有历史会话保持。 |
| `ios/Melo/LLMConnections.swift:restoreDraft/add/prepared/runSave` | 本机已保存连接、Keychain 与安全草稿继续使用原存储；登录方式仅控制浏览分支，保存和激活分开。保存异常显示在表单，不覆盖已有凭证。 |
| `src/services/chat/execution/prepareNode.js:createPrepareNode` → `routing.js:fixedModelRoutingConfig/createRoutingSession` | 在真实执行入口将旧策略转换成固定模型；不改写磁盘原配置；旧 smart 对话优先保留明确指定的 Agent 模型。生产回归断言没有判型请求、没有自动换连接，已执行工具结果仍可交付。 |
| `src/services/settings/smartRouting.js:saveSmartRouting` | 接口拒绝重新启用智能模式、跨连接或升档；原有 revision 冲突检查、配置锁和原子写保留。 |
| `ios/Melo/SmartRoutingIntegration.swift:smartRoutingHost`、`ChatStore.swift`、Android `ChatEngine.kt` | 原生产品入口不创建智能路由会话；Android 只读取当前选定连接的密钥。保留通用引擎与历史执行回执。 |
| Android `Editors.kt`、`MainActivity.kt` | 移除智能选模控件与标签；服务商选项更新实际 URL/协议；接口能力移入高级折叠区。Android 尚无 ChatGPT OAuth，未放置不可用入口。 |

停止于既有凭证持久化和供应商适配器边界：未更改密钥加密、账号同步或供应商协议。上限、取消、中断、审批、上下文压缩与网络异常由既有执行链回归覆盖；真实供应商登录、实体手机、已安装 App、远端发布不在本轮验证范围。首页神经网络布局、图标、动效、配色未改。

## 当前结果与验证

产品源码、最终原生交互与交付两档回归均通过。智能选模已按用户决定从三端产品入口停用，连接方式切换对应实际表单。所有测试使用隔离配置和假凭证；实体手机、真实供应商授权、已安装 App 和远端发布未验收。

| 层级 | 结果与证据 |
| --- | --- |
| 定向生产行为 | 连接/菜单/路由/保存 25 项；生产执行链 32 项；成员编排 6 项；最新连接交互 5 项；五语言目录 2 项通过。这些范围有重叠，不累加为总数。日志 `.tmp/model-settings-{pipeline,orchestration,connection,locales}.log`。 |
| 最终快速档 | `run-gaaE0q`：591/591 个 JS 文件、5006/5006 项，0 失败/取消/跳过；Android JVM/Lint/Debug/Release、设置浏览器、38 组 Swift 全部通过。267.1 秒，无隔离复测。摘要 `.tmp/test-runs/run-gaaE0q/summary.json`，副本 `.tmp/model-settings-20261107/quick-summary.json`。 |
| 最终集成档 | `run-fO1TLM` 基于 `cc115e8e8ba7a13cf6e6dd41cf5f147786b21587` 全绿：5006/5006 项 JS，0 失败/取消/跳过；设置浏览器、Android 四阶段、38 组 Swift 通过。258 秒，无隔离复测。摘要 `.tmp/test-runs/run-fO1TLM/summary.json`，副本 `.tmp/model-settings-20261107/integration-summary.json`。 |
| iPhone 原生 | `run-p1h0hafm`、`run-ggz8aolg` 均完成方式切换、密钥保存后冷启动、补模型、连接测试与普通聊天，本机 HTTPS 夹具确认探测和聊天使用同一已保存凭证。最新 `run-jis2byqb` 再次完整通过（95.813 秒）：包含常驻字段名、隐藏登录前不可用控件与长表单保存滚动。`receipts.json` 为 `[["probe", true], ["chat", true]]`；三张最终截图已复查，隔离模拟器已清理。 |
| 桌面可见交互 | 隔离开发实例人工检查方式切换与 Custom 编辑；真实浏览器脚本检查五个同平台账号、默认与单聊选择、失败/取消/冲突、390 像素模型表单与 320/390/900/1440 像素聊天。最终三张设置页截图已检查，控件没有横向溢出。 |

截图与摘要集中在 `.tmp/model-settings-20261107/`。原生完整日志和凭证回执位于 `.tmp/key-save-ui-results/<run>/`。现有正式 Mac App 当时停留在本地工作空间连接启动页，未操作真实账号。

## 回归中处理的问题

- `run-VUWDgL` 在共享渲染资源预检拦下新增翻译的旧 manifest，JS 尚未执行；执行 `npm run build:ios-scene` 后补齐。
- `run-AlYJLL` / `run-qg3ogT` 分别因 JDK / SDK 环境未指定而停止。改用本机已有 `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`、`ANDROID_HOME=/opt/homebrew/share/android-commandlinetools` 后 Android 四阶段通过，没有安装工具或依赖。
- `run-asVAgc` 首轮 JS 5004/5006：一项 15 秒浏览器服务启动超时；另一项旧 `orchestrationReview.smartFloor` 仍要求自动升档。按用户明确的停用决定改成 `legacySmartFixed`，验证没有判型请求，主模型/执行成员/完成检查都使用指定模型，写入仍只发生一次。两个生产链旧自动切换用例也改为停用后的明确行为；通用引擎原有判断与升级测试保留。最终快速档全部通过。初次摘要保存在 `.tmp/model-settings-20261107/quick-initial-summary.json`。
- 初次独立设置浏览器脚本等待已移除的 smart 按钮；已改为断言该入口不存在，并检查服务端公开策略为 fixed、跨连接与升档均为 false。

## 复现入口

- 本任务文件清单：`.tmp/model-settings-20261107/task-files.json`；快速档 `npm run test:plan -- --files <清单>`，随后 `npm test -- --files <清单>`，Android 使用上面两个环境变量。
- 集成档：同环境运行 `npm test -- --base cc115e8e8ba7a13cf6e6dd41cf5f147786b21587`。
- 原生连接验收：`python3 ios/scripts/test-connection-save-ui.py`，脚本自行创建并清理隔离模拟器与临时证书；不连接真实模型账号。
- 仅测试固定模式及完整执行：`node --test src/services/chat/chatExecutionRunner.test.js src/services/chat/orchestrationReview.test.js src/services/modelRouting/routing.test.js src/services/settings/smartRouting.test.js`。

- 最新 iPhone `run-fmg6yvjf`：登录方式切换、保存密钥与冷启动通过，补模型后的探测未发送。失败层级快照显示编辑态仍为“有未保存的修改”、保存按钮在可视区域上方，探测按钮仍禁用，夹具回执为空；模型和服务地址值正确。补充原生测试的表单滚动及 `connection.edit` 重新出现断言，确认保存实际完成后再探测；未更改产品保存/凭证逻辑。失败附件保留在 `.tmp/model-settings-20261107/iphone-initial-attachments/`。

- 产品源码曾先通过 `run-ikLuxP` / `run-pLcBWy` 两档；原生保存测试补强后，`run-jis2byqb` 完整通过，再执行上述最终两档，未跳过失败或降低断言。源码指纹 `.tmp/model-settings-20261107/source-hashes.json` 与最终验证一致，隔离设备清理回执为 `cleanup.json`。
