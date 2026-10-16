# 免费 MCP 默认启动（2026-10-15）

用户要求：每次打开 Melo 不再询问启用哪些 MCP；无需额外付费的服务默认启动。

## 行为与费用边界

| 内置服务 | 新配置默认 | 运行方式 |
| --- | --- | --- |
| Playwright 0.0.71 | 开启 | 本地浏览器；不需要云浏览器账号 |
| AntV Chart 0.9.10 | 开启 | 本地 MCP 进程，调用时使用 AntV 免费远程渲染服务 |
| Markdown2PDF 2.2.0 | 开启 | 本地 PDF 渲染 |
| Mermaid 0.4.1 | 开启 | 本地流程图渲染 |
| Browserless | 关闭 | 云服务且当前预设没有可用固定版本，不自动启用 |

依据：[AntV 默认免费服务说明](https://github.com/antvis/mcp-server-chart#-private-deployment)、[Markdown2PDF](https://github.com/2b3pro/markdown2pdf-mcp)、[Mermaid](https://github.com/hustcc/mcp-mermaid)、[Playwright](https://github.com/microsoft/playwright-mcp)，并核对本机上述固定版本包。自动启动仅做 MCP 握手和工具发现，不发送模型请求；后续模型调用沿用原账户的计费规则。AntV 不是离线渲染。

- 删除启动弹窗、旧选择回调和 dispatcher；不通过 UI 静默模拟三次点击。
- 新配置默认开启四个已知免费预设；旧 `productivityMcpsConsented:false` 表示尚未处理的询问，读取时迁移三个生产力预设。旧已完成的选择、浏览器显式开关、自定义服务器原样保留。
- 兼容标记统一为 true；下次正常保存会持久化。设置关闭时基于迁移后的配置保存，因此冷启动不会重新打开手动关闭的服务。
- 固定包版本、角色 MCP 白名单、调用审批、已有账号/聊天/高质量图片配置保留。未知或需要付费凭据的服务不纳入默认开启集合。
- 测试环境禁止隐式拉起 npm 服务，注入的 bootstrap 仍可测真实参数接线；生产行为另以原生应用验证。

## 实际接入

`src/config.js` 默认及兼容迁移 → `src/mcp/init.js` → `src/mcp/manager.js` → `src/mcp/client.js`。前端 `desktop-ui/app.js` 移除首启弹窗；`src/services/desktop/bootstrap.js` 保留旧客户端兼容字段。Advanced 原开关继续可用。

原生验证额外发现：桌面进程通过 NVM 找到 Node，但 PATH 只有系统目录，MCP `spawn npx` 报 ENOENT，四项配置开启却全未连接。客户端现在把正在使用的 Node 安装目录加入继承 PATH；显式 per-server PATH 仍优先。没有修改全局 shell 或用户系统配置。

## 验证与证据

证据目录：`.tmp/mcp-startup-20261015/`。

- `red.log`：新配置/迁移/测试隔离 4 个测试先失败；`path-red.log`：极简原生 PATH 真实子进程握手先失败。
- `green-unit.log`：MCP 63/63；包括新配置、旧询问、手动关闭后冷进程读回、自定义/账号/图片设置保留、极简 PATH 的实际 MCP 握手和工具发现。
- `browser.log`：启动/刷新/服务重启 1/1；即使 bootstrap 给出旧 false 标记也无弹窗，不发旧启用请求，关闭持久化。
- `desktop-first-launch.json`：修复前真实四项开启但零连接；`desktop-path-fixed.json` / `desktop-second-launch.json`：修复后两次原生启动，四项全部连接，页面无询问；用户 14 段对话、1 项目、6 角色保留。
- `shutdown.json`：退出后检查服务器及此次 MCP 子进程 PID，均已结束。第二次启动后保持用户应用运行。
- `daily.log`：共享工作树 3493/3494，已有图片预览第 65 行焦点断言失败；`image-preview-recheck.log` 独立复现。该测试使用独立页面，不加载本次 MCP 改动；主线交接也已记录此问题。本次保留无关 WIP。
- `isolated-daily.log`：仅本次改动的隔离暂存树日常检查通过，3485 JS 通过、1 项语义检索因未复制打包模型跳过；语法、设置/加速浏览器、21 组 Swift 及共享渲染通过（179.6 秒）。

没有执行真实业务工具、模型或生图请求；本次不涉及 iPhone 本地 stdio 服务。日常检查和启动验证不等同于完整发布 gate。
