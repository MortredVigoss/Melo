# Melo 项目约定速查

> 速查文档 — 把今天散落在代码注释 / feedback 文件 / CLAUDE.md 各处的项目约定整理在一处。
> 维护规则：约定**真改变**时同步本文；常规 commit 不动这里。

---

## 1. 环境变量速查

### 运行时核心

| 变量 | 默认 | 用途 |
|---|---|---|
| `MELO_HOME` | `<project>/.tmp/melo-home-user`（`src/runtime/paths.js`；`~/.melo` 仅作旧路径兼容） | 用户状态根目录（`state.json`、`store.sqlite`、`dreams/`、`agents/` 等都住这里）。测试用 `mkdtempSync(...)` 隔离时**必须**在 import desktopStore.js 之前设。 |
| `MELO_DESKTOP_PORT` | `43127` | 默认 server 端口；Swift launcher 自动 rollover 时通过这个 env 通知 Node |

### 可选诊断 / 灰度开关

| 变量 | 行为 | 引入处 |
|---|---|---|
| `MELO_SEARCH_TRAIL_LOG=1` | 启用 3 个搜索工具（fetch_url / social_link / web_search）的 JSONL trail 日志（落 `$MELO_HOME/desktop/search-trail-log/YYYY-MM-DD.jsonl`）。**默认 off**——无生产开销 + 无隐私泄漏。 | Phase 2 (5787a98) |
| `MELO_MEMORY_TIERS_RECALL` | 启用分层 recall（attic+kg+memories）。`enabledTiers()` 默认 ON 之后保留为 backward-compat 灰度开关。 | Phase 7d-5α-A1 / 5-10 |
| `MELO_DEBUG_MEMORY=1` | 单行诊断 memory 链路（recall / dreams / promotion） | Phase E |
| `MELO_VERIFY_DEBUG=1` | 输出 chat verification 决策的单行诊断 | — |
| `MELO_DC_DEBUG=1` | （historical）Discord polling 详细日志。**现在默认全开了**，写到 `$MELO_HOME/desktop/discord-debug.log` 不再需要 env。 | — |

### 外部 reader 配置（src/web/externalReaders.js）

| 变量 | 用途 |
|---|---|
| `MELO_EXTERNAL_READERS_DIR` | 自定义 reader 二进制根目录。**覆盖**默认 `~/Desktop/melo/external-readers/`。lazy 解析（call-time），可运行时翻。 |
| `MELO_CRAWL4AI_BIN` | 显式指定 `crwl` 可执行文件路径（**短路**所有 candidate 查找） |
| `MELO_SCRAPLING_BIN` | 同上，scrapling |
| `MELO_CAMOUFOX_PYTHON` | 显式指定 camoufox 用的 python 解释器 |
| `MELO_DISABLE_EXTERNAL_WEB_READERS=1` | 完全禁用 external readers（fetch_url / social_link 走纯 native 路径） |
| `MELO_CRAWL4AI_OUTPUT` | crwl 输出格式（default `markdown-fit`） |
| `MELO_CRAWL4AI_BROWSER_CONFIG` / `_CRAWLER_CONFIG` | crawl4ai 额外 config 文件路径 |

### TTS 配置

| 变量 | 用途 |
|---|---|
| `MELO_WHISPER_API_KEY` / `MELO_WHISPER_BASE_URL` | OpenAI-compatible TTS 端点 + key（也用于 Whisper STT） |
| `MELO_API_KEY` / `OPENAI_API_KEY` | api-key mode 时回退 |
| `MELO_MOCK_RESPONSE` | verify-red-green 用的固定 mock 回复 |

---

## 2. 目录约定（host filesystem）

