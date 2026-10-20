# GitHub Issue 索引（2026-10-19）

用户授权把 Repo 审查 Backlog 建为 GitHub Issues。创建前核对全部已有 Issue（空列表），固定最新 `master@b64fe54` 与已推送 Mobile `3614fbd`，发布 14 个 Issue，并通过远端回读核对 Open 状态、正文、Labels 和依赖链接。

原始审查的 15 项中，A05 已在 Mobile 修复，不再开未解决 Issue。A02 最新串行 HTTP / 冷重启回归通过，独立新 home 的项目创建、记忆保存、同步读取均为 200，降为历史 SQLite Lock 的并发复查。A13 不重复主线已交付的 UI P2，改跟踪剩余 Backend 边界；A10 承认最新 Chrome helper、路径覆盖与清理修复。

## 已创建

- A01 → [#1 [P1][A01] 修复 inode 复用导致的文件身份校验失效](https://github.com/MortredVigoss/Melo/issues/1)
- A02 → [#2 [P2][A02] 核实 Memory Book 的 SQLite Lock 并补齐并发回归](https://github.com/MortredVigoss/Melo/issues/2)
- A03 → [#3 [P1][A03] 让自然推荐请求获得正确的 Search 能力](https://github.com/MortredVigoss/Melo/issues/3)
- A04 → [#4 [P1][A04] 修复历史图片短期签名过期后的预览和下载](https://github.com/MortredVigoss/Melo/issues/4)
- A06 → [#5 [P2][A06] 统一 Loop 决策与 Tool 执行接口，保留平台 Adapter](https://github.com/MortredVigoss/Melo/issues/5)
- A07 → [#6 [P2][A07] 把任务完成条件与工具调用成功分开表达](https://github.com/MortredVigoss/Melo/issues/6)
- A08 → [#7 [P2][A08] 让 Android 使用统一的 Context Budget 与原文回读策略](https://github.com/MortredVigoss/Melo/issues/7)
- A09 → [#8 [P2][A09] 统一 Session Events 及模型 Context、UI 的投影](https://github.com/MortredVigoss/Melo/issues/8)
- A10 → [#9 [P2][A10] 建立跨平台 Test Gates 与 CI，收敛环境和 Fixture 差异](https://github.com/MortredVigoss/Melo/issues/9)
- A11 → [#10 [P2][A11] 为 Task Cache 增加布局与 App 版本的变体策略](https://github.com/MortredVigoss/Melo/issues/10)
- A12 → [#11 [P2][A12] 完成项目移动、删除和恢复的生命周期设计](https://github.com/MortredVigoss/Melo/issues/11)
- A13 → [#12 [P3][A13] 继续收敛 Backend 大模块边界，承接已完成的 UI Refactor](https://github.com/MortredVigoss/Melo/issues/12)
- A14 → [#13 [P2][A14] 建立大历史容量与首字等待基线，再决定分页边界](https://github.com/MortredVigoss/Melo/issues/13)
- A15 → [#14 [P2][A15] 从已知失败建立最小 Task Replay / Eval 集](https://github.com/MortredVigoss/Melo/issues/14)

## 顺序与边界

优先 #1 文件身份校验、#3 Search 路由、#4 历史图片访问；#2 先复查并发而不是假定当前保存必现失败。#5 负责 Core 收敛，#6 / #8 为完成语义与 Session Events，#14 Eval 排在这些能力之后。

最新主线隔离快照仅跑了两份专项测试：5 pass / 2 fail，其中项目记忆 HTTP 用例通过，目录删除重建后的 unlink/symlink 校验仍失败。没有完整 Gate、真实模型请求、设备操作或产品实现；建 Issue 不等于设计已批准实施。

[结构化发布证据](evidence/github-issues-published-20261019.json)。远端正文以每个 Issue 为准；原始审查仍保留固定 SHA 的历史事实。主线没有 Merge 或 Push。
