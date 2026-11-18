# 桌面操作可达性与布局修复（2026-11-18）

## 范围与基准

基准 `3c7a8aed`；独立工作树 `/tmp/melo-desktop-ui-20261118`、分支 `codex/desktop-ui-reachability-20261118`。主线程授权修复聊天/输入、侧栏、设置/模型、任务空间与弹窗的遮挡，保持现有黑金、神经场景与真实功能。只本地提交，不推送、不安装。正式账号、聊天与配置不参与夹具；语音 JS/Swift 控制器由主线程负责。

## 修改前执行链路与审计边界

- `app.js:render` → `features/chat/index.js:installChatFeature` → `viewThread.js:renderRegularChatPage` / `viewComposer.js:renderComposerCard` → 真实 DOM 与 `neuralDom.js:updateNeuralWorkspace` 差量更新 → CSS 布局 / `restoreComposerAfterRender`。覆盖长文本、输入增长、保留草稿与滚动；不改变发送、取消、审批或模型执行。
- `conversationContext.js:renderConversationContext` / `imageControls.js:renderImageTaskControls` / `viewComposer.js:renderComposerAttachmentMenu` → 展开菜单 → 视口定位与顶层呈现；模型与 Agent 选择已有 `showPopover` + `modelPresentation.js:modelPanelPosition`，复用定位约定。菜单选择仍交原事件注册表和原 API，临时显示状态只在 DOM，不写用户配置。
- `neuralShell.js:renderNeuralNavigation` → `neuralMotion.js:positionNeuralWorkspace` → `neuralLayout.js:workspaceLayout` → 分支 DOM 与场景共用坐标。检查最底部模块与语言/设置页脚互挡，不能单独移动文字而留 GPU 位置不变。
- 系统模型入口 → `app.js:renderModelPage` → `llmConnections.js` 表单 → `settingsEdit.js` 编辑/保存约定。只核对表单切换、可滚动与按钮可达；不改账号选择或密钥保存语义。
- 任务按钮 → `executionPanel.js:syncExecutionPanel` → `warRoom.js:createWarRoom/render` → `warRoom.css` 顶部、场景、底部记录与详情滚动。覆盖窗口尺寸、长记录、缩放与关闭；不更改执行账本/统计契约。
- 停止边界：布局到 DOM 命中/滚动/原交互 API 结果；网络请求使用隔离夹具。真实供应商、麦克风、正式原生安装和手机实机本轮不验。若修改共享场景源，生成 iOS 资源并跑对应一致性，不能称手机安装完成。

## 已复现（修改前）

1. 900×600、12 行草稿：底部操作强制单行，文字入口被压成竖排；任务空间按钮覆盖模型按钮，真实 Playwright click 被任务按钮拦截。
2. 同尺寸，项目与知识菜单向左伸出阅读面板，被祖先 overflow 裁掉。模型点击的自动滚动还把 `neural-dashboard.scrollLeft` 推到 181，后续模型设置页整体向左裁切。
3. 800×500：系统模块与底部语言按钮重叠，真实点击被语言 summary 拦截。
4. 长代码行：thread 阅读区 scrollWidth 3151、clientWidth 560，代码溢出阅读网格。

5. 主线程复看 800×500 截图后指出小窗口侧栏中枢粒子贴近 Agent / 知识库名称，未选中名称偏暗。补查 GPU 投影与 DOM 标签的实际位置，覆盖动画和静态两种模式。
6. 主线程使用原生 WKWebView 800×500 冷启动补验，发现模块摘要覆盖历史聊天入口。此前 Chrome 从 1280 打开聊天后缩窗，遗漏这条路径。补查 `neuralMotion.js:positionNeuralWorkspace` → module stage 面板 → `neural.css` 650–900px 把摘要重新显示的覆盖规则；紧凑分支页应由分支表头承载已有摘要，避免重复的阅读面板截获点击。回归改成从 800×500、动画开启冷启动并实际点击历史聊天，随后再验证各尺寸。

## 最终行为与实现

