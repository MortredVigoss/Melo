# 首页神经导航回归修复（2026-10-27）

## 范围与基准

用户要求恢复首页对话入口、顶部项目与中枢的间距、Agent / 知识库周围的神经结构。基准 `54a9cac`，开工工作树干净。保留现有配色、粒子拓扑、功能入口、账户和数据；不重新设计首页，不推送或安装。

## 修改前执行链与边界

- `app.js:render` → `neuralShell.js:renderNeuralNavigation/renderNeuralOverview` → `neuralDom.js:updateNeuralWorkspace` 保留 DOM 和输入草稿 → `neuralMotion.js:animateNeuralLayout/positionNeuralWorkspace` 测量 dock → `neuralLayout.js:workspaceLayout` 计算中枢、五个模块和工作面坐标。
- `neuralShell.js:syncNeuralScene/readRoutes` → `neuralSampling.js:createRouteSampler` 缓存 DOM 中心、半径、悬停状态 → `neuralScene3D.js:createNeuralScene/createGpuScene` 持续帧绘制与投影拾取；GPU 初始化失败由共享 Canvas renderer 降级。`neuralSatellite.js:createSatelliteTopology/createSatelliteGlyph/advanceSatelliteMotion` 提供五组拓扑与悬停对齐。
- `index.html` 的真实样式加载顺序 → `neural.css` 空间布局 → `neuralGlass.css` 无圆壳入口 → `surfaceUnify.css` 通用控件。CSS 决定 DOM 实际尺寸，进而影响 GPU 图形坐标；因此不能只检查 CSS 字面值。
- 共享状态限于 DOM、ResizeObserver、routeSampler 与场景内存；本次不写 `state.json` / SQLite，不修改 HTTP、Agent、权限、预算、同步 v1 或工具协议。普通导航事件仍由既有应用分发器处理。无新增异常；渲染失败维持现有降级。
- iOS `ios/scripts/build-scene.py` 消费 `neuralGlass.css`，须重建共享场景并核对生成差异；桌面 `neural.css` 不在手机 bundle 内。
- 停止于渲染输出、样式级联、布局采样与生成资产；不进入 Three.js 内部、模型调用、网络搜索和数据持久化。调用上限、审批/取消、压缩与服务超时不受此次 CSS 修复影响。

## 已确认的问题

1. `07c3b46` 删除首页样式的 `!important` 后，旧规则重新获胜：选中/悬停入口出现实体圆壳，遮住原本无边界的神经组织。不是设计意图变更。
2. 同一提交取消首页 `padding:0` 的优先级，1320px 窗口重新套入旧版 `32px 25px` 内边距。输入 dock 增高 64px，并被测量反馈进整个星图，导致中枢和模块整体收缩、上移，顶部项目挤到中枢中。
3. 与 `40b4a57` 对照，五组 satellite 节点/连线数量与旋转代码没有删减。先恢复透明入口和原有空间，再实看完整度，不凭观感改变图形数量。
4. 修复级联后，带上一轮折叠任务回执的首页仍会出现顶部项目与中枢重叠：`workspaceLayout` 只扣除 dock 高度，没有给顶部独立入口预留空间。补同一布局函数中的垂直安全区，优先下移中枢、空间不足才限制其尺寸；五个外围入口位置与形状保留。验收同时覆盖普通 dock、任务回执和矮窗口；GPU 悬停抬升与边缘留白仍须检查。

## 验证计划与证据

- 真实应用截图：`.tmp/home-regression-20261027/native-before.png`；浏览器截图及尺寸：同目录 `browser-before.png`、`geometry-before.json`。
- 新增真实全量 CSS 顺序下的浏览器回归：默认/选中/悬停/键盘聚焦都无圆壳；首页无多余内边距；尺寸改变后标题不裁切且入口可点按。先证实红灯，再做针对性修复。
- 修复后原生窗口与浏览器实看，快速档、基准集成档分别记录。手机仅生成资产与相关门禁，不冒充真机验收。
- 定向红绿：`red.log` 两项失败（实体圆壳、1320px 下 64px 旧内边距）；`layout-red.log` 再现项目与中枢未预留空间；`focused-green.log` 修复后 11/11 通过。
- 修复只涉及 `neural.css` 首页内边距选择器、`neuralGlass.css` 入口各状态的透明壳选择器、`neuralLayout.js:workspaceLayout` 首页垂直安全区。没有改五组颜色、240 个 satellite 节点、图标线段或 renderer。iOS 仅共享样式与 manifest 生成差异，手机独立首页布局未改。
- 浏览器实看 1320×860、900×660；原生 macOS 1320×860 逻辑尺寸。`native-after.png` 为已安装应用重新载入仓库资源后的实际首页，无重装。`focus-checks.json` 五个文字正确、透明壳、focus 0–4；`navigation-checks.json` 五组原有功能分支均可打开。动画计数持续增长，18 calls / 18 geometries / 0 textures；不是性能基准或长时功耗结论。1320×860 下项目聚焦完全抬升后，入口底缘与投影上部神经区仍有约 18.9px 间距，见 `project-hover-clearance.json` / `project-hover-after.png`。
- 依赖登记：新增浏览器测试读取真实 index/CSS/布局源码，登记 `architecture/module-annotations.json:neural-home-cascade` 并生成 `architecture/modules.json`，保证后续通用样式更改会选中此回归。
- 门禁首次 `run-7Xevkp` 因上述新测试尚未登记而停止，已补齐；`run-VDUuzz` / `run-H9h6Gy` 分别因 shell 未提供 JDK / SDK 路径停止。已确认本机既有工具链后显式提供 `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`、`ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`，没有安装新软件或跳过阶段。
- 快速档 `run-pGEfj5/summary.json`：GREEN，143/568 个文件；JS 首轮 778 项、777 pass、1 cancelled（安全浏览器用例负载超时），运行器记录的一次隔离复测通过；Android JVM/Lint/Debug/Release、共享渲染预检、设置浏览器通过，无平台跳过。总计 438.6s。
- 基准集成档 `run-necJZi/summary.json`：GREEN，143/568 个文件，JS 778/778、0 fail/cancelled/skipped；Android JVM/Lint/Debug/Release、共享渲染预检、设置浏览器全部通过，无复测、无平台跳过，223.5s。Swift 不在本次选测范围，未运行；不代表全仓/真机/真实模型/发布验收。
- 当前状态：修复、回归、桌面视觉验收完成，本地提交 `a74a90d`；不推送、不安装，其他功能及用户数据未更改。

## 复验命令

```sh
node --test desktop-ui/neuralWorkspace.test.js desktop-ui/neuralHome.browser.test.js
npm run build:ios-scene
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/opt/homebrew/share/android-commandlinetools npm test -- --base 54a9cac
```

完整快速档与集成选测清单见专项证据目录 `test-plan.txt` / `integration-plan.txt`；两次运行的 summary 是最终状态依据。
