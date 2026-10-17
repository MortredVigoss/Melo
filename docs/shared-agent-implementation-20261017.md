# Shared Agent Core 实施计划

用户已明确选择方案 A：同源本机 JavaScript Core，手机独立运行。规格为 `docs/specs/2026-10-17-shared-agent-search-design.md`；审查基线及待修项见 `docs/agent-core-audit-20261017.md`。按以下顺序执行，不再为已认可路线重复确认。

1. 修复前置边界：Skill Match Cache 使用完整定义 / 消息 / 选项身份和显式执行 namespace，只缓存 ID；三端在副作用前检查整轮 call ID。用审查反例先 RED 再 GREEN，保留既有权限与取消行为。
2. Runtime spike：同一安装包内 bundle 在 Node、Android JavaScriptEngine、iOS JavaScriptCore 执行同一 JSON 协议。验证 support / feature、Service 生命周期、异常、取消和多 Chat 隔离；不支持时明确报告，不回退到第二份业务 Core。
3. 逐字抽取：将现有纯 URL / request policy / search route / Skill 定义迁至 portable shared 模块；旧入口兼容 re-export / Host 注入。首个抽取提交保持原行为，生成 bundle / manifest 并用原 Fixtures 验证。
4. 统一决策与 Loop：以共用 Core 管理本轮 Tool 许可、调用身份、Progress / Completion、累计用量 / deadline、Context 配额和输出；Host 仅提供模型 / HTTP / 存储 / OS effect。先接真实 Node / Android Chat 路径，再补 iOS 相同入口。
5. Search 接线：经验证的 Hosted Search 或用户已配置 HTTP Backend 优先；Playwright 为显式 browser fallback，检索失败不静默占屏。共享 Skill 策略、来源 / freshness / 错误回执；不擅自购买供应商或迁移凭证。
6. 分层验收与交付：同源 bundle hash / 三端 Conformance；Node / Kotlin / Swift 离线测试；Android Lint / Debug / R8 / Emulator 与 Fold6 folded / unfolded；iOS 必须有 macOS 编译和原生验收证据。当前 Windows 无 macOS 执行器，若仍不可用，完成可验证工作并保留该外部验收边界，不能代称三端全通过。

每个稳定阶段本地提交并更新总览 / PROGRESS；仅暂存本阶段文件。全程保留聊天、账号、凭证和设备原生保护；不运行 git pp / CLI review，不推送。开发继续用 Fixture，沿用既有连接与凭证授权，不新增 API Key。
