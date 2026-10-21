# Melo 日常检测与发布规则

本规则适用于 Codex、Claude、其他代理和人工开发者。2026-10-20 按用户要求实施：先保证关联测试不遗漏，再按改动范围检测；禁止为了让数字变小而删除用例、跳过失败或削弱断言。

## 每次改动怎么做

1. 读 `MELO_OVERVIEW.md`、`AGENTS.md`、`CLAUDE.md` 和实际 diff，确认本任务文件及其他线程 WIP。
2. 先看计划：`npm run test:plan -- --files <本任务文件...>`。`npm run scope -- <文件...>` 显示同一选组策略，并补充功能、跨端和隐式依赖说明。
3. 运行 `npm test -- --files <本任务文件...>`。必须列出本任务全部运行时、测试、生成物、配置及文档改动，不可只挑修改过的测试文件冒充功能验收。新增 / 改名 / 删除也须包含。
4. 一批功能集成完成后，用 `npm test -- --base <该批开始前的提交>` 验证完整改动范围，或用无参数 `npm test` 检查共享工作树。不要每次改字号、说明文字或生成文档都重跑产品全量。
5. 记录基准、选组原因、实际通过 / 失败 / 跳过及未验证层级；同步总览、短进度与 `npm run progress:codex`。日常、真实模型、实体设备和完整发布验收分别报告。

| 命令 | 含义 |
| --- | --- |
| `npm run test:plan -- --files ...` | 只生成任务计划，不执行测试 |
| `npm test -- --files ...` | 明确任务范围；不表示整个共享树已验收 |
| `npm test` | HEAD 到工作树的全部暂存 / 未暂存 / 未跟踪 / 删除；干净树检查最近提交 |
| `npm test -- --base <ref>` | 指定 ref 到当前工作树，包含其他线程与未跟踪改动 |
| `npm test -- --all` | 明确强制完整日常检查；不安装应用 |
| `npm run test:unit` | 自动发现全部 JS；隔离 `MELO_HOME` |
| `npm run test:ios` | 独立运行全部手机 JS、资源一致性与 Swift |
| `python3 ios/scripts/test.py --suite EditDraftTests` | 单独调试指定 Swift 组；可重复 `--suite`；仍做手机 JS 与资源检查 |
| `npm run test:full` / `npm run verify:red-green` | 完整发布检查：全 JS、浏览器、手机检查、语法、打包、安装、启动与运行态冒烟 |

`--files`、`--base`、`--all` 互斥，未知选项、缺少参数、仓库外路径或无效基准直接失败。没有自动挑选“属于当前代理”的 Git 改动；共享文件混合修改时任务检查仍基于磁盘上的实际组合内容。需要精确归属时用隔离副本或工作树，并明确证据边界。

## 选择范围的规则

| 改动 | 默认检查 |
| --- | --- |
| 注册的纯说明文档 | 改动 Markdown 的相对链接 |
| 架构地图 / 注释、scope 等开发元数据 | 脚本测试与地图一致性，无产品浏览器 / Swift |
| 局部桌面页面 | 所属功能的整个 UI 测试组，加反向依赖、源码读取与桥接测试；公共 UI / 设置触发设置浏览器 |
| 桌面独有 CSS | 所属界面组；不因在 desktop-ui 目录就触发手机 |
| 后端普通功能 | 整个所属功能组，加反向调用、动态 import、源码读取、共享契约相关测试 |
| 手机场景资源 | JS 桥接 / 渲染与 manifest；不编译无关 Swift |
| Swift 文件 | 按真实编译输入选 suite；共享契约补对应测试；未纳入独立编译组的原生源码扩大 Swift |
| Android 本地 `.kt` / 资源 `.xml` | JVM、Lint、Debug；Manifest、构建配置、Core 或混合平台集成仍跑 Release/R8 |
| 仅现有 `.test.js` | 改动测试文件及语法；不能用它替代同时发生的产品改动 |
| 状态持久化、权限、执行核心、共享协议、依赖 / 构建、测试门禁自身 | 完整日常 |
| 未知路径、删除 / 重命名、无法确认依赖、地图过期或登记不完整 | 明确说明原因并扩大；预检失败须修复，不能关掉检查 |

功能地图不是仅按目录取相邻测试。执行器使用当前源码构建反向依赖，补静态 import / re-export、字面量动态 import、URL 模块引用、生成器、服务映射、原生桥及源码读取边。整功能组保留集成覆盖；无法确定目标的动态读取方保守加入，不假装它没有依赖。

具体策略入口：`scripts/test-plan.js`、`scripts/test-impact.js`。依赖登记入口：`architecture/module-annotations.json`，生成结果 `architecture/modules.json`；增加路由、文件、跨功能依赖或源码读取测试后运行 `npm run generate:module-map`。新测试仍由 `scripts/test-discovery.js` 自动发现。不要把 `scope.focused` 提示或测试文件名猜测当成完整选择器。

纯说明文档采用明确名单及 `docs/**/*.md` / `docs/handoffs/**`；`desktop-ui/features/README.md` 已登记。运行时技能、人设、夹具 Markdown 和任意 JSON 不因此豁免。

## 执行顺序与去重

日常依次运行：语法 → 文档链接 → 生成器 / 地图预检 → 手机资源 manifest → 剩余 JS → 相关设置浏览器 → 选中的 Swift。失败立即停止；资源过期应在昂贵测试之前报错。

