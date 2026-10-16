# Melo 工作协议（Working Protocol）

本文件是本仓库对 Claude 的强制工作规则，优先级高于默认行为。按以下规则执行；用户最新指示优先。

## 0. 跨线程共用总览

用户于 2026-10-15 指定：所有 Melo 线程先读 `MELO_OVERVIEW.md`，每个可验证步骤或改动后更新当前模块、线程交接、验证边界及下一步，再按下文维护短进度。正常接手先核对总览与实际 diff，记录缺失/过期/冲突时才定向补读相关线程；不再默认回读全部对话。总览人工维护，不由快照生成器覆盖。

## 1. 阶段性本地提交；仅用户要求时运行 git pp

用户于 2026-10-15 明确指定：**只有用户明确要求运行 git pp 时，才运行 git pp 或等价的 scripts/codex-review.sh。不得因工作时长、阶段完成、评级或历史流程自行触发。** 不自动启动 Codex CLI 审查，也不以 git push 替代此规则自行发布。

- 完成可验证阶段后本地提交；累计工作超过 60 分钟时选择稳定节点提交。
- 只按文件名暂存本阶段相关改动，保留其他线程 WIP。
- 测试、修复、文档和本地提交照常进行，不需要为常规修正反复请求批准。
- 用户要求 git pp 时，保留脚本的推送前质量门禁；C/D 阻止该次推送，但不阻止已授权范围内继续修复和测试。不得自行再次运行 git pp。
- 永远新建 commit，不 amend 已推送提交，不绕过验证或签名钩子。

### 新克隆的仓库如何启用 `git pp`

`git pp` 的 alias 存在 `.git/config`（不会进 commit），所以每个新 clone 要跑一次：

```bash
git config --local alias.pp '!./scripts/codex-review.sh'
```

脚本本身 (`scripts/codex-review.sh`) 已经入库，不用单独拷贝。前置依赖：`codex` CLI（`npm i -g @openai/codex`）并已登录。

## 2. PROGRESS.md 作为状态看板

- 回归分层：`npm test` 现为按改动边界的日常检查；完整发布 gate 用 `npm run test:full` 或 `npm run verify:red-green`。报告须写明实际执行层级；日常通过不能称完整验收通过。规则和缓存边界见 `docs/testing-workflow.md`。

- 仓库根目录维护一份 `PROGRESS.md`，记录 **意图与上下文**——不是 changelog（changelog 是 `git log` 的活，codex review 看 diff 就能拿到代码事实）。
- 每次完成一个可验证的步骤（测试通过、bug 修复、feature 落地、重要重构）就追加一条。**写每一句话之前先问：这条 codex 看 git diff 能不能自己拿到？** 能拿到的就删掉，只留 diff 看不到的——意图、用户拍板、评级反馈、流程偏离、谁做的（Claude / Codex / 用户手改）。
- 标准格式（**必填 ≤ 8 行 + 选填实现摘要 ≤ 4 行**，单条不超过 12 行）：
  ```
  ## YYYY-MM-DD — <一句话标题，why-focused>

  <段 1：意图 / 解决的问题（≤ 3 行）>
  <段 2：用户拍板 / 评级反馈 / 流程偏离（≤ 3 行，没就跳过）>

  [可选 ≤ 4 行：实现摘要——只写 diff 看不出的设计承诺（如 "不是硬依赖"、"上游单点决策"、"byte-for-byte 移植"），不要罗列文件路径 / 字面量 / enum 值 / 行号统计]

  本地 `npm test` GREEN。Final commit: `<hash>`.
  ```
- **反啰嗦黑名单**——下面这些不要写进 PROGRESS.md，因为 codex 看 diff 就能拿到，重复只会稀释重点：
  - 文件路径列表 / `--stat` 输出（"12 文件、+1066 / −92"）
  - 代码字面量与常量值（`MIN_USEFUL_CHARS = 120` / `READER_ORDER = [...]` / `via: 'external:...'`）
  - enum 新增的具体名字（diff 看得到）
  - "X 文件改了什么"按层 bullet 罗列（让 codex 直接读 diff，不要帮它二次复述）