- 阅读面板用 `overflow:clip` 阻止焦点把整个工作面横向滚走；长代码只在代码块内部滚动。聊天网格显式容纳标题、文件、正文、输入四行，长标题省略但保留完整 title。
- 输入区按实际可用宽度换行，短标签不压成竖排；任务空间入口保留独立点击区。短窗口将任务摘要和 Agent 放在同一行；800×500 有历史任务与 12 行草稿时，输入框内部滚动、草稿完整保留，正文仍有 70px 可滚动阅读区。
- `features/chat/composerOverlays.js:installComposerOverlays` 在原 DOM / 表单归属不变的条件下，把项目知识、图片选项、附件、声音菜单提升到浏览器顶层。复用 `modelPanelPosition` 夹在视口内，菜单单独滚动；Escape、外部点按、窗口调整、命令面板与任务空间切换保留原控制器语义。`features/chat/index.js` 的 render 恢复出口接入同步，不修改语音或发送控制器。
- 宽度 ≤1000px 的阅读态收起二级分支，现有“返回分支”入口恢复分支选择。五个主模块持续可点，短窗口为底部语言/账户区预留空间。紧凑模块页隐藏重复的摘要阅读面板，由列表原有表头说明当前模块，修复 WKWebView 冷启动时摘要挡住聊天入口。
- `neuralLayout.js` 同时提供 DOM 与 GPU 的侧栏位置和较小中枢半径；`neuralScene.js` 的 Canvas 回退也采用该半径。`neuralScene3D.js` 随缩小面积降低中枢的叠加亮度，保留原拓扑、颜色、五个分支和动画；首页的大场景比例及亮度不变。`neuralShell.js:readRoutes` 不向收起后零尺寸的分支生成连线。
- 使用现有玻璃材质、色彩与字号 token。已重新生成 `architecture/modules.json`、iOS `Scene/neural.js` 与 `desktop-manifest.json`；这仅证明共享资源一致，不代表手机安装或实机验收。

## 浏览器操作与证据

证据根目录：`/tmp/melo-desktop-ui-20261118/.tmp/desktop-ui-reachability-20261118/`。Chrome 连接真实本地 Melo HTTP 服务，服务与数据全部在一次性目录；原生通话消息通道仅为可见性夹具，未启动麦克风。

| 视口 | 正文宽 / 实际滚动宽 | 正文高度 | 证据 |
| --- | --- | --- | --- |
| 1440×900 | 968 / 968 | 385 | `after-chat-1440x900.png` |
| 1280×800 | 808 / 808 | 285 | `after-chat-1280x800.png` |
| 900×600 | 734 / 734 | 96 | `after-chat-900x600.png` |
| 800×500 | 634 / 634 | 70 | `after-chat-800x500.png` |
| 1024×640 | 684 / 684 | 140 | `after-chat-1024x640.png` |

`desktop-ui/desktopReachability.browser.test.js` 使用真实点击与 `elementFromPoint` 检查按钮可达、矩形不互挡，不使用强制点击；验证草稿完整、长代码滚动、模型选择、Agent 菜单、30 项知识的末项选择、图片数量、附件、命令面板、五个模块、Codex/API Key/本地连接表单切换。任务空间含 24 条长工具记录，验证末项可滚动到、返回、真实缩放值变化、关闭。

动画与静态各核对 GPU 的五个 `coreRegions` 投影边缘和名称之间至少 8px 间隔、名称命中与不透明度；再分别点击五个名称验证模块切换。截图为 `after-sidebar-animated.png` / `after-sidebar-static.png`。小中枢仍有光路，但不会与名称混成一团。

| 对比项目 | 修改前 | 修改后 |
| --- | --- | --- |
| 输入区遮挡 / 菜单裁切 | `before-chat-900-settled.png`、`before-context-900.png` | `after-chat-900x600.png`、`after-context-scrolled.png` |
| 工作面焦点滚偏 | `before-settings-800-settled.png`（scrollLeft 181） | `after-settings.png`（scrollLeft 0） |
| 小窗口侧栏 / 光路与名称 | 初次修复截图由主线程指出，已进一步调整 | `after-sidebar-animated.png`、`after-sidebar-static.png` |
| 模型 / 命令浮层 / 任务空间 | 原交互中的点击截断记录见修复前日志 | `after-model-picker.png`、`after-palette.png`、`after-task-space.png` |

