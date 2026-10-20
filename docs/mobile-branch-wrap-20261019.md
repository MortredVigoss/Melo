# Mobile branch 收尾与主线交接（2026-10-19）

用户授权整理本地工作并 Push。交付目标是保存 `codex/mobile-use-features` 分支，不是把未通过完整 gate 的分支合并到主线；默认主线仍为 `origin/master@83654dd`，当前分支尚有 16 个上游提交未整合。

## 本次收尾

Node Host 使用原生 Function Calling 已有的单响应 32 调用上限，修复 Core 默认 8 与 Parser 32 不一致的 A05。生产 Loop + localhost HTTP Fixture 验证 9 / 32 个调用全部执行并按 call_id 回传，33 个在授权和效果前整体拒绝。保留权限、轮数、错误及停滞保护；Android 的单响应一调用策略不变。并行安全的 Tool 不保证执行起始顺序，测试核对每个调用恰好一次及有序关联的输出。

整仓检查还暴露两个本分支集成遗漏：daily CLI Fixture 没有跟进新增 Test Root、Shared Search Tool 缺少既有注册规范要求的 examples。Fixture 复用 Test Roots，Search 示例符合共享参数 Schema；对应既有测试通过。

## 验证与未关闭事项

- 最终专项 128 tests 通过，包括真实生产 Loop / 本地 HTTP Fixture、Parser / 协议、共享 Core、Search Adapter、Tool Registry 和 daily CLI。
- 4 个修改 JS 文件语法通过；共享 Core 11 模块 / 83,946 bytes 的生成一致性通过；diff whitespace 检查通过。
- 收尾初轮 `npm test`：3920 pass / 24 fail / 1 cancelled / 20 skipped。包含不可用的 macOS Chrome 路径、120s Browser Fixture timeout、本轮已修正的 3 项测试失败及既有问题，不能称日常 gate GREEN。
- 最终源码排除 `.browser.test.js` 后运行全部其余 JS：3921 pass / 9 fail / 0 cancelled / 20 skipped。六项文件身份校验仍失败；另有版本探测环境失败、Dreaming 并发及 Artifact 恢复 Fixture 失败。后二者待定向归因，不将其宣称已修复或全部属于环境。
- Android / Core 打包源码没有改动，本次未重建 APK、重跑 JVM / Emulator / Fold6；0.7.1 既有证据仍见 `android/verification.md`，不能当作本次重新验收。未使用真实服务凭证、操作手机、启动 git pp 或运行完整发布 gate。

[结构化证据](evidence/mobile-branch-wrap-20261019.json)。原始日志保留在本机 `.tmp/mobile-wrap-*.log`。

## 下一步

先从最新 `origin/master` 的独立分支处理主线问题，再按模块评审 Mobile / Shared Core 的整合。A05 已在本工作分支修复；A01 文件身份、A02 项目记忆、A03 Search 路由、A04 历史图片访问和测试跨平台问题仍见 [Backlog](repo-backlog-audit-20261019.md)。不把 Push 当成 Merge 或完整发布验收。