每项检查只有一个执行阶段：生成器测试从后续 JS 清单移除；两份 iOS JS 在 JS 阶段执行；manifest 在预检执行；后续 Python 只执行 Swift。发布流程仅在全部 JS 已成功时省去 Python 的重复 JS，失败时仍完整执行手机阶段。独立 `test:ios` 默认不省略任何检查。

Swift suite 的输入列表只在 `ios/scripts/test.py` 定义。`--list-suites` 返回实际编译输入，不运行测试、不调用编译器；JS 选择器读取该清单，不维护第二份容易过期的列表。显式的 `--skip-js` / `--skip-renderer` 只供已负责这些阶段的组合门禁使用，不能拿来回避失败。

## 缓存和扩大检查的边界

完整日志保存在 `.tmp/test-runs/run-*/`，`report.json` 列出每阶段命令、耗时、退出码与日志路径。终端只显示阶段结果和失败日志尾部，失败完整输出仍保留；不缓存通过结果、不自动重试、不吞掉非零退出码。

保留 Swift 编译缓存；键含源码、测试、编译命令、工具链、SDK 路径 / build version 与机器架构。缓存损坏重编译；编译和测试失败仍使检查失败。每次仍真实执行选定测试，不缓存“通过”结果。没有上次绿色就自动跳过的机制，也不将不同工作树、依赖或环境的旧结果算作本次成功。

默认日常按任务风险选择。只有公共 / 未知边界、检测基础设施改动或明确的集成 / 发布需要才扩大；局部失败后先复测受影响范围，再做该批集成，不无条件重新跑整个产品。完整发布 gate 保留，日常成功不能称已打包安装或真机验收。

## 修改检测系统本身的验收

必须覆盖已知 UI → 文件安全漏选、跨层反向调用、生成与源码读取边、共享契约、平台区分、Swift 输入、新文件 / 删除 / 重命名、未知依赖 / 失效地图、任务范围与共享树范围、失败停止、每个测试只执行一次、独立手机 gate 不缩水。先跑工具专项，再做一次完整日常校准；后续只有新改动或失败才重复必要层级。

审计背景：[选组与重复执行审计](test-selection-audit-20261020.md)。实施证据：[2026-10-20 实施与验证](test-selection-implementation-20261020.md)。

## CI gates（GitHub #9，2026-10-20）

| Gate | 环境与执行 | 证据边界 |
| --- | --- | --- |
| File safety | Linux / macOS，Node 22.22.2，本机编译 dirfd addon；全部 safety 与文件工具回归 | 两个平台的真实临时文件系统；不安装产品 |
| Linux Node / HTTP / Browser | 新 checkout；Node、Python、Ruby、FFmpeg/ffprobe、ripgrep、CJK 字体、UTF-8；固定 Playwright 版本的 Chromium；带校验的内置 embedding 模型；全部发现的 JS 测试 | 模型/外网多数使用夹具；内置 embedding 是实际本地推理；不依赖开发机 Chrome 路径 |
| macOS Swift | 全部 Swift 套件、共用渲染、JavaScriptCore Replay、unsigned iOS Simulator App 编译、native shell shutdown | 编译及本机夹具，不等于 iPhone 设备/账号验收 |
| Android | Core 源码与 bundle、JVM、Lint、Debug/R8、Android 16 Emulator | 与共享 Core 变更联动；不等于 Fold6 真机通过 |

主线定义在 `.github/workflows/verification.yml`、`.github/workflows/file-safety.yml`；Android 定义在 `.github/workflows/android.yml`。环境准备与 preflight 单列：缺依赖先修环境，产品断言失败保留红色；不增加 continue-on-error、不对失败测试静默重试。所有 job 输出日志保留 7 天。平台专用测试只在对应系统运行，Linux 不执行的原生 Swift 壳测试在 macOS 明确运行。

跨平台 UI 夹具需要中文字体与 UTF-8 locale；流式补充回归由受控事件释放模型响应，不假定浏览器能在固定 4 秒内完成动作。工作流不运行 `test:full`，不打包安装桌面/iPhone 应用，也不访问用户账号与数据。

### CI 先计划、后准备环境（2026-10-21）

三个工作流先用 Node 运行 `scripts/ci-test-plan.js`，复用本地选择器。push 比较 `before..HEAD`，PR 使用目标基准的 merge-base，重命名两端均计入；缺基准、历史不全和手动运行保守扩大。纯文档只查链接，不安装 npm、浏览器、Java 或启动 macOS / Android 重型任务。工作流本身仍产生状态，保留原 required job 名称；计划失败会使对应 gate 失败。

局部 UI 保留整个功能 UI 测试组，再通过真实依赖补选后端测试（包括文件安全）；后端仍保留整功能组。Swift 按真实编译输入选组，相关时才执行 JavaScriptCore Replay；原生 shell 测试仍在 macOS 执行。共享 / 未知 / 检测基础设施变更保留跨平台全检，File safety 的两个操作系统不去重。Android CI 仍保留 Release/R8 与模拟器。三个工作流均取消同分支过时运行。

Swift 只复用编译缓存和 DerivedData，按操作系统、架构、Xcode、源文件和依赖标识隔离；测试每次真实执行。当前选组对比（相同源码基线，JS 文件数，非耗时承诺）：customize/view.js 103 → 26，chat/controller.js 98 → 40，chat.css 80 → 22。证据见 `.tmp/test-cost-camera-20261021/selection-after.json`；专项和完整校准结果见 [本轮计划与验收](test-cost-camera-plan-20261021.md)。
