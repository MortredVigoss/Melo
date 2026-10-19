# 回归检查分层

`npm test` 是日常检查；`npm run test:full`（也可用 `npm run verify:red-green`）是完整发布检查。日常通过不能写成完整发布验收通过。

| 命令 | 范围 |
| --- | --- |
| `npm test` | 按改动边界选择整组回归、语法检查和必要的浏览器 / iOS 检查；不安装应用 |
| `npm run test:plan` | 只打印基准、改动路径、选中测试文件和检查步骤 |
| `npm test -- --base origin/master` | 显式比较该 Git ref 到当前工作树，包含未跟踪文件 |
| `npm run test:unit` | 自动发现全部 JS 测试，隔离 MELO_HOME |
| `npm run test:full` | 全部 JS、设置和加速浏览器、19 组 Swift、共享渲染、语法、打包、安装、Desktop / Launchpad 启动和运行态冒烟 |

默认比较 HEAD 与工作树（包含暂存、未暂存、未跟踪及删除）；干净工作树检查最近一次提交。首次提交或 Git 范围不可用时扩大到完整日常检查，显式 `--base` 写错则直接报错。

选择规则刻意保守：只改桌面界面，运行全部桌面界面测试、浏览器旅程和 iOS 共用渲染校验；改 iOS 则执行协议测试。只改测试时执行改动测试，删除测试则回退全部 JS。涉及后端、同步协议、共享模块、构建、依赖或未知运行时路径，运行全部 JS 和集成检查。不靠静态 import 推测路由注册和生成文件的隐式依赖，也不自动隔离失败用例。新测试仍由目录自动发现。

纯说明文档（`docs/**/*.md`、`docs/handoffs/**`、根目录 `README.md` / `PROGRESS.md` / `CLAUDE.md` / `EVALUATION.md` / `MELO_OVERVIEW.md` / `AGENTS.md` / `CHANGELOG.md`、`ios/README.md`、`ios/VERIFICATION.md`，见 `scripts/test-plan.js` 的 `DOC_ONLY_FILES`）只运行 `scripts/check-doc-links.js` 检查改动文档的相对链接，不跑 JS、浏览器、Swift 或安装；运行时读取或可能被打包的 Markdown（技能、人设、夹具、`ios/Melo/` 下文件）仍按代码处理。`npm run scope -- <文件…>` 用功能地图 `architecture/modules.json` 解释选组、受影响功能与另一端，只报告，不改变上述规则。

Swift 缓存只省去重复编译，每次都执行每组测试。缓存键包含全部输入源码、测试代码、编译命令、Swift 工具链、SDK 路径和 build version、机器架构。源码或工具链变化会失效；缓存损坏重新编译；编译失败不发布产物；测试失败照常令检查失败。缓存位于 `.tmp/ios-test-cache`，可随时删除做冷启动复核。运行 `npm run test:ios` 可看到缓存命中数及耗时。

语法检查保留覆盖范围，并补充 `.mjs` / `.cjs`；最多同时启动 4 个检查进程，任何一个失败仍返回非零。发布检查没有删减测试或跳过安装启动。

2026-10-14 本机验证：界面单文件变化选中 51 / 349 个 JS 测试文件；后端变化选中全部 349 个。完整发布检查通过 3487 个 JS 测试，随后新增的日常 CLI 选组 / 失败传播测试单独通过。当前共享工作树 20 组 Swift 热缓存执行为 2.32 秒（整个 iOS 阶段 3.42 秒），语法阶段 8.05 秒；此前无缓存 19 组 Swift 阶段约 153 秒、语法约 31 秒。机器有并行模拟器和编译负载，不据此承诺总耗时比例。完整证据 `.tmp/test-model-settings-20261014/`。
