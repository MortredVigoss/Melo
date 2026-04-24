# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-24 21:30 — 首次远程推送 + 工作协议落盘

- 做了什么：配置 `origin = github.com/MortredVigoss/Melo`，把三个积压阶段压成 3 个 commit 全量推送到 `origin/master`（首次推送）。
- 为什么：CLAUDE.md §1 要求每个 ≥1h 工作块 push；之前一直没有 remote 所以积压了多个未推送的修复。
- 产出 / 提交哈希：
  - `5f128c6` fix(audio): transcription soft-fallback + codex env-backed mode
  - `8fb3cf9` fix(image): add instructions field required by /codex/responses
  - `f87c06c` chore: add CLAUDE.md working protocol + PROGRESS.md timeline

## 2026-04-24 20:00 — 修复图片生成 HTTP 400

- 做了什么：给 `src/images/codexImageEngine.js` 的请求体加上 `instructions` 字段，满足 `/codex/responses` 的硬性要求；加 debug log 定位到根因；加回归测试锁住字段。
- 为什么：之前所有画图请求都在 300–600ms 内被 400 拒掉，模型在对话里编造"等了 180 秒"并让用户保存 SVG——掩盖了真实失败。
- 产出 / 提交哈希：`8fb3cf9`

## 2026-04-24 19:00 — 修复 4 处历史测试失败

- 做了什么：`audioExtractor.js` 加 codex-env-fallback 和 whisper-unavailable 软降级；`openai.js` 去掉 audio_attachment 的 `[Audio attachment: …]` 占位符。
- 为什么：测试套件里 4 个 pre-existing failure 阻塞，与本次画图工作无关但同属 codex 路径。
- 产出 / 提交哈希：`5f128c6`（143/143 测试绿）

## 2026-04-24 14:00 — 初始化工作协议

- 做了什么：新建 `CLAUDE.md`（三条硬性规则：满 1h 提交并推送、`PROGRESS.md` 状态看板、2 页阈值自动摘要压缩）与本 `PROGRESS.md`。
- 为什么：建立跨会话的稳定工作节奏和可追溯性，防止长任务中丢失上下文。
- 产出 / 提交哈希：`f87c06c`