- `PROGRESS.md` 是时间轴日志，不做分章节结构化——按时间倒序从顶部追加最新条目，旧的往下压。
- 每次更新 `PROGRESS.md` 后运行 `npm run progress:codex`，自动刷新仓库根目录的 `codex.md`。`codex.md` 是给 Claude / Codex 快速接续用的完整进度快照，包含 git 状态、最近提交和完整 `PROGRESS.md` 时间线。
- **`codex.md` 是本地派生产物，已加入 `.gitignore` 不入版本管理**——任何提交进 git 的快照都至少落后一个 commit（它无法引用自己所在的 commit hash），曾被 review 工具误判为"快照陈旧"。新会话开局先跑一次 `npm run progress:codex` 即可拿到最新视图。

## 3. 自动摘要压缩阈值

- 每次要往 `PROGRESS.md` 追加条目前，先检查当前文件长度：
  - **超过 500 行**触发自动压缩。
- 压缩步骤：
  1. 把最旧的 70% 条目合并写成一节「## 归档摘要（YYYY-MM-DD 之前）」，每条保留：标题 + 1 句话结论 + commit hash。
  2. 删掉被归档的原始条目。
  3. 保留最近 30% 的详细条目不动，再把新条目追加进去。
- 压缩是 **幂等** 的——每次触发都只压旧条目，最新的永远是完整格式。
- 压缩后要和正文改动一起进入同一个 commit，message 前缀加 `progress: `。

## 4. 按需质量评估

- EVALUATION.md 保留质量评分标准，供自查及用户明确要求的 git pp 使用。
- 自动测试不等于 Codex CLI 审查；正常开发继续运行适当测试。
- C/D 发现应核对证据、修复并补齐验证；用户已授权的范围内自主推进，不自动停下要求用户再次确认。
- 只有实质超出用户授权或需要新的产品决定时才询问；报告实际风险及未验证边界。
- 用户要求 git pp 时，脚本仍只允许 S/A/B 推送；推送失败或被门禁阻止不得宣称已发布。

## 5. 抽服务 = byte-for-byte 移植，不允许顺手"简化"