## 验证层级与停止边界

- 基准反向验证：只把七个相关运行时文件恢复到 `3c7a8aed`，执行新浏览器测试，报 `long code scrolls inside its own block` 断言失败，退出 1；随后恢复修复版。`baseline-red.json` / `baseline-red.log` / `baseline/final-state.png` 保存原版证据。
- 聚焦验证：`focused-5.log`，浏览器流程与既有几何测试 10/10 通过，0 失败/取消/跳过。后加的紧凑侧栏几何用例与冷启动操作纳入 `focused-final.log`，11/11 通过，0 失败/取消/跳过。
- 首轮快速档 `run-zqKVnp` 全过（JS 899/899，0 失败/取消/跳过，Android 四项、TopicDividersTests、设置浏览器通过，272 秒）；随后根据原生补验修复冷启动，不能把首轮结果充作最终源码结果。最终快速档 `run-VLsHY7`：162/620 个 JS 文件、899/899 项，0 失败/取消/跳过，126.6 秒；集成档 `run-WgddKf`（基准 `3c7a8aed`）：162/620 文件、899/899 项，0 失败/取消/跳过，128.5 秒。两档 Android JVM/Lint/Debug/Release、TopicDividersTests、设置浏览器、共享渲染一致性均通过；无隔离复测、无平台未执行。命令清单 `task-files.json`；选择原因 `plan-final.log`；摘要 `quick-final-summary.json` / `integration-summary.json`。
- 机械扫描 H1–H20：先按 10-26 长期基线扫描，再对同一开工提交 `3c7a8aed` 的隔离源码复扫。任务相对开工基准新增 0、关闭 0；长期基线中的既有差异不是本次引入。证据 `audit/diff.json`、`audit-base/inventory-2026-11-18.json`、`audit-task/diff.json`。未改旧基线来消除命中。
- 原生补验差异：主线程 `.tmp/voice-playback-20261118/wk-acceptance.log` 给出摘要 x90–710 与历史聊天 x166–404 的重叠回执；Chrome 同路径修前仍通过（`cold-entry-chrome-before.log`），不是伪造的红灯。主线程已在修复版 WKWebView 复验通过：800×500 冷启动后滚动并命中历史聊天，五个模块、通话、模型、项目菜单均可点；12 行草稿保留，项目菜单处于顶层。原始回执已复制到本证据目录 `wk-acceptance.log`。这是真实 WebKit 引擎与隔离服务验证，不是正式 App 安装或麦克风验收。
- 操作及错误摘要：`interaction-metrics.json`，页面异常 0。缩放覆盖任务场景缩放和较小逻辑视口；没有操作 Chrome 原生页面缩放菜单，不把 1024×640 截图冒充真实 125% 浏览器缩放验收。
- 未覆盖：正式 macOS 原生应用、真实麦克风和声学、真实模型回答、iPhone / Android 真机。预算、审批执行、取消、网络超时等业务逻辑没有修改，由所选关联回归覆盖，不能以本轮 UI 点击声明真实服务验收。
- 隔离预览服务和交互 Chrome 已退出，手动预览临时数据已删除；测试自身退出时关闭浏览器/服务并删除其数据。证据和工作树保留，清理回执 `preview-cleanup.json`。

## 交接

代码提交 `54c96302`；分支 `codex/desktop-ui-reachability-20261118`。最终源码指纹 `source-hashes.json` 与两档通过时一致。

本次仅独立分支、本地提交；没有推送、安装或接触正式账号、密钥、数据。语音 JS/Swift 控制器未改。主线程合并时保留其语音变更，合并后的组合状态需要依规范检查；不能把本分支浏览器通过写成已安装正式版。
