# Android / Shared Core Integration（2026-10-20）

状态：源码整合与本机回归完成；远端最终检查与合并状态以 [PR #15](https://github.com/MortredVigoss/Melo/pull/15) 为准。只有最新 Head 的所有 CI 通过且主线未发生未验证变化，才允许合并。本文记录源码验证，不代表产品发布。

## 基线与范围

- 最新主线：`8772e92ddb9e903d1d99820b88299d16d5573b72`
- 最新 Mobile：`2d36dbd43befff88d1cb5f6fe95b48a83f0f4f9b`
- Integration：`codex/integrate-mobile-core-20261020`
- 用户批准：独立分支整合，保留两边功能与修复，验证后 PR 回到共同主线，再清理被包含的阶段分支。

## 整合原则

保留新主线的 UI P2 / 保存回执恢复、能力授权、历史图片与统一检测架构；接入 Android 的本机 Core、Research Trace、Context 回读、布局/版本 Cache 与 Task Eval。公共 Loop 继续使用新主线的共享 Reducer、预算和 Completion Receipt；Android OS Effects 留在 Host。

Search 的最新主线纯函数体迁入 portable factory，Node 保持原导出和已有 Tool Schema，显式 HTTP Search 通过兼容 Adapter 调用。保留 Main 自然推荐能力，也保留 Mobile 显式重试、拒绝占屏和“不联网”的限制；不因 Tool Definitions 稳定就允许执行被计划禁止的屏幕动作。

所有冲突与生成资源都在本分支处理；Scene、JS Core、iOS Project、Locale、Module Map 重新生成。新的 Android Stage 接入主线 scope-aware Test Planner，不覆盖回旧选组器。CI 日志管道使用 Bash pipefail。

## 历史验证与问题定位

- 初轮 Core / Routing / Function / Gate 238：234 pass / 4 fail；三项限制继承与一项超时边界已修复。
- 第二轮同范围：240 pass / 0 fail。
- Gate / Generator 专项：24 pass / 0 fail（后续更新仍须最终复验）。
- Android 本机 JVM / Lint / Debug / R8 Release 构建通过，详细数量待最终报告。
- 初轮全部 JS：4363 pass / 6 fail / 13 skipped；含 Project Memory 并发记录缺失与待整合 Routing。日志 `.tmp/integration-all-js-first.log`，不作为绿色验收。
- 最新主线上游 CI 已存在失败：Locale 生成物过期、VoiceInputTests 固定 100ms 等待，以及 Mobile CI 的 KSP Plugin 解析失败。原始日志保存在 `.tmp/integration-baseline-ci-*.log`；本分支不能把这些失败忽略或静默重试为成功。

上述是整合过程中的历史结果，最终本机结果见下文；远端 CI 与合并状态见 PR。尚未操作用户设备或真实模型服务。

## 2026-10-21 定位与修正

并行运行四份独立 Memory HTTP Fixture 时，其中一份稳定观测到旧 Worker 初始快照把七条有效记录设为 `quarantined/sourceDeleted`。修正为在 Memory 写事务内重新读取当前 manifest 的 Project/Chat 身份，再执行首次迁移及删除来源隔离；索引投影仍可用原快照，下一轮追上最新 Revision。新增确定性回归覆盖新来源不误隔离、真实删除不复活、清单缺失不修改记录。

Artifact Fixture 改走 State Store 的保存入口，避免直接改 state.json 后仍命中常驻快照。Memory 并发 Fixture 保留原进度/数据断言，通过 Atomics 通知等待独立 Worker 的实际进度。授权卡测试以注入 Clock 控制预算到期，保留 BUDGET_EXHAUSTED 和卡片关闭断言；不把机器调度耗时混入 20ms 的测试前置条件。

PR：[GitHub #15](https://github.com/MortredVigoss/Melo/pull/15)。初轮 Integration CI：Linux Node/HTTP/Browser 和 Linux/macOS File Safety 已通过；macOS 尚未全绿，本分支仍处于验证阶段。

验证补充：Android Runtime 共 73 项，0 失败/跳过；Node 与 Android 的 11 个 Task Replay 结果逐项一致。Memory 修复后四份独立并行 HTTP 场景均通过。第三轮本机全 JS 只剩 Backup 排序 Fixture 的 5ms 墙钟假设失败，已改为给持久 Manifest 写入明确的先后时间，原排序断言保留；18 项 Backup 专项通过。CI 增加 unsigned iOS Simulator App 编译，不签名、不安装，避免只验 Swift 小套件而漏掉原生项目集成。

## 最终本机回归（2026-10-21）

源码验证点：`009134a5dad01833c5487ffbcac6fe61a946987a`。后续仅文档提交不改变产品源码；CI 对 PR 最新 Head 重新执行。基准为上述 master/Mobile 固定 SHA。

- 全部 JS：4385 tests，4372 pass、0 fail/cancelled、13 个明确的平台 skip；包含 Node、HTTP、真实本机 Chromium 与新增竞态回归。日志 `.tmp/integration-all-js-fourth.log`。
- Desktop 两项独立 Browser 验收通过：Settings Design（编辑、保存、失败恢复、窄屏等）及 Extra Fast（受控 HTTP Probe、分配、刷新及冲突恢复）。日志 `.tmp/integration-settings-design.log`、`.tmp/integration-extra-fast-browser.log`。
- Android：124 JVM tests，0 failure/error/skip；Lint、Debug、R8 Release 构建通过。Android 16 Emulator Runtime 73 tests，0 failure/error/skip。日志 `.tmp/integration-android-check.log`、`.tmp/integration-android-runtime-first.log`。
- Node / Android 确定性 Task Replay 11 个逐项一致；Core bundle SHA-256 `7bd1a5f1342758cc05398037baa8269c6e19d932ee6013c7010ae830e8cb7b03`。报告 `.tmp/integration-task-eval-node-android.json`。
- Memory / Derived Index / Artifact 28 tests 通过；四份独立并行 Memory HTTP Fixture 均通过，原始误隔离证据和修复后报告保留。报告 `.tmp/integration-memory-parallel-fixed.json`。
- 语法检查 1106 文件；后端依赖检查 441 modules、0 cycles；Core、Locale、Module Map、Sync/Loop Contract 与共享渲染生成物一致。

Linux CI 已在源码验证点通过；最终 macOS Swift、Node/JavaScriptCore Replay、unsigned iOS Simulator App 编译、macOS native lifecycle、双平台 File Safety 及远端 Android 的检查状态以 PR 最新 Head 为准。完整日常选组已用 `npm run test:plan -- --base 8772e92` 生成，因本机是 WSL，按平台拆分执行并由 macOS CI 补齐 Swift；不声称本机执行完整 `npm test -- --base` 成功。

边界：没有运行会安装桌面应用的完整发布 gate，没有签名/安装 iPhone，没有覆盖 Fold6；没有真实 LLM、Search API 或私人同步服务调用。Emulator / Fixture 和无签名编译不能代替真实账号、真机折叠/展开 UI、长后台及产品发布验收。

## 合并和分支清理约束

PR 使用 Merge Commit 保留两端 ancestry。合并前重新核对远端 master 和 PR Head；有新增未验证提交则先更新和回归。只有确认已被最终 master 包含的阶段分支才可删除，并以预期 SHA 防止误删其他线程刚推送的工作。清理结果在 PR / 本轮交付回执记录，不根据过期分支名推断可删。