```
$HOME/
├── Applications/Melo.app                      ← Launchpad 主装位（PRIMARY_DEPLOY_TARGET）
├── Desktop/melo/                               ← Melo "工作区"根（项目 + 周边工具住一处）
│   ├── Melo.app                                  ← symlink → ~/Applications/Melo.app（Desktop 双击入口）
│   ├── Melo Desktop Project/                     ← 源码 repo
│   │   ├── .tmp/                                   ← gitignored，构建/测试 scratch
│   │   │   ├── desktop-build/Melo.app                ← `npm run build:desktop` 输出（2026-05-12 后从源树根搬到这）
│   │   │   ├── external-readers/                     ← 项目本地外部 reader 安装位（fallback，可选）
│   │   │   ├── swift-module-cache/
│   │   │   ├── melo-home-verify/                     ← `npm run verify:red-green` 用的 isolated MELO_HOME
│   │   │   └── desktop-app-debug.txt
│   │   └── (src/ desktop-ui/ scripts/ docs/ ...)
│   ├── external-readers/                         ← (可选) 跨项目共享的 reader 安装根。MELO_EXTERNAL_READERS_DIR 默认查这里。
│   │   ├── bin/{crwl,scrapling}                    ← 直装 layout
│   │   └── pipx/venvs/{crawl4ai,scrapling,camoufox}/bin/...   ← pipx layout
│   └── (其它 melo 相关文件夹)
└── (默认 MELO_HOME = .tmp/melo-home-user；.tmp/melo-home-verify 是测试用 isolated home)
```

**重要**：
- `~/Desktop/melo/Applications/Melo.app` **已删**（2026-05-12 a322aa7 清理），不要再装。
- Melo.app 只装 2 处：`~/Applications/Melo.app`（真装位）+ `~/Desktop/melo/Melo.app`（symlink）。

---

## 3. test:* npm scripts 和 gate 接入

**核心原则**（详见 user memory `feedback_test_must_reach_gate.md`）:

> **2026-10-17 更新（审计 A-12）**：下面「逐文件 allowlist 接入 verify-red-green」的描述已过时。现在 `npm test` = `scripts/verify-daily.js`：自动发现 `src/`、`desktop-ui/`、`mobile-sync/`、`scripts/`、`ios/Tests` 下所有 `*.test.js`（`scripts/test-discovery.js`），按改动范围计划（`scripts/test-plan.js`），不需要为新测试加 `package.json` script；隔离某个测试必须给原因和到期日。`npm run test:full` = `verify-red-green.js` 是发布 gate。以下段落保留作历史说明。

> 每加一个新 `*.test.js` 必须问"`verify-red-green` 在 push 前会跑它吗"。
> "测试存在但 gate 不跑" = silent skip = 等于没写。Codex C-gate 已经抓过两次同一类病。

### 当前的 npm scripts → 文件 glob

| Script | 跑什么 | 接入 verify-red-green |
|---|---|---|
| `test` | `verify-red-green.js`（heavy integration: desktop build + spawn mock connectors + smoke flow） | 是（是它自己） |
| `verify:red-green` | 同上 | 同 |
| `test:ui` | `desktop-ui/**/*.test.js` | ✓ step 0 |
| `test:scripts` | `scripts/**/*.test.js` | ✓ step 0 |
| `test:server-guard` | `src/serverGuard.test.js` | ✓ step 0 |
| `test:tts` | `src/services/tts/{nativeSayQueue,nativeStopEndpointsGuard}.test.js` | ✓ step 0 |
| `test:markdown-files` | `src/services/agent/markdownFiles.test.js` | ✓ step 0 |
| `test:external-readers` | `src/web/externalReaders.test.js` | ✓ step 0 |
| `test:tools-evidence-trail` | `src/tools/{executor,parser}.evidenceTrail.test.js` | ✓ step 0 |

