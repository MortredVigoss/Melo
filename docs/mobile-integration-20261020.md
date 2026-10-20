# Android / Shared Core Integration（2026-10-20）

状态：WIP / Draft PR 待回归，不可据此直接合并或发布。

## 基线与范围

- 最新主线：`8772e92ddb9e903d1d99820b88299d16d5573b72`
- 最新 Mobile：`2d36dbd43befff88d1cb5f6fe95b48a83f0f4f9b`
- Integration：`codex/integrate-mobile-core-20261020`
- 用户批准：独立分支整合，保留两边功能与修复，验证后 PR 回到共同主线，再清理被包含的阶段分支。

## 整合原则

保留新主线的 UI P2 / 保存回执恢复、能力授权、历史图片与统一检测架构；接入 Android 的本机 Core、Research Trace、Context 回读、布局/版本 Cache 与 Task Eval。公共 Loop 继续使用新主线的共享 Reducer、预算和 Completion Receipt；Android OS Effects 留在 Host。

Search 的最新主线纯函数体迁入 portable factory，Node 保持原导出和已有 Tool Schema，显式 HTTP Search 通过兼容 Adapter 调用。保留 Main 自然推荐能力，也保留 Mobile 显式重试、拒绝占屏和“不联网”的限制；不因 Tool Definitions 稳定就允许执行被计划禁止的屏幕动作。

所有冲突与生成资源都在本分支处理；Scene、JS Core、iOS Project、Locale、Module Map 重新生成。新的 Android Stage 接入主线 scope-aware Test Planner，不覆盖回旧选组器。CI 日志管道使用 Bash pipefail。

## 当前验证

- 初轮 Core / Routing / Function / Gate 238：234 pass / 4 fail；三项限制继承与一项超时边界已修复。
- 第二轮同范围：240 pass / 0 fail。
- Gate / Generator 专项：24 pass / 0 fail（后续更新仍须最终复验）。
- Android 本机 JVM / Lint / Debug / R8 Release 构建通过，详细数量待最终报告。
- 初轮全部 JS：4363 pass / 6 fail / 13 skipped；含 Project Memory 并发记录缺失与待整合 Routing。日志 `.tmp/integration-all-js-first.log`，不作为绿色验收。
- 最新主线上游 CI 已存在失败：Locale 生成物过期、VoiceInputTests 固定 100ms 等待，以及 Mobile CI 的 KSP Plugin 解析失败。原始日志保存在 `.tmp/integration-baseline-ci-*.log`；本分支不能把这些失败忽略或静默重试为成功。

后续：定位并发记录缺失，完成最终 Node / Browser、Android Runtime 和 macOS Swift / 跨引擎 Eval；CI / 未验证边界在 PR 明确列出。尚未操作用户设备或真实模型服务。

## 2026-10-21 定位与修正

并行运行四份独立 Memory HTTP Fixture 时，其中一份稳定观测到旧 Worker 初始快照把七条有效记录设为 `quarantined/sourceDeleted`。修正为在 Memory 写事务内重新读取当前 manifest 的 Project/Chat 身份，再执行首次迁移及删除来源隔离；索引投影仍可用原快照，下一轮追上最新 Revision。新增确定性回归覆盖新来源不误隔离、真实删除不复活、清单缺失不修改记录。

Artifact Fixture 改走 State Store 的保存入口，避免直接改 state.json 后仍命中常驻快照。Memory 并发 Fixture 保留原进度/数据断言，通过 Atomics 通知等待独立 Worker 的实际进度。授权卡测试以注入 Clock 控制预算到期，保留 BUDGET_EXHAUSTED 和卡片关闭断言；不把机器调度耗时混入 20ms 的测试前置条件。

PR：[GitHub #15](https://github.com/MortredVigoss/Melo/pull/15)。初轮 Integration CI：Linux Node/HTTP/Browser 和 Linux/macOS File Safety 已通过；macOS 尚未全绿，本分支仍处于验证阶段。
