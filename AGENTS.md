# Melo 跨线程接手规则（Codex 入口）

用户于 2026-10-27 决定：取消"Claude 开发、Codex 审计"的固定分工，任何被授权的 AI 都按同一标准修改 Melo。全部开发规范统一在根目录 [MELO_DEVELOPMENT_STANDARD.md](MELO_DEVELOPMENT_STANDARD.md)，本文件只是入口。

- 做任何修改前先完整读一遍该规范；再按规范 §10 的顺序读 `MELO_OVERVIEW.md`、核对 `git status --short` 与 `npm run scope -- <改动文件>`。
- 修改前写执行链路与审计边界（规范 §3），修改中守硬性规则（§4），修改后按两档节奏跑回归并覆盖边界场景（§5），合并前附变更记录与证据（§6）；缺一项不得合并。
- 只有用户明确要求才运行 `git pp`、推送或覆盖安装（§9）。共享树只按文件名暂存自己的改动（§1、§10）。
- 检测规则细节见 [docs/testing-workflow.md](docs/testing-workflow.md)；提交末尾署名所用 AI。