**故意不在 gate 里**: `src/**/*.test.js` 大 glob——面积大，历史 flake (orchestratorAbort #14 在 3b96247 修好之前) 会污染 push 流程。所以 src/ 单测**逐文件 allowlist** 进 gate（如上述）。等所有已知 flake 清干净再决定要不要 widen 到通用 `src/**`。

### 加新测试时的 checklist

1. **路径决定 script**：放 `desktop-ui/` 进 `test:ui`、放 `scripts/` 进 `test:scripts`、放 `src/特定模块/` → 加专属 `test:<module>` script
2. **package.json** 加一行 npm script
3. **scripts/verify-red-green.js** step 0 追加一行 `runStep('<人话标题>', () => runCommand('npm', ['run', 'test:<x>']))`
4. **commit message 写明** "+ test:X script + 接入 verify-red-green.js step"（避免 Codex C-gate 抓"测试存在 gate 不跑"）

---

## 4. CLI 工具速查

### `scripts/inspect-search-trail.js`

Phase 2 instrumentation 配套：聚合查 `$MELO_HOME/desktop/search-trail-log/*.jsonl`。

```bash
node scripts/inspect-search-trail.js                                    # 今天全
node scripts/inspect-search-trail.js --day=2026-05-12                   # 特定日
node scripts/inspect-search-trail.js --days=7                          # 最近 7 天 merged
node scripts/inspect-search-trail.js --source=url-fetch                # 按 source 过
node scripts/inspect-search-trail.js --status=fail                     # 按状态过
node scripts/inspect-search-trail.js --raw --status=fail | jq .        # pipe 给 jq
```

**前置**：把 `MELO_SEARCH_TRAIL_LOG=1` 设到长期运行的 Melo 进程上（telegram polling / desktop app），跑 ≥1 天攒数据。

5 维聚合输出：by-source / tier×outcome / top fail reasons / top failing URLs / latency P50 by tier。

### `scripts/bench-memory.js`

记忆 retrieval bench（黄金集 + recall@k）。

```bash
npm run bench:memory                              # 跑黄金集 fixture
npm run bench:memory -- --no-embed                # 跳过 embedding 阶段
npm run bench:memory -- --threshold-recall5 0.6   # CI gate 阈值
```

### `git pp` (= `scripts/codex-review.sh`)

每仓库第一次启用：
```bash
git config --local alias.pp '!./scripts/codex-review.sh'
```

流程：pre-push Codex evaluation → 评级 C/D 阻 push → 推 → post-push 兜底 review。详见 CLAUDE.md §1 / §4。

---

## 5. 反模式：要避免的写法

### CLAUDE.md §6 — 异步边界的 env 冻结

**反模式**：
```js
const SOME_DIR = join(getMeloHome(), 'desktop');  // ← 模块加载冻结
function doStuff() {
  setTimeout(() => writeFile(SOME_DIR, ...), 100);   // 异步用了冻结值
}
```

**正确**（调度时捕获 + lazy）：
```js
function someDir() { return join(getMeloHome(), 'desktop'); }
function doStuff() {
  const path = someDir();                            // 入口一次性捕获
  setTimeout(() => writeFile(path, ...), 100);
}
```

G-6 audit (2026-05-11/12) 在 6 处文件清完了同一类病：
- `conversationIndex.js` / `skillRuns.js` / `webSearchTool.js` (debug log) / `voiceRewrite + 2 polling` / `media/cache.js` / `desktopStore.js` / `externalReaders.js`

跨 home 测试 pattern: `mkdtempSync(...) + process.env.MELO_HOME = ... + 调 production API + 断言 path 落在隔离 home 下`. 参考 `src/memory/conversationIndex.crossHome.test.js`.

### "测试存在但 gate 不跑"

见 §3。每加 `*.test.js` 走 checklist。

### 模块加载时的 require/import 副作用

`server.js` 是顶层 `await` 模块（重 boot side effects，state hydration / MCP init / lock 锁取）。**禁止从测试 import server.js**——会触发完整服务器启动。要测 server.js 内部逻辑，先把纯函数抽到 sibling module（参考 `src/serverGuard.js` 模式）。

---

## 6. 进一步阅读

- [`CLAUDE.md`](../CLAUDE.md) — 6 条硬性工作协议（commit/push 流程、PROGRESS 看板、压缩规则、D/C/B/A/S gate、byte-for-byte 移植、§6）
- [`PROGRESS.md`](../PROGRESS.md) — 时间倒序的开发日志，"做了什么 + 为什么"
- [`EVALUATION.md`](../EVALUATION.md) — git pp 评级规则
- [`docs/search-system-roadmap.md`](search-system-roadmap.md) — Phase G search-system 标准化 milestone + lessons-learned
- [`docs/search-task-rfc.md`](search-task-rfc.md) — SearchTask 统一契约设计
- `~/.claude/projects/.../memory/MEMORY.md` — Claude session memory 索引（user feedback patterns）