抽取代码到新模块时（例如 desktopStore → src/services/* 这类 refactor），**第一刀必须是逐字节移植，不改逻辑**。包括但不限于：

- **不要**把多行函数压成一行
- **不要**重命名内部变量（`existingMediaKeys` → `seenKeys` 这种顺手改也禁止）
- **不要**简化看起来"重复"的代码（intro-text 回退、嵌套 `audio_attachment` 包装、`"Additional attachments:"` 标签等）
- **不要**省略看起来无用的注释或空行
- **不要**修改 regex（特别是 `\b`、`\d`、`?:` 之类的元字符——一个 `\b` 丢失就能造成生产回归）

**为什么：** Phase 7d-1 抽 `messageBuilder` 时，我把原 `IMAGE_FOLLOW_UP_PATTERN` 里的 `\b(?:image|photo|...)\b` 顺手简化成了无 `\b` 版本，结果 `photography` 这类词被误匹配，会把 4 轮内的旧图错误塞回 prompt（错误上下文 + 成本回归 + 隐私风险）。Codex review 抓到了，但理论上完全可能漏过。同一次抽取还隐藏过 4 处 `messageToModelContent` 行为差异（intro 文案、attachment 嵌套结构、标签、collapse 逻辑），自查时发现并回退。

**流程：**

1. **Step 1 — 移植**：纯粹 cut + paste，按需调整 import 路径，**绝不改一个字符的代码本身**。这一步的 commit message 必须明示 "byte-for-byte port"，方便 review 时只看 import 变化。
2. **Step 2 — 写测试**：基于移植版本写单元测试。如果发现某个边界没法用现有 API 覆盖，**记录下来但不要改代码**——抽取阶段的覆盖缺口是 Step 3 之后的事。
3. **Step 3 — 删原位 + 接好上下游**：删 desktopStore 里被搬走的代码，加 import / re-export 让公共 API 不变。
4. **Step 4 — 跑回归 + 本地提交**：所有测试绿才算移植成功。
5. **Step 5（可选，独立 commit）— 简化**：移植成功后才能动逻辑，且每条改动都要单独写测试覆盖。这一步的 commit message 必须独立，写清"基于已绿测试，简化 X 为 Y"，便于回滚。

**Codex review 的角色：** review prompt 已经强制走完整 `git show` 每个 commit。把"逐字节移植"作为约定后，review 看到的差异越少越好——任何 `-` 行 + `+` 行的代码逻辑差（不是 path/import 调整）都应被高亮为可疑。

## 6. 后台任务 / 异步执行：调度时捕获 env，执行时禁止读 env

任何会跨越 `await` / 微任务 / `Promise.then` / `setTimeout` 等异步边界的函数，**必须在调度时（或函数入口）一次性捕获**所有依赖 `process.env` / `getMeloHome()` / 全局可变状态的派生值（路径、home id、user 上下文等），然后通过参数 / 闭包传给后续异步阶段。**异步执行体内部不允许再读 `process.env.MELO_HOME` 或同类全局动态值**。

**为什么：** Phase 7d-5α-A1 期间连续撞了 4 次同类 bug 的不同 layer：路径常量在 module load 时被冻结 → flag 单例跨 home 串读 → cache 用 thread-id 单 key 跨 home 串读 → **背景 prime 任务在 microtask 里重新读 `getMeloHome()`，把 home A 的 snapshot 写到 home B 的目录**。前 3 个 layer 的修复都基于 "lazy 解析"，第 4 个 layer 暴露出 lazy 解析在异步边界**反而是错的**——本来就需要的就是"绑定到调度时的 env"。

**典型反模式 vs 正确模式：**

```js
// ❌ 反模式：lazy 路径解析在异步执行体内
function queueBackgroundJob(state) {
  Promise.resolve().then(async () => {
    // 当 microtask 执行时，process.env 可能已经变了！
    const path = join(getMeloHome(), 'something');  
    await writeFile(path, payload);
  });
}

// ✅ 正确模式：调度时一次性捕获，闭包传递
function queueBackgroundJob(state) {
  const home = getMeloHome();                 // capture HERE
  const path = join(home, 'something');       // resolve HERE
  Promise.resolve().then(async () => {
    await writeFile(path, payload);            // use captured value
  });
}
```

对 factory-bound helper 的处理方式相同：调度时**用字面量字符串而不是 `() => getMeloHome()` 形式**绑定 factory，把绑定好的 helper 实例传进异步任务。

**Codex review 关注点：** 任何 commit 引入或修改 `Promise.then` / `async function` / `setTimeout` 调用且函数体内部出现 `getMeloHome()` / `process.env.*` 都应被高亮为潜在 §6 违规。

## 其他既有规则（不在本文件但仍生效）

- 用户于 2026-10-08 指定：每次手机端“对齐”先读 `docs/mobile-alignment-workflow.md`，按 `MELO_OVERVIEW.md` 核对 `melo主线`、`设计 Melo`、`melo ui` 三条线程交接及**实际代码 diff**；总览缺失/过期/冲突时定向补读近期相关轮次，再写计划，按依赖顺序执行。功能、接口、Bug 修复和 UI/特效必须一起跟进并验收；不以线程总结、按钮或编译成功代替功能完成。

- `~/.claude/projects/-Users-mortred-Desktop-melo/memory/MEMORY.md` 中的 Melo 六条硬性规则继续适用（方案评分先行、红绿灯检测、功能隔离、UI 对齐、设计语言统一、配置保留）。
- 所有总结用中文输出。
