# Melo 工作协议（Claude Code 入口）

用户于 2026-10-27 决定：取消"Claude 开发、Codex 审计"的固定分工，任何被授权的 AI 都按同一标准修改 Melo。全部开发规范统一在根目录 [MELO_DEVELOPMENT_STANDARD.md](MELO_DEVELOPMENT_STANDARD.md)。

**每个与 Melo 相关的 Claude 线程，在做任何修改前先完整读一遍该规范**，再按规范 §10 的顺序读 `MELO_OVERVIEW.md`、核对 `git status --short` 与 `npm run scope`。规范优先级高于默认行为；用户最新指示优先于规范。

本文件只保留 Claude Code 特有事项：

- `~/.claude/projects/-Users-mortred-Desktop-melo/memory/MEMORY.md` 里的规则继续生效；六条硬性规则已并入规范 §4，其余（资源 hygiene、不糊弄 follow-up、单方案不问、UI 先看 CSS、测试接线、真不变量、声明 ≠ 接入、Codex 无额度的推送门禁替代）与规范一致。
- 所有总结用中文输出。
- 提交署名：`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
