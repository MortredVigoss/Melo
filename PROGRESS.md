# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 300 行时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-05-04 — Hygiene fix #2：Playwright daemon 第二次爆系统（root cause + cross-process cleanup）

- 用户系统**第二次**被 Chrome helper 进程爆掉。Activity Monitor 截图：~20 个 Google Chrome Helper (GPU) 各占 38-40MB，物理 16GB 已使用 14.05GB + Swap 1.12GB。`ps aux | grep playwright` 显示 144 个 playwright 进程 + 10+ 不同 `playwright_chromiumdev_profile-*` user-data-dir + 20+ 个 `cliDaemon.js melo-(search|shared)` daemon process（PPID=1，从 5:58PM 累积到 8:57PM 都没死）。
- **Codex 第一次 hygiene fix (`506814d`) 不够**：closeSoon 15s idle-close + isConcurrencySafe=false + SWR dedup 只解决**within-session 累积**。但 Playwright CLI 用 `npx -y @playwright/cli` spawn **detached daemon**（PPID=1），daemon 自己独占一个 Chrome 实例。melo crash / SIGKILL / 多实例同时跑 / 进程被强制退出 → daemon 全部 orphan，永不死，每个还在持续 spawn Chrome → OOM。MEMORY 规则 "Codex 抓后台残留时不接受'用户视角无 bug'做停止理由"明确说要么继续修要么回退。
- 用户拍 root cause 修，按 "不糊弄 follow-up" 一次到位。两个互补 cleanup：
  - **#1 `cleanupStalePlaywrightDaemons()` at module load**（root cause fix）：每次 melo 冷启动 `pkill -f "cliDaemon\.js melo-(shared|search)$"` 杀掉**前一次 melo 留下的所有 orphan daemon**。anchored at `$` 避免误伤假设的 `cliDaemon.js melo-shared-extra`。idempotent — 重复跑无副作用。覆盖 crash / SIGKILL / multi-instance 全部历史残留。
  - **#2 process exit hooks**（graceful shutdown）：`process.once('SIGINT'/'SIGTERM'/'beforeExit')` 都接，Sync execSync pkill。SIGINT 退 130, SIGTERM 退 143（POSIX 标准）。覆盖 Ctrl-C / kill TERM / 自然退出 graceful 路径。SIGKILL / 硬 crash 没 signal delivery → 靠 #1 next start 兜底。
- **平台守卫**：`process.platform !== 'darwin' && !== 'linux'` skip。Windows 用 PowerShell `Get-Process | Stop-Process` 同款 — 但 melo 不支持 Windows 所以不写。
- **Trade-off 接受**：两个 melo 同时跑会互相 pkill 对方 daemon → 对方下一次 web_search 重新 spawn (~1s 冷启动)。比起系统爆 OOM，这个 cost 可接受。
- 测试加 2 contract case：① pin source 含 `function cleanupStalePlaywrightDaemons` + module-load 级调用 + 精确 pkill regex `cliDaemon\\.js melo-(shared|search)$`；② pin SIGINT/SIGTERM/beforeExit handlers + 正确 exit code (130/143)。这俩契约 pin 防 silent removal — review/refactor 时不能误删 cleanup machinery。
- 验证：`webSearchTool.helpers.test.js` **40/40 全绿**（前 38 + 2 新）；`src/**/*.test.js` **1963/1963 全绿**（前 1961 + 2 新；零既有回归）。`ps aux | grep cliDaemon` 在 cleanup 后从 144 进程降到 0-2 个（只剩当前 melo 进程的活跃 daemon）。
- **教训**：① 第一次 hygiene fix 只看 in-process 状态机（_browserOpen / _idleTimer / closeSoon），没考虑 cross-process 残留；② 任何启 detached subprocess 的代码必须配 cleanup 双保险（exit hook + startup cleanup）；③ exit hook 单独不够 — SIGKILL/crash 时 signal 不送达，必须靠 startup cleanup 兜底；④ MEMORY 中的"资源 hygiene 标准"不是抽象规则，是真血泪教训 — Codex 第一次 review hygiene fix 时**应该**抓到 cross-process 漏，但当时没单独测；以后写新 detached subprocess 必须 day 1 加 startup cleanup contract test，不等用户系统爆 2 次。

---

## 2026-05-04 — P1 round：扩展 inline-shell-out 工具检测（gnuplot/vim/ex/ed/sqlite3）

- Codex round 9 review (D #8 → A 收敛) 同时 P1 acknowledged 但 scope 之外的 inline-shell-out 工具维度盲区：`gnuplot -e 'system "rm"'` / `sqlite3 ":memory:" '.shell rm'` / `vim -es -c '!rm'` / `ex -c '!rm'` / `ed file <<< $'!rm\\n'` 全部 `risks=[]`。这一轮专门处理。
- 方案 P1-A：扩 SCRIPT_INTERPRETERS + sqlite3 单独 detection（最稳，复用现有 round 10 token-scan + heredoc/pipe-fed/stdin-redirect 框架）。
- **扩 `SCRIPT_INTERPRETERS` 加 8 个工具**：
  - `gnuplot`（`-e 'system "..."'` 直接 shell-out）
  - `vim` / `vi` / `nvim` / `view` / `rvim` / `rview`（`-c '!CMD'` shell escape）
  - `ex`（vim 兼容 ex 模式，同款 `-c '!CMD'`）
  - `ed`（`!CMD` shell escape via stdin/heredoc）
  - **trade-off**：`vim -c 'set syntax=js'` 等合法 vim option 也 flag — 接受 over-flag，agent 用 fileEdit (gated tool) 替代 vim/ex 编辑文件。
- **sqlite3 单独 detection**（不能 piggyback round 10 token-scan，sqlite3 用 `-cmd` 不是 `-c/-e`，且 dot-commands 在 positional 内）：
  - 用 token-scan 风格扫所有 sqlite3 basename token（不依赖 findWrappedCommand，避免 D fix #4 的 `timeout 5 sqlite3` POSITIONAL_VALUE_WRAPPERS 漏洞）
  - 任何 arg 含 `-cmd` / `-cmd<glued>` / `--cmd=<glued>` flag → flag
  - 任何 arg 含 `(?:^|[\n;])\s*\.(?:shell|system|exec)\b` regex 命中（dot-command at start of arg or after sqlite3 statement separator）→ flag
  - 同时 `sqlite3` 加进 SCRIPT_INTERPRETERS 让 round 10 pipe-fed/heredoc/stdin-redirect 自动 cover stdin 形态
- 闭环（手动 25 case 验证）：
  - ✅ gnuplot: `-e 'PROG'` / wrapper + `-e` / pipe-fed / heredoc 全 catch
  - ✅ vim/ex/ed: `-c '!CMD'` / `-c 'option'` / `nvim`/`view` / wrapper-aware / ed heredoc / ed pipe-fed 全 catch
  - ✅ sqlite3: `.shell`/`.system`/`.exec` / `-cmd` / `--cmd=` / pipe-fed / heredoc / wrapper / POSITIONAL_VALUE_WRAPPERS 全 catch
  - ✅ Regression: 全 awk/python/D #1-#8 attack 仍 catch
- false positive boundary：
  - `gnuplot script.gp` / `gnuplot --version` 不 flag（file source / probe）
  - `vim file.txt` / `nvim file.txt` 不 flag（bare interactive editor）
  - `sqlite3 db "SELECT * FROM users"` 不 flag（normal SQL）
  - `sqlite3 db ".tables"` / `".schema"` / `".dump"` 不 flag（non-shell-out dot-commands）
- accepted over-flag：
  - `vim -c 'set syntax=js' file` / `nvim -c 'colorscheme'` 等 vim option 设置（agent 用 fileEdit 替代）
  - `gnuplot -e 'plot sin(x)'` 任何 gnuplot inline（即使无 system() — 安全方向）
- 测试加 7 case：parser 6 case（① gnuplot `-e` 8 形态 catch；② gnuplot file/probe 3 形态 NOT；③ vim/ex/ed `-c`/heredoc/pipe-fed 10 形态 catch；④ vim/ex/ed bare 5 形态 NOT；⑤ sqlite3 inline 10 形态 catch（含 `.shell`/`.system`/`.exec`/`-cmd`/`-cmd<glued>`/`--cmd=`/pipe-fed/heredoc/wrapper/POSITIONAL_VALUE_WRAPPERS）；⑥ sqlite3 normal SQL 7 形态 NOT）；e2e 1 case（gnuplot/vim/sqlite3 4 形态 autoApprove + 文件保留）。
- 验证：`src/safety/bashRiskParser.test.js` **92/92 全绿**（前 86 + 6 新）；`src/tools/builtins/phase2d.bashTool.test.js` **112/112 全绿**（前 111 + 1 新）；`src/**/*.test.js` **1961/1961 全绿**（前 1954 + 7 新；零既有回归）。
- **Phase 2D round 14 awk + P1 inline-shell-out 工具系列总结**：① 9 轮 awk 维度 D fix 收敛到 A；② P1 圆 4 个新工具（gnuplot/vim/ex/ed/sqlite3）扩展。inline-code-execution detection 现覆盖 awk/python/node/ruby/perl/php/lua/expect/tclsh/groovy/R/julia/sbcl/clisp/iex/elixir/gnuplot/vim/ex/ed/sqlite3 共 21+ 工具。剩 known limit 待 codex review #10 确认。

---

## 2026-05-04 — Codex D #8：findCommandPositionIdx 16-iter cap fail-closed

- D fix #7 (`9fa5789`) push 后跑第八轮 codex review，Codex 评 **D**：`findCommandPositionIdx()` 用 `iter < 16` 防 wrapper-of-wrapper 病态，cap 到了**fail-open**（return -1，不 flag）。Codex 实测：`env env ... env $AWK 'PROG'` 15 层 catch、16+ 层全空，但 shell 仍逐层 exec 到 `$AWK 'PROG'`。深层 wrapper chain bypass。
- 单方案修：**fail-closed cap**。新加 sentinel `CMD_POSITION_CAP_EXHAUSTED = -2`。`findCommandPositionIdx` 在 cap 到达且 token 未耗尽（`iter >= 16 && i < tokens.length`）时返回 -2。caller 看到 sentinel 直接 push `code_execution: 'wrapper chain exceeds depth limit'`。
- 闭环（手动 9 case 验证）：
  - ✅ 15 层 env / 16 层 / 17 层 / 20 层 / 50 层 + `$AWK 'PROG'` 全 catch
  - ✅ 20 层 sudo + `$CMD 'PROG'` catch
  - ✅ 8+8 层 env+xargs mixed deep chain catch
  - ✅ 20 层 env + `awk -f script.awk`（即使是 -f 安全形态，深 wrapper 仍 over-flag — 接受）
- false positive 边界（pin 未误报）：
  - 浅 wrapper chain (1-15 层) 仍按现有 D fix #7 逻辑（expansion + positional → flag；无 positional → 不 flag）
  - `env env env $DIR`（3 层 + 无 positional）→ 不 flag ✓
  - `env env $AWK 'PROG'`（2 层 + expansion + positional）→ flag ✓ 通过 D fix #7 path
  - `cat $FILE` head-literal → 不 flag ✓
- accepted over-flag：16+ 层 wrapper-of-wrapper 命令一律 hard-reject。合法用法极罕见（`env env env...` 是 attack pattern）；过度 wrap 通常意味着混淆。
- 测试加 3 case：parser 2 case（① 8 形态深链 attack：15/16/17/20/50 层 env + 20 层 sudo + 8+8 mixed env+xargs + 20 层 env + 安全 -f；② 3 形态 cap-内 chain 仍正确解析 (2/5 层 + expansion+positional flag, 3 层无 positional 不 flag)）；e2e 1 case（17 层 + 25 层 env + `$AWK 'PROG'` autoApprove + 文件保留）。
- 验证：`src/safety/bashRiskParser.test.js` **86/86 全绿**（前 83 + 3 新含 sentinel side-effect pin）；`src/tools/builtins/phase2d.bashTool.test.js` **111/111 全绿**（前 110 + 1 新）；`src/**/*.test.js` **1954/1954 全绿**（前 1950 + 4 新；零既有回归）。
- **🎉 Codex 第九轮 review 评 A**（8 轮 D 之后首次过）：质量评级：A —— 方案正确，轻微边界建议；风险等级：低 —— 深链 over-flag 可接受。Codex ⚪ 非阻塞建议：pin "16+ 纯 wrapper 无 payload 也 over-flag" sentinel side-effect，已补 1 个 test。
- **教训**：① fail-open default in safety gate is wrong — always fail-closed when uncertainty hits a hard limit；② iter cap 不是设计完整保证，是 defensive measure，hit cap = 异常 → over-flag；③ Codex 8 轮 D 第一次没找新维度（cap fail-open 是同一 wrapper 维度的 boundary case） — D fix 系列**收敛**到 A；④ 简单 sentinel 模式比 throwing exception 干净 — caller 显式判断 -2 比 try/catch 清楚。
- **Phase 2D round 14 awk 维度共 9 轮 review 收敛史**：D #1-7 找到 7 个独立 bypass 维度（flag-form / wrapper-basename / positional-after-wrapper / wrapper-enum / wrapper-flag-chain / expansion-form basename / wrapped-position expansion），D #8 是 D #7 同维度的 boundary fail-open，D #9 (本轮 review) 评 A 收敛。剩 P1 = 其他 inline-shell-out 工具维度 (gnuplot/sqlite3/vim -c/ed)，独立 round 评估。

---

## 2026-05-04 — Codex D #7 + 方案 W'：wrapper-position expansion 闭环

- D fix #6 (`6c8b84c`) push 后跑第七轮 codex review，Codex 评 **D**：D fix #6 只检 `skipPreamble()` 后的**直接 head**，wrapper-后 expansion 漏：
  - `xargs $AWK 'BEGIN{system("rm")}'`
  - `env $AWK 'BEGIN{system("rm")}'`
  - `timeout 5 $AWK 'PROG'`
  - `env xargs $AWK 'PROG'`（wrapper-of-wrapper）
- 用户拍方案 **W'** = 扩展 D fix #6 到 wrapped command position。沿用 nuclear over-flag。
- 实现：
  - **恢复 `POSITIONAL_VALUE_WRAPPERS`** (D fix #5 删的 set，timeout/flock/tsp/ts) — 但**只用在新 walker 里**，不参与 awk-detection（awk 仍 nuclear）。
  - **新 helper `findCommandPositionIdx(tokens)`**: forward walk 跳过 leading wrapper chain（COMMAND_WRAPPERS / xargs / POSITIONAL_VALUE_WRAPPERS）+ 它们的 flags + value-takers + (positional value for timeout/flock)，返回第一个非 wrapper word token 的 index（即 wrapped command position）。16-iter cap 防 wrapper-of-wrapper 病态输入。
  - **D fix #6 check 替换**为：用 `findCommandPositionIdx` 找 command position，如果它是 expansion + 任何 later non-flag positional → flag。同时覆盖直接 head 和 wrapper 后位置。pattern 改名 `'expansion at command position + positional program'`（合并 D fix #6/#7）。
- 闭环（手动 22 case 验证）：
  - ✅ D #7: xargs/env/sudo/nohup/time/nice -n 10 + `$AWK 'PROG'` 全 catch
  - ✅ D #7 POSITIONAL_VALUE_WRAPPERS: `timeout 5 $AWK` / `flock /tmp/f $AWK` 全 catch
  - ✅ D #7 wrapper-of-wrapper: `env xargs $AWK 'PROG'` catch
  - ✅ D #7 + value-taker flag: `env -u VAR $AWK 'PROG'` catch（VALUE_TAKING_WRAPPER_FLAGS 跳过 -u VAR）
  - ✅ D #6 attacks 仍 catch（直接 head expansion）
  - ✅ D #5 wrapper-flag chain 仍 catch（独立 token-scan path）
- false positive boundary（pin 未误报）：
  - `xargs $DIR` / `env $VAR` / `timeout 5 $X` / `sudo $X`（wrapper + expansion，**无** positional after → no flag）
  - `cat $FILE program.txt` / `git commit -m "$MSG"`（head=literal，不是 wrapper → findCommandPositionIdx 返回 head idx，head not expansion → no flag）
  - `mkdir $DIR` / `cat $FILE` / `ls $HOME`（无 wrapper 无 positional 后续）
  - `awk -f script.awk` / `awk --version`（probe / file-source）
- accepted over-flag（continued nuclear）：
  - `xargs $EDITOR file.txt` / `env $BROWSER url` / `timeout 5 $TERM args`（wrapper + envvar invocation pattern）
- 测试加 4 case：parser 3 case（① 12 形态 wrapper-position expansion attack；② 7 形态 wrapper + expansion 无 positional 不误标；③ 5 形态 head-literal-with-expansion-arg 不触发 D fix #7）；e2e 1 case（4 形态 xargs/env/timeout/wrapper-of-wrapper autoApprove + 文件保留）。
- 验证：`src/safety/bashRiskParser.test.js` **83/83 全绿**（前 80 + 3 新）；`src/tools/builtins/phase2d.bashTool.test.js` **110/110 全绿**（前 109 + 1 新）；`src/**/*.test.js` **1950/1950 全绿**（前 1946 + 4 新；零既有回归）。
- **Codex 7 轮 D 累积总结**：每轮发现新维度盲区，修透 + 接受 over-flag → 6 个维度全闭环：① flag 形态 (`-e<glued>`/`--source=`)、② wrapper basename (xargs/find-exec)、③ positional-after-wrapper、④ wrapper enumeration (parallel/stdbuf/timeout)、⑤ wrapper-flag chain (timeout -s/-k 等) → nuclear、⑥ expansion-form basename ($AWK/${a}wk)、⑦ wrapped-position expansion (xargs $AWK)。剩 P1 = 其他 inline-shell-out 工具维度 (gnuplot/sqlite3/vim -c/ed)，留独立 round。
- **教训扩充**：① wrapper detection 7 轮被 D 后才彻底闭环，"按最稳的来" 在每轮都意味着继续扩 over-flag 而不是回退；② Codex review 是结构性必需；③ 同一个维度（expansion）可以横跨多个位置（head / wrapper-after），第一刀漏第二刀；④ POSITIONAL_VALUE_WRAPPERS 删了又恢复证明：删除工具仍可能在不同 detector 派得上用场，删除前考虑 reuse。

---

## 2026-05-04 — Codex D #6 + 方案 W：head-expansion + positional 闭环

- D fix #5 nuclear (`cf21ff5`) push 后跑第六轮 codex review，Codex 评 **D**：Y nuclear 闭环了 wrapper-flag chain 7/7（**P2 通过**），但暴露 expansion 形态新攻击：
  - `$AWK 'BEGIN{system("rm")}'`（variable expansion）
  - `${a}wk 'BEGIN{system("rm")}'`（parameter substitution）
  - `${cmd[@]} 'BEGIN{system("rm")}'`（array expansion）
- token literal 是 `$AWK`/`${a}wk`/`${cmd[@]}` 不命中 `isAwkBasename` regex → token-scan miss → autoApprove 一键执行。Codex 同时 P1 注：`gnuplot -e 'system "rm"'` / `sqlite3 .shell` / `vim -c '!rm'` / `ed` 也有同款 inline-shell-out 表面，但属预存盲区不是本轮引入，**留独立 round 评估**。
- 用户拍 **方案 W**：扩展 expansion-before rule 到 "head 位置 expansion + 任何 non-flag positional"。round 9 已经处理 `$SHELL -c PROG`（expansion + inline-code-flag），W 加 positional 形态。
- 实现：[src/safety/bashRiskParser.js](src/safety/bashRiskParser.js) awk 检测块尾追加 expansion-head + positional 检查：
  ```js
  const headIdx2 = skipPreamble(tokens);
  const headTok = tokens[headIdx2];
  if (headTok && headTok.kind === 'word' && hasExpansionMetachar(headTok.text)) {
    for (let j = headIdx2 + 1; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.kind !== 'word') continue;
      if (u.text === '--' || u.text.startsWith('-')) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(u.text)) continue;
      risks.push({ kind: 'code_execution', pattern: 'expansion-head + positional program', confidence: 'medium' });
      break;
    }
  }
  ```
- 闭环（手动 15 case 验证 / 全 6 D 累积 attack vector 全过）：
  - ✅ D #6 attacks: `$AWK 'PROG'` / `${a}wk 'PROG'` / `${cmd[@]} 'PROG'` / `"$AWK" PROG` / `${SHELL} 'PROG'` / `$EDITOR file.txt` 全 catch
  - ✅ D #5/#4/#3/#2/#1 attack 全 regression catch
  - ✅ Round 9 expansion-before-c 仍工作（`$AWK -e PROG` 同时被 nested_shell + code_execution 双标）
- false positive boundary（pin 未误报）：
  - `mkdir $DIR` / `cat $FILE` / `ls $HOME` / `cd $WORKSPACE` / `echo $VAR` / `printf $TEMPLATE`（expansion-head 但 no positional after → no flag）
  - `cat $FILE program.txt`（head=cat literal，不是 expansion）
  - `git commit -m "$MSG"` / `echo "$AWK is awk"`（head literal）
  - `awk -f script.awk` / `awk --version`（probe / file-source）
- accepted over-flag (D fix #6 trade-off)：
  - `$EDITOR file.txt` / `$BROWSER url` / `$TERM args` 等 envvar invocation
  - agent mitigation：直接用具体命令名（`vim file.txt` / `firefox url`），不用 envvar shorthand
- 测试加 4 case：parser 3 case（① 6 形态 expansion-head attack；② 6 形态 expansion-head 无 positional 不误标；③ 4 形态 head-literal-with-expansion-arg 不误触发 D fix #6）；e2e 1 case（3 形态 `$AWK`/`${a}wk`/`${cmd[@]}` autoApprove + 文件保留 attack vector）。
- 验证：`src/safety/bashRiskParser.test.js` **80/80 全绿**（前 77 + 3 新）；`src/tools/builtins/phase2d.bashTool.test.js` **109/109 全绿**（前 108 + 1 新）；`src/**/*.test.js` **1946/1946 全绿**（前 1942 + 4 新；零既有回归）。
- **Codex P1 留下次**：`gnuplot -e` / `sqlite3 .shell` / `vim/ex -c '!cmd'` / `ed` 等非 awk inline-shell-out 工具不在当前 SCRIPT_INTERPRETERS 也不在 awk 范畴，预存盲区。Codex 自己说"不是本次 nuclear awk 改动引入" — 应另起 round 处理（可能扩 SCRIPT_INTERPRETERS 加这些工具 + inline-flag 集合）。
- **总结 6 轮 D**：① wrapper enumerate 是无底洞 → D fix #5 nuclear ✓；② basename literal match 漏 expansion → D fix #6 head-expansion check ✓；③ 还有 inline-shell-out 工具维度（gnuplot/sqlite/vim/ed）— 下轮独立处理；④ 每轮 D 都 expose 新维度盲区，nuclear option + 接受 over-flag 是 trim 不是 pivot 的最稳路径；⑤ Codex review 是结构性必需 — 6 轮各自找到 6 个不同维度盲区，手动 self-review 抓不到这些。

---

## 2026-05-04 — Codex D #5 + 用户拍 nuclear option Y：删 invocation-context guard

- D fix #4 (`0035e86`) push 后跑第五轮 codex review，Codex 又评 **D**：walkback 永远漏 wrapper-flag chain。Codex 实测 8 个 attack vector 全部 risks=[]：
  - `timeout -s KILL 5 awk PROG`（-s 接 SIG，5 接 SECS）
  - `timeout -k 1 5 awk PROG`（-k 接 SECS，5 接 SECS）
  - `flock -w 10 /tmp/f awk` / `-E 1 /tmp/f awk` / `--timeout 10 /tmp/f awk`
  - `stdbuf -o L -e L awk` / `ionice -c 2 -n 7 awk`
  - `coproc awk PROG`（bash builtin 不在 wrapper 集）
- 5 轮 D 揭示结构性 anti-pattern：每个 wrapper 有自己的 value-taking flag (`timeout -s/-k`/`flock -w/-E/--timeout`/`stdbuf -o/-e`/`ionice -c/-n`/...)，固定 N-step walkback 永远跟不上 wrapper-flag combination 的爆炸；扩 enumerated COMMAND_WRAPPERS / VALUE_TAKING_WRAPPER_FLAGS 是 round 5 git deny-list 同款无底洞。每轮 Codex 找新 wrapper-flag 组合，每轮 D 加一层都被 D。
- 用户拍 **nuclear option Y**：删 `awkIsInvocationContext` + `POSITIONAL_VALUE_WRAPPERS` 整段，token-scan 任何 awk-family token + 任何 inline form (`-e`/`-eX`/`--source`/`--source=`/positional/pipe-fed/heredoc/stdin redirect) → hard-reject，**完全不依赖 wrapper 集合**。
- 实现：删整个 `awkIsInvocationContext` 函数 + `POSITIONAL_VALUE_WRAPPERS` Set，token-scan 主循环移除 `if (!awkIsInvocationContext(...)) continue;` 这一行。代码净减 ~70 行（helper + 调用 + 数据结构）。
- **闭环属性**（手动 24 case 验证 / Codex 列的所有 8 D #5 attack 全 catch）：
  - ✅ D #5: timeout -s/-k chain / flock -w/-E/--timeout chain / stdbuf -o -e / ionice -c -n / coproc 全 catch（无 walkback 依赖）
  - ✅ D #4: parallel/stdbuf/watch/timeout/flock 仍 catch
  - ✅ D #1-3: 所有 inline-flag/positional-after-wrapper 仍 catch
  - ✅ Round 14: head 形态仍 catch
- **接受的 false positive**（trade-off cost）：
  - `echo awk -e foo` → flagged
  - `git commit -m awk -e hello` → flagged
  - `grep awk -e file` → flagged
  - 任何 `<cmd> [args] awk [args] -e <something>` 形态都 flag
  - **agent mitigation**：用 single-quote 包整段（`'awk -e hello'` 1 token，不命中 awk-family basename 因为 tokenBasename 含 `-e hello` 后缀），即可绕开。同 round 8 nested_shell `echo bash -c hello` 同款 trade-off。
- **不会 false positive**（基础边界守住）：
  - `cat docs/awk-tutorial.md` (basename `awk-tutorial.md` 有后缀)
  - `find . -name awk-script.sh` (basename 同款)
  - `find . -name 'awk*'` (`awk*` 不命中 regex)
  - single-quoted `'awk -e foo'` (1 token after tokenize)
- 测试调整 +2 case：① "awk-as-data IS over-flagged"（5 case，pin nuclear 接受的 trade-off）；② "awk-as-data still NOT flagged when basename ≠ awk-family or 1-token-quoted"（6 case，pin 边界）；删除 D fix #3 加的"awk-as-data NOT flagged"测试（语义已反转）。e2e 1 case 注释更新（机制从 awkIsInvocationContext guard 改为 isAwkBasename basename match 失败）。
- 验证：`src/safety/bashRiskParser.test.js` **77/77 全绿**（前 76 + 1 净增 — 删 1 加 2）；`src/tools/builtins/phase2d.bashTool.test.js` **108/108 全绿**（前 108 不变）；`src/**/*.test.js` **1942/1942 全绿**（前 1941 + 1 新；零既有回归）。
- **总结 5 轮 D 的教训**：① 安全 token-scan 中 over-flag 优于 under-flag — 这是结构性原则不是 case-by-case；② enumerated wrapper / wrapper-flag 集合是 round 5 git deny-list 同款无底洞；③ context guard 看似减小 false positive 但每减一类增加 wrapper 维度的 false negative，net 总是负；④ Codex review 5 轮揭示 5 个不同维度盲区（glued flag / xargs-find-exec / positional / parallel-stdbuf / timeout-flock 内部 flag）— 没有 5 轮 review 100% 漏；⑤ 每次 D 都该考虑"这是不是 enumerate game?"，是 → nuclear；不是 → 加 narrow fix。Y option 应该在 D #2 之后就考虑。

---

## 2026-05-04 — Codex 又抓 D #4：parallel/stdbuf/timeout/flock wrapper 漏 + `awk -o` 误报

- D fix #3 (`39c1cab`) push 后跑第四轮 codex review，Codex 评 **D**：① 🔴 attack — `parallel awk 'PROG' ::: x` / `stdbuf -oL awk 'PROG' file`（实测 awk 真执行）/ `unbuffer awk` / `watch awk` 4 个 wrapper 都不在 COMMAND_WRAPPERS → awkIsInvocationContext 看到前置 token 不是 wrapper → return false → 漏；② ⚪ false positive — `awk -o out -f script.awk` 被误标 code_execution（`-o` 是 GNU awk pretty-print flag 接 separate value 'out'，`out` 被当 hasPositional → flag）。Codex 同时警告 "枚举式 allowlist 持续形成同类漏 detect"（round 5 git deny-list 同款无底洞）。
- 用户拍方案 K = 扩 COMMAND_WRAPPERS + 修 false positive：
- **扩 COMMAND_WRAPPERS 加 18 个新 wrapper**：
  - Codex 直接列名：`parallel` / `stdbuf` / `unbuffer` / `watch`
  - 防御性同款 "exec sub-command" 行为：`entr` / `flock` / `pv` / `script` / `rlwrap` / `direnv` / `busybox` / `timeout` / `strace` / `ltrace` / `valgrind` / `perf` / `tsp` / `ts`
  - 现 COMMAND_WRAPPERS 总数 18+18=36，仍 bounded（POSIX/Linux command-running wrappers 总集 ~30-40，不像 round 5 git 子命令无穷扩张）。
- **新加 `POSITIONAL_VALUE_WRAPPERS` 处理 timeout/flock 形态**：`timeout SECS awk PROG` / `flock LOCK awk PROG` 的 first positional 是 wrapper 自己的 value（不是 wrapped command），命令在 N+2。awkIsInvocationContext 加 2-step walkback：first walkback 命中 data word（5/`/tmp/f`），如果不是 wrapper 名 → second walkback 看是不是 POSITIONAL_VALUE_WRAPPERS 或 COMMAND_WRAPPERS（cover `direnv exec . awk` / `perf stat awk` 这类 subcommand-style wrapper）。
- **修 false positive 扩 analyzeAwkArgv value-takers**：原 `-F`/`-v`/`-W`/`-i` 4 个，加 GNU awk separate-form value-takers `-o`/`-d`/`-D`/`-l`/`-L`/`-p`（pretty-print / debug / load lib / lint / profile）+ POSIX-glued regex `^-[FvWidoDlLp]./` 同步覆盖。`awk -o out -f script.awk` 现在 hasFileFlag=true, hasPositional=false → 不标。
- **手动验证 24 case 全过**（7 attack + 4 false-positive fix + 5 之前 attack regression + 4 false-positive guard regression + 4 -f only regression）。
- 测试加 5 case：parser 4 case（① 15 形态 wrapper attack，含 parallel/stdbuf/unbuffer/watch + entr/rlwrap/pv/direnv/busybox/strace/ltrace/valgrind/perf/tsp + `script -c` 因属 nested_shell 范畴单独留 known-limit；② 6 形态 timeout/flock/tsp positional-value wrapper attack；③ 6 形态 false-positive fix `awk -o out -f` 等不再误标；④ 5 形态 wrapper + `-f only` 仍不误标）；e2e 1 case（4 形态 parallel/stdbuf/timeout/flock autoApprove + 文件保留 attack vector）。
- 验证：`src/safety/bashRiskParser.test.js` **76/76 全绿**（前 72 + 4 新）；`src/tools/builtins/phase2d.bashTool.test.js` **108/108 全绿**（前 107 + 1 新）；`src/**/*.test.js` **1941/1941 全绿**（前 1936 + 5 新；零既有回归）。
- **已知 limit**（D fix #4 后）：① `script -c '<shell-cmd>'` 通过 sh -c 跑命令属 round 8 nested_shell 范畴，不在 awk 检测；现有 nested_shell 检测的 SHELL_INTERPRETERS 不含 `script` — Codex 下轮可能点名再补；② COMMAND_WRAPPERS 仍是 enumerated allowlist，未来新 wrapper 出现需要继续加（但 POSIX/Linux 标准 wrapper 集有界，~30-40 已基本覆盖）。
- **教训**（4 轮 D 之后）：① enumerated allowlist 在 wrapper detection 维度可接受（有界集）vs round 5 git subcommand 不可接受（无穷扩张）；② Codex 对 wrapper 集合的 audit 比手动想全更可靠 — 4 轮各自找到不同 wrapper 类（基础/value-taking/subcommand）；③ POSITIONAL_VALUE_WRAPPERS 的 2-step walkback 模式可推广到其他 wrapper-with-positional-value 形态（如果将来有）；④ Codex review 已经成为质量保证关键环节 — 没有它 4 个 D 全部漏。

---

## 2026-05-04 — Codex 又抓 D #3：positional inline after wrapper + 误报扩大 → 统一 awk 检测重构

- D fix #2 (`29273fd`) push 后跑第三轮 codex review，Codex 评 **D**：① D #3 attack — `xargs gawk 'BEGIN{system("rm")}'` / `find . -exec gawk 'PROG' {} \;` / `xargs -I{} gawk 'PROG' {}` / `env xargs gawk 'PROG'` 全部不被 flag — D fix #2 token-scan 只看 inline-flag (`-e`/`--source`) 不看**positional inline program**；② 🟡 误报扩大 — `git commit -m awk -e hello` 也会被 D fix #2 token-scan 标 code_execution（dev 真常用 commit message 形态）。两个问题暴露结构性盲区：head-aware findWrappedCommand + 半 token-scan 双层设计永远漏一个 wrapper 形态；每修一刀都要再来一刀。
- **方案（用户拍板，Codex 推荐）**：unified awk detection — **删除整个 head-aware + inline-flag-only token-scan 两层设计**，替换为**单一 token-scan + 两个 helper**：
  - `analyzeAwkArgv(argTokens)` — 完整 awk argv 语义解析。返回 `{hasFileFlag, hasInlineFlag, hasPositional}`。处理：① `-f`/`-fX`/`--file`/`--file=X` (file source)；② `-e`/`-eX`/`--source`/`--source=X` (inline source)；③ `-F`/`-v`/`-W`/`-i` value-takers + POSIX 粘连；④ `--` end-of-options（其后第一 word 视作 positional）；⑤ 首个非 flag positional → hasPositional。
  - `awkIsInvocationContext(tokens, awkIdx)` — 向前 walk back，跳 flag/env-assignment，跳 redirect+target 对（preposed redirect 透明）。命中 `xargs` / `-exec`/`-execdir` / `COMMAND_WRAPPERS` 成员 → invocation context = true。命中其他 word → false（awk 是数据 token）。走到 token start → head 位置 → true。
  - 主循环：扫整 tokens 找 awk-family token；filter by `awkIsInvocationContext`；对幸存 token 跑 `analyzeAwkArgv`；判定 `hasInlineFlag || (!hasFileFlag && hasPositional)` → flag；若三者皆 false 但 sepBefore='|' 或有 stdin redirect → flag pipe-fed/stdin redirect。break on first flag。
- **代码净减少**：原 3 层（head-aware ~70 行 + token-scan ~17 行 = 87 行）→ 新 1 层（主循环 ~35 行 + 2 helper ~75 行 = 110 行）。略增 23 行但语义统一 + 复用性强（helper 可独立测）。
- **闭环矩阵**（手动 + 16 case 全过）：
  - ✅ D #3 attack: `xargs gawk 'PROG'` / `xargs -I{} gawk` / `find -exec gawk` / `env xargs gawk` (positional after wrapper) 全 catch
  - ✅ D #1/#2 attack: `gawk -e<glued>` / `--source=<glued>` / wrapper + `-e` / wrapper + `--source` 全 catch
  - ✅ Round 14 attack: `awk 'PROG'` / `awk 'x=system(...)'` head 形态 catch
  - ✅ False positive 缩小：`echo awk -e hello` / `git commit -m awk -e hello` / `cat docs/awk-tutorial.md` / `grep awk -e file` / `find -name 'awk*'` 全不误标
  - ✅ Regression: `awk -f script.awk` 在直接/xargs/find-exec/wrapper 下全不误标
  - ✅ Probe: `awk --version` / `gawk -V` / `xargs awk --version` 走 prompt
  - ✅ P1 self-review: `< /tmp/script.awk awk` preposed redirect (redirect target 透明 walkback) 仍 catch
- 测试加 7 case：parser 5 case（① 8 形态 positional-after-wrapper attack；② 8 形态 false-positive guard (echo/git/cat/grep/find-name/printf single-quoted/etc)；③ 10 形态 -f wrapper regression；④ 4 形态 probe regression；⑤ preposed redirect regression）；e2e 2 case（① 4 形态 xargs/find-exec attack autoApprove + 文件保留；② git commit -m 'awk -e hello' guard，pin reaches prompt 不被预拒）。
- 验证：`src/safety/bashRiskParser.test.js` **72/72 全绿**（前 67 + 5 新）；`src/tools/builtins/phase2d.bashTool.test.js` **107/107 全绿**（前 105 + 2 新）；`src/**/*.test.js` **1936/1936 全绿**（前 1929 + 7 新；零既有回归）。
- **教训**（third D 之后）：① 多层 detection 设计是反模式 — 每层只盖一面，新 wrapper 形态出来就需要新层；② 应该一开始就抽出"argv 语义解析" + "调用上下文判别" 两个 helper，让单一 token-scan 走完整逻辑；③ Codex 三轮 D 总共"找到 6 个 wrapper bypass 形态" — 没有 Codex 兜底自审 100% 漏；④ 之后写新检测必须先列**所有 inline-program 来源** + **所有可能调用上下文**，不能边写边凑。

---

## 2026-05-04 — Codex 又抓 D #2：`xargs gawk -e ...` token-scan 闭环

- D-fix #1 (`dba8ea3`) push 后用户拍板再跑 codex review，Codex 又评 **D**：`xargs gawk -e'BEGIN{system("rm")}'` / `printf data | xargs gawk --source=...` 不经过 `findWrappedCommand`（xargs 不在 COMMAND_WRAPPERS — 它的 `-I/-n/-0/-P` 复杂 flag 不适配 sudo/env 同款的"skip flag + value"逻辑），awk 检测整段不进入 → 漏 → autoApprove 一键执行。Codex 还指 `find . -exec awk -e PROG {} ;` / `xargs -I{} awk -e ...` 同款 wrapper 形态。这是结构性盲区：head-aware findWrappedCommand 永远漏 wrapper-of-wrapper 形态。
- **方案 A（用户拍板，Codex 推荐）**：复用 round 8 / round 10 的 token-scan 模式 — 扫**整 tokens 数组**找 awk-family basename + 后续 inline-flag (`-e` / `-eX` / `--source` / `--source=X`)。head-aware 检测保留（覆盖 `awk 'PROG'` 无 wrapper 的 positional 路径），新加 token-scan 在其后追加。两段可能双 push code_execution，gate 任一即 hard-reject，无副作用。
- 实现：[src/safety/bashRiskParser.js](src/safety/bashRiskParser.js) awk 检测块尾追加 token-scan 双层循环：外层扫 awk-family (`awk`/`gawk`/`mawk`/`nawk` via `isAwkBasename`)，内层扫后续 token 的 inline flag。命中 → push `${basename} -e/--source inline (token-scan)`。
- 覆盖矩阵（手动验证）：`xargs gawk -e` / `xargs gawk --source=` / `xargs -I{} gawk -e` / `xargs -0 awk --source` / `find . -exec gawk -e {} \;` / `find -name '*' -exec awk --source= {} +` / `env xargs gawk -e`（wrapper-of-wrapper） / `time xargs gawk -e` / `nice -n 10 xargs awk --source=` / 直接 `awk -e PROG`（双层都 catch）全部命中。`awk -f script.awk` 仍不被误标（token-scan 只看 inline-flag 不看 `-f`）。
- 测试加 4 case：parser 3 case（① 10 wrapper 形态全标 token-scan code_execution；② token-scan regression — `echo 'awk -e foo'` / `echo "use awk -e syntax"` / `cat docs/awk-tutorial.md` / `grep 'awk -e' docs/` 单 token 不误标，pin 文件名/单引号场景；③ `awk -f script` 在 wrapper 形态下仍不标 — `xargs awk -f` / `find -exec awk -f` / 直接 `gawk -f`）；e2e 1 case（4 形态 xargs + find-exec wrapper autoApprove + 文件保留 attack vector）。
- 验证：`src/safety/bashRiskParser.test.js` **67/67 全绿**（前 64 + 3 新）；`src/tools/builtins/phase2d.bashTool.test.js` **105/105 全绿**（前 104 + 1 新）；`src/**/*.test.js` **1929/1929 全绿**（前 1925 + 4 新；零既有回归）。
- **已知 trade-off**：token-scan 同 round 8 nested_shell 同款 — `echo awk -e hello`（3 个 echo 参数 unquoted，同时含 'awk' 和 `-e<glued>`）会假阳。Agent 用单引号包成 1 token (`echo 'awk -e hello'`) 即绕开。可接受。
- **教训记**：① head-aware 单层检测对每个 wrapper 形态都漏，结构性问题；② token-scan 是 round 8 + round 10 两次 D 之后已经验证的"按最稳的来"模式 — awk 的 round-14 实现没复用是结构疏忽；③ 现在 awk 检测有 head-aware (positional/pipe/redirect) + hasInlineFlag + token-scan 三层并行，长期看应重构为单一 token-scan + flag-detection（删 head-aware）— 留独立刀，本次先收 D fix。

---

## 2026-05-04 — Codex 抓 D：gawk `-e<glued>` / `--source` inline-program bypass

- 用户拍板手动跑 `codex review` 评 6 个已 push 的 commit (eb9e541..648340d)。Codex 评 **D**，找到一个真 bypass：`gawk -e'BEGIN{system("rm /tmp/x")}'` (POSIX-glued `-e`) 和 `gawk --source='BEGIN{system("rm /tmp/x")}'` 完全不被 round 14 的 awk detector flag — `parseBashRiskyOps` 返回空 risks → autoApprove 一键跑 `system("rm")`。Codex 用 `node -e` 直接验证 reproducible。按 CLAUDE.md §4 D 评级 = 停止后续改写 + 给用户出方案 + 用户拍板后再修。
- **Bug 来源**：round 14 的 awk 检测块只用 `if (a.startsWith('-')) continue;` 把所有 `-` 起始 token 当 flag skip。结果：① `-e PROG`（separate）下个 token 还在 wordArgs 里，positional 扫描 catch ✓；② `-e<PROG>`（POSIX-glued）整个 token 当 flag skip → 程序 payload 丢失 ❌；③ `--source <PROG>` (long separate) 同款 ❌；④ `--source=<PROG>` (long glued) 同款 ❌。和 round 14 self-review 的 var=val skip bug 同源 — 我对 awk flag 集合理解不全。
- **修复**：仅改 awk 检测块，加 `hasInlineFlag` 判定置于 `hasFileFlag` 之前：
  ```js
  const hasInlineFlag = wordArgs.some(a =>
    a === '-e' || /^-e.+/.test(a) || a === '--source' || a.startsWith('--source=')
  );
  if (hasInlineFlag) {
    risks.push({ kind: 'code_execution', pattern: `${tokenBasename(awkToken.text)} -e/--source inline`, ... });
  } else if (!hasFileFlag) {
    // 现有 positional / pipe / stdin 检测
  }
  ```
  POSIX awk 没 `-e` / `--source` 但 GNU awk 有 — 我们对所有 awk-family head 统一应用（false-positive cost 是 "agent 用 -f 替代"，可接受）。`-e` / `--source` 优先级高于 `-f` 豁免：`awk -f script -e 'PROG'` 仍标 code_execution（inline 部分危险）。
- 测试加 4 case：parser 3 case（① 9 形态 `-e<glued>` / `-e separate` / `--source separate` / `--source=glued` / 各 awk-family / wrapper 全标；② 6 形态 `-f` 仍不标 regression；③ `awk -f -e` 双 flag inline 优先标）；e2e 1 case（4 形态 autoApprove + 文件保留 attack vector）。
- 验证：`src/safety/bashRiskParser.test.js` **64/64 全绿**（前 61 + 3 新）；`src/tools/builtins/phase2d.bashTool.test.js` **104/104 全绿**（前 103 + 1 新）；`src/**/*.test.js` **1925/1925 全绿**（前 1921 + 4 新；零既有回归）。
- **教训**：① push 前没自审是规则违反 — Codex 评 D 直接证明手动 self-review 抓不出 awk flag 集合的盲区；② 之后所有 commit push 前必走 codex review（如果 Codex 额度允许）或至少 melo-code-review skill；③ awk 这种灵活 flag 的 deny-list 永远写不全 — 应该转向"任何非 -f 的 program-like input 全标"，而不是逐个 flag enumerate（下轮如果再 D，按这个方向重写）。

---

## 2026-05-04 — sed exotic delimiter coverage (Phase 2D round 14 known-limit closure)

- Round 14 末尾自标 known limit #1：sed substitute 接受任意第一字符作为 delimiter（`s,x,y,e` / `s|x|y|e` / `s:x:y:e` / `s#x#y#e` / `s@x@y@e` 全合法），但 pattern 2 是 `/`-delim only regex。JS regex 不支持 `[^\1]` 反引用，没法用单 regex 通用覆盖。Codex 大概率下一刀就 demo 这个绕过。按"不糊弄 follow-up"规则现在补，不等 Codex 点名。
- **方案 B 全 imperative**（评分 8/10 vs 方案 A 5-6 条并列 regex hardcode delim 7/10 vs 方案 C 等 Codex 4/10）：把 `sedExpressionHasEcmd` 的 pattern 2 regex 替换为 imperative scanner，统一处理任意 delim：
  - 扫整 text 找 `s` 在命令位置（start-of-string 或前置 non-alphanumeric — 防 `says`/`sass`/`bash`'s `s` 等被误判）。
  - `s` 之后第一个 char = delim（拒绝 alphanumeric / whitespace / `\n` / `\\`，避免和后续 sed 命令字符冲突）。
  - 扫到下一个 unescaped delim = PATTERN 结束；再下一个 = REPLACEMENT 结束；之后 letters-only sequence = FLAGS。
  - FLAGS 含 `e` AND 后跟 sed boundary（whitespace / `;` / `{` / `}` / `\n` / EOS）→ `code_execution: 'sed e-cmd'`。
  - 否则记录 substitute region 用于 strip，i 跳过整个 substitute。
- **Strip 后 pattern 1 不变**：bare `e CMD` 检测 (`(?:^|[^a-zA-Z])e\s`) 在 stripped text 上跑，所有 delim 形态的 substitute 都被 imperative scanner 标记 strip 掉，所以 `s,foo,bar e baz,` / `s|foo|replace e text|` 这种 replacement 含 `e<space>` 的形态不再误伤。
- 测试加 6 case：parser 3 case（5 形态 exotic delim + e flag 全标 / 5 形态 exotic delim 无 e flag 全不标 / 5 形态 `s` 在 word 中 (`says`/`sass`/`tests`/awk's `print "s"` arg/grep `say.*hello`) 不被误判 sed substitute）；e2e 3 case（exotic-delim attack vector `s|a|rm -f <target>|e` + autoApprove → 0 prompt + DENIED + 文件保留 / 5 形态 `s,x,y,e` / `s|x|y|e` / `s:x:y:e` / `s#x#y#e` / `s@x@y@e` 全 0 prompt + DENIED / 5 形态非 e flag exotic delim 走 prompt promptCount==5 不被预拒）。
- 验证：`src/safety/bashRiskParser.test.js` **61/61 全绿**（前 57 + 3 新 + 1 escape-aware self-review 补充）；`src/tools/builtins/phase2d.bashTool.test.js` **103/103 全绿**（前 100 + 3 新）；`src/**/*.test.js` **1920/1920 全绿**（前 1914 + 6 新；零既有回归）。
- **Self-review 后补**：审计 imperative scanner 后 trace 确认 escape-aware 行为正确（`s,foo\,bar,baz,e` 这种 PATTERN 含转义 delim 仍正确扫到 e flag），但原测试矩阵没显式覆盖。补 1 case 4 形态（`s,foo\,bar,baz,e` / `s|foo|bar\|baz|e` / `s#foo\#bar#baz#e` / `s:f\:o:b\:r:e`）pin escape-aware 不退化。
- **本次 commit 触发了 CLAUDE.md §3 PROGRESS.md 压缩**（pre-fix 409 行 > 300 阈值）：把 Phase 2D / 2C / 2B / 2A round 13 四个 section 整段压缩成 4 条归档摘要，新归档 heading "归档摘要（2026-05-04 Phase 2B 之前的所有条目）" 取代旧 "Phase 2A 之前"。压缩后 PROGRESS.md 280 → +10 (本 entry) ≈ 290 行。最新 30%（顶部 selected file context + hygiene fix）保留完整。
- **更新后已知 limit**（round 14 list 减一加二）：① ~~sed exotic delimiter~~ 本刀已修；② `awk -f /dev/stdin` 配合 stdin pipe 仍可执行任意代码（语义层洞，文件名级 fileRead 不解 device）；③ 文件名形如 `e thing.txt` 触发 pattern 1 假阳；④ `gawk -E /tmp/script.awk` 误标 code_execution；⑤ SCRIPT_INTERPRETERS deny-list 但有界；⑥ **新**：scanner 的 "command position" 检查只排除 ASCII alphanumeric（`[a-zA-Z0-9]`），所以前置 `_` / 中文字符 / 标点的 sed program 字符串（罕见，例：文件名 `_s,foo,bar,e file.txt` 作为 sed 数据 arg）会被 scanner accepted as substitute 触发 e-flag 假阳 → DENIED。安全方向无影响（DENIED 不是 leak），UX 噪音极低（攻击者无动机创建这种文件名）。修法 `[^a-zA-Z0-9_]` 字界检测留 round 15 如 Codex 点名再补；⑦ **新**：FLAGS 扫描 `[a-zA-Z]` 接受大小写，但真实 sed 只用 lowercase（除 GNU `M` multiline）。`s/x/y/eX` 这种 invalid sed 会被 scanner 当 `flags='eX' + EOS` 标 code_execution。安全方向 over-flag（宁可 DENIED invalid sed 也不放过 valid attack），trade-off 接受。

---

## 2026-05-04 — Selected file context: query-relevant excerpts for large files

- 用户 review 大文件（> 3000 chars）时，`buildDynamicContext` 之前把整个 `selectedFile.content` 原样塞进 prompt → token 成本随文件大小线性涨。优化：抽出新 export `buildSelectedFileContextBlock(selectedFile, latestUserMessage)` 把大文件转成 query-relevant excerpts。小文件（≤ 3000 chars）走原样 path（向后兼容）。
- **算法**（pure 函数 + 上限严格）：
  - `tokenizeContextQuery(latestUserMessage + path)` 提 token：`[a-z0-9_]{2,}|[一-鿿]{2,}` 正则匹配，过滤 stop words（中英双语：the/and/for/this/帮我/看看/这个/...），最多 24 个 unique tokens。
  - `scoreLineForQuery(line, tokens)` 对每行打分：含 token 命中 +4；含代码关键字 (`function|class|const|let|var|export|import|async|test|describe|it(`) +2；token 命中位置在前 12 chars +1。
  - top-4 高分 line 作为 seed（`SELECTED_FILE_MAX_SNIPPETS=4`），每个 seed 上下 ±10 行 (`SELECTED_FILE_SNIPPET_RADIUS=10`) 作为 candidate range。
  - `mergeLineRanges` 经典 interval merge（包含相邻一行的合并：`range.start > last.end + 1` 才新建段，否则扩 last.end）→ 重叠 / 相邻 range 自动合一段。
  - 渲染按 5200 chars 上限 (`SELECTED_FILE_SNIPPET_CONTEXT_CHARS=5200`)：从 high-score 优先的 ranges 顺序渲染，用 `${lineNo}\t${content}` 格式（line number prefix 让模型可定位 + 用 file_read 拿更多）；超阈值停（首段超阈值则截断前 5200 chars 至少给一段）；多段间用 `\n\n...\n\n` 分隔。
  - 0 score（query 无 token / 全 stop words / 无命中）→ fallback `seedIndexes = [0]` 给文件头（imports + 顶层声明，typically informative）。
- **header 提示**：始终输出 `Selected workspace file: ${path}`；`selectedFile.truncated=true` 时加 `Note: the UI preview was already truncated` 让模型知道全文还有更多；snippet mode 加 `File context optimized for token budget: showing N excerpt(s) from M lines instead of the full K characters. If more context is needed, call file_read with a specific line range.` 教模型怎么主动拿更多上下文。
- **`buildDynamicContext` 集成**：原来 `local-files connector + workspace.selectedFile` 分支的 4 行 inline 拼接替换为 `blocks.push(buildSelectedFileContextBlock(workspace.selectedFile, latestUserMessage))` 一行调用。
- **5 个测试** [src/services/chat/dynamicContext.test.js](src/services/chat/dynamicContext.test.js)：① 小文件（≤ 3000 chars）走原样 path（无 "optimized" 提示）；② 大文件（260 lines）+ query 命中 → excerpt 含命中行 + 远端 line 不出现；③ 集成 `buildDynamicContext` 大文件路径；④ `truncated=true` header 注释展示；⑤ 空 query / 全 stop word query → fallback `seed=[0]` 渲染文件头（line 1 出现，远端 line 不出现）。
- 验证：`src/services/chat/dynamicContext.test.js` **9/9 全绿**（前 4 + 5 新）；`src/**/*.test.js` **1914/1914 全绿**（前 1912 + 2 新；零既有回归）。
- **已知 trade-off / limit**：① `scoreLineForQuery` 的代码关键字 regex 只对 JS/TS 友好（function/class/const/let/var/export/import/async/test/describe/it）—— Python/Rust/Go/Java/C++ 等其他语言 review 拿到的 excerpt 排序质量会低（仍能 fallback 到 token-only 评分）；后续如有真实 review 痛点再扩；② query 只用 `latestUserMessage` 单条，不带 conversation history —— 多轮深入 review 场景里上一轮的 context 关键词不参与评分，trade-off 是保持 stateless 接口；③ 5200 / 3000 / ±10 / 4 个 seed 是经验值，没经过实测 token 优化 —— 后续如果实际 prompt 仍偏大可下调 5200，或如果信息量不足上调；④ `selectedFile.content` 强转 string，传错类型（array/object）会出 `[object Object]` 字面量，没显式校验。

---

## 2026-05-04 — Web search / Playwright resource hygiene fix（系统卡死 root cause）

- Round 14 之间会话期间系统卡死重启。复现链：用户 search 面板长开 → web_search SWR 后台刷新 + tool runner 并发 web_search 调用 → Playwright 单浏览器队列无界增长 → Chrome helper 子进程堆积（每个 SERP 任务可能 spawn 新浏览器实例）→ 系统 OOM → 卡死强制重启。三个 root cause 联合作恶，必须一刀全修才闭环（否则任意一条还会再触发）。
- **三个 root cause 各自的 fix**：
  - 🔴 **(a) `webSearchTool.isConcurrencySafe: true → false`**（最关键的一刀）：之前 tool runner 看 `isConcurrencySafe=true` 就允许并发跑 web_search，但 Playwright SERP/session 是**故意单浏览器**的（每个 named session 独占一个浏览器窗口）。让并发的 web_search 全去抢同一个 melo-search session 队列就会无界堆积任务（Playwright 内部的 mutex chain 不限长），并且每个失败的任务可能留 Chrome helper 残留进程。flip 到 false 后 tool runner 串行 web_search 调用，队列顶多 1 个待处理任务。
  - 🟠 **(b) Idle close machinery (closeSoon / close + 15s timer)**：Playwright session 一旦 open 就在整个 chat session 期间常驻，多 chat 累积下浏览器进程不释放。新加 `closeSoon(delayMs)` debounce idle close 到 15s 后；`runCli` 任意命令完成（callback 时 `_browserOpen=true`）自动 schedule；timeout / killed / signal error 立即 `closeSoon(0)` 强关；`fetchPage` catch 分支也 `closeSoon(0)`；`navigate` 的 first-open 和 fallback-open 后 explicit closeSoon（runCli callback 时 `_browserOpen` 还 false 看不到）；goto 分支不重复 schedule（runCli callback 已经处理）。`_chain` 串行化 close 操作避免与 in-flight withLock 命令竞争。
  - 🟡 **(c) SWR 后台刷新 dedup**：search 面板每次 poll cache 命中 stale row 都 `queueMicrotask(_refreshInBackground)` 一发，长开面板等于持续往 Playwright 队列塞任务。新加 module-level `_backgroundRefreshInFlight` Set 按 `buildCacheKey(q, intent)` 去重；schedule 前 `.has` 检查；schedule 时 `.add`；`.finally(() => .delete)` 清理（用 `.finally` 不是 `.then` 让失败的 refresh 也能释放槽位，否则卡 flaky 一次后该 cache key 永远 refresh 不动）。
- **`PLAYWRIGHT_CLI_PACKAGE` pin**：之前 `'@playwright/cli@latest'`，npx -y 每次冷启动 revalidate 注册表 → 网络抖动可触发偶发延迟 + 不可重现（不同 ops 机器解析到不同版本）。pin 到当前最新稳定 `@0.1.11`。`MELO_PLAYWRIGHT_CLI_PACKAGE` env var 是 escape hatch，ops 想试新版可以 override。bump pin 时改这个常量。
- **去掉冗余 closeSoon 调用**：原 navigate 三处 closeSoon 里 goto 分支那次是冗余的（`_browserOpen` 已经是 true，runCli callback 已经 schedule）。删掉，注释解释为什么 first-open / fallback-open 仍需要保留。
- **5 个 hygiene 契约测试** [src/tools/builtins/webSearchTool.helpers.test.js](src/tools/builtins/webSearchTool.helpers.test.js)（playwrightFetcher 真测试 timer 行为需 DI 重构 execFile 注入，工程量大不在本刀）：① `webSearchTool.isConcurrencySafe === false`（pin 最重要的一刀，防 silent regression 把 root cause 重新打开）；② SWR dedup 源码模式 — `_backgroundRefreshInFlight.has` / `.add` / `.delete` + 关键 `.finally` 子句必须存在（pin "失败也释放槽位"语义）；③ playwrightFetcher CLI version pin 必须是 semver 不是 `@latest`（双向 assert：必有 semver + 必无 latest fallback）；④ `createPlaywrightSession` 返回的 session 必须 expose `close` + `closeSoon` 方法 + module 必须 export `closePlaywrightSession`/`closePlaywrightSessionSoon`（pin idle-close surface 不被精简）；⑤ `closeSoon` 在 nothing-open 状态下 must be no-op（pin 不会冷启动 schedule storm，10 次连调 + 负 delay opt-out + close 也安全）。
- 验证：`src/tools/builtins/webSearchTool.helpers.test.js` **38/38 全绿**（前 33 + 5 新）；`src/**/*.test.js` **1912/1912 全绿**（前 1907 + 5 新；零既有回归）。
- **已知 limit**：① playwrightFetcher 的 idle-close timer 行为（runCli 后自动 schedule、超时强关、open vs goto 分支）没真正 unit test，需要 DI 重构 execFile 注入或 t.mock.module（experimental）才能跑；现在 5 个测试是契约 pin + surface assert，依赖未来 codex review 抓真行为 bug；② `MELO_PLAYWRIGHT_CLI_PACKAGE` env var 没有强校验（任意字符串），生产被设错可能拉到不存在的包，但属于 ops 配置错误不在 parser 范畴；③ idle-close 时间 15s 是常量没 expose，长 chat 下可能反复 open/close 浪费冷启动 ~1s（trade-off：vs 浏览器常驻消耗内存）。

---

## 归档摘要（2026-05-04 Phase 2B 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

- **2026-05-04 — File Safety Gate Phase 2D：bash 工具走 bashRiskParser → requestBashOp（14 轮 follow-up + self-review）** —— bashTool 入口接 `bashRiskParser` → `requestBashOp` gate（`requiresPermission:false`，零风险静默 / 风险弹 prompt / delete-class 硬拒 + file_delete 提示）。14 轮 Codex follow-up 修透各种 bypass：#1 silent-by-default → allowlist + `nested_shell` risk kind（bash -c / eval / xargs sh -c / $() / `\``...）；#2 砍 npm/pnpm/yarn allowlist（package.json scripts 是任意 shell）；#3 cwd 必须在 ws + path-shape arg 必拒 + git option deny-list；#4 realpath-based `cwdInsideWorkspace` 关 lexical/symlink 双逃逸 + `isVersionProbe` EXACTLY 匹配；#5 砍整 git allowlist（`--output=` 等无底洞）；#6 SILENT_ALLOWLIST 收敛到 6 条 + cwd 三件套 prompt payload（effectiveCwd / realCwd / cwdInsideWorkspace）；#7 nested_shell **硬拒**（与 delete 同列，零 prompt 零 spawn）；#8 token-scan 替代 head-only + COMMAND_WRAPPERS bounded set；#9 expansion-before-c（`$SHELL -c` / `${SHELL}` / `bash${EMPTY}` / `ba*`）；#10 新增 `code_execution` 硬拒（python -c / heredoc / pipe-fed / stdin redirect）+ SCRIPT_INTERPRETERS / INLINE_CODE_FLAGS；#11 抽 `effectiveInterpreterHead` helper（4 路径共享 wrapper-skip）；#12 splitWithSeparators 加 `|&` 同 `&&`/`||` two-char；#13 新增 `argv_rewrite` 硬拒（`env -S` / `--split-string`）；#14 awk inline-program + sed e-cmd（`isAwkBasename` + `sedExpressionHasEcmd` 双 pattern + `findWrappedCommand` 重构）；#14 self-review（user 让我自查）发现 awk var=val skip 漏 `awk 'x=system("rm")'` + sed pattern 1 over-tightening 漏所有 address-prefix（`/foo/e`/`$e`/`2e`/...）+ pre-existing parser gap 让 preposed redirect（`< /tmp/x rm`）所有 head-based 检测 miss → 加 `skipPreamble` 同时跳 redirects + env-assignments。终态：bashRiskParser 57/57 + phase2d.bashTool 100/100 + 全 src 1907→1914 全绿。已知 limit：sed exotic delim（`s,x,y,e`/`s|x|y|e`/`s#x#y#e`） / `awk -f /dev/stdin` / `e thing.txt` 文件名假阳 / `gawk -E` 误标 / SCRIPT_INTERPRETERS deny-list 但有界。Final commits: `eb9e541` (round 14) + `3b5ac4c` (self-review) + 前置 `3c2ba41` / `22f67e4` / `42f80cf` / `31a4135` / `ef0d142` / `bc923ea` / `f867ff1` / `a6ab5e0` / `d20c733`.
- **2026-05-04 — File Safety Gate Phase 2C：rich-media reads (pdf / image / knowledge) 接入 gate** —— `gatedReadIntoBuffer(absPath, ctx, opts)` 统一原语：requestRead 走 gate → atomicOpenLeaf 拿 dirfd-bound leaf fd → S_ISREG + size cap → readSync Buffer。pdfTool（10 actions）/ imageTool（ocr/info/process）/ knowledgeTool（index 一次 requestRead `bypassGrants:true` subtree dirfd-walk）全部接 Buffer 路径不再 re-open path。phase2c.richMedia 19 case；4 轮 follow-up C→A。已知 limit：pdftoppm / rg 仍按 path 读，系统 tmpdir 0o700/0o600 缩攻击面。Final commits: `3dccb3e` + `4cba848` + `e4eaa32` + `9589946` + `e093cf8`.
- **2026-05-04 — File Safety Gate Phase 2B：read tools (file_read / glob / grep) 接入 gate** —— fileRead 走 atomicOpenLeaf O_RDONLY|O_NONBLOCK + S_ISREG；glob/grep 走 dirfd-bound 递归 walker（openat O_DIRECTORY|O_NOFOLLOW + readdirAt）。grep 砍 rg fast-path 统一 JS walker。native addon 加 O_NONBLOCK + readdirAt + `openDirNoFollowChain` component-by-component walker（关 ancestor-symlink chain 漏洞）。phase2b.readTools + dirfdOps.checked 共 35 case；4 轮 follow-up D→A。Final commits: `b8356d9` + `b91a993` + `bb4d95f` + `fc6f886` + `7e20b88`.
- **2026-05-03 — File Safety Gate Phase 2A round 13：N-API dirfd-bound atomic ops（终结 12 轮 path-race patch loop）** —— 12 轮 Codex C/D 后引入 native N-API addon 走 POSIX `*at()` syscall。`atomicOpenLeaf` / `atomicRename` / `atomicMkdir` / `atomicUnlink` / `atomicSymlink` / `atomicLstat` + checked variants（probe + syscall 共用 fd 无 reopen race）。fileWriteTool / fileEditTool / fileMoveTool / fileMkdirTool / fileDeleteTool + backup/trash 全链 dirfd-bound。phase2a.fileTools 65 case + 各 errno/checked test；整体 src 1736/1736；5 轮 follow-up D→A。Final commit: `f73ba46`.

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

- **2026-05-03 — File Safety Gate Phase 1：四模块地基（无接入，纯独立）** —— `sensitivePaths` (4 类硬黑名单) + `chatScopedGrants` (per-(chat,path,kind) 内存授权) + `fileSafetyGate` (8 入口 / 三段决策 / 两阶段 delete) + `trash` (.melo-trash quarantine + 永不自动删) + `backup` (snapshotBeforeWrite + recordAfterDiff) + `bashRiskParser` (8 risk kinds + quote-aware tokenizer)；Phase 1 共 9 轮 Codex pre-pp gate (C/D 多次往返) 才到 A。修过：lexical isWithinWorkspace bypass via `safeResolvePath` + 取最严格 sensitivity；`requestReadBatch` 改强制 paths[] partition (sensitive 单独走)；trash/backup `purge*`/`restore*` operationId 双层防护 (`OPERATION_ID_PATTERN` + `assertWithinRoot`)；commit-token 体系 (`_issueOperationToken` + `commitOperation` TTL 5m + single-use)；restore 链 layer (a/b/c/d) atomic approval-and-commit；`safeDeleteToTrash` 改 `{operationTokens, ctx}` token-bound；`commitOperation` 加 `expectedKind`/`expectedKinds` 强校验防 cross-kind token 复用；symlink delete 改 lstat-based no-follow（`_unsafeRawDelete` 删 link 不删 target）；restore 链 `wasSymlink` 分支独立校验 manifest `symlinkTarget` + 加 `resolvedPathAtDelete` tamper detection。Phase 1 测试矩阵 192/192；全量 1660/1660。`5ebf668` + `987a536` + `4854864` + `cc3170f` + `ad0260c` + `45e3d16` + 后续多轮 → final commit 系列见 git log Phase 1 段
- **2026-05-01 17:30 — PDF Batch C：edit_spec 中间层（in_place_overlay + rebuild）** —— `pdfEditSpec.js` strict validator + `pickRebuildEngine` (auto: explicit > language > sectionsContainCjk > pdfkit) + 11th `from_spec` action 接 in_place_overlay (text/image/metadata/form fields) 和 rebuild (pdfkit / html_playwright)；顺手修了 pre-existing pdfkit `info.* undefined` crash；6 轮 Codex C 修 nested-doc / margins thread-through / CSS injection / sectionsContainCjk 路由 + sectionsToHtml object-row table 渲染漏；`789fc55` + `a4172bc` + `fc0262b` + `1b07201` + `c6e02b1` + `372b251` + `cd5b2bd`
- **2026-05-01 16:00 — PDF Batch B：视觉验收 workflow 嵌入 pdfTool description** —— +700 字符 `VISUAL REVIEW WORKFLOW` block 5 步流程 (生成 → render → 自检 LAYOUT/FONT/CONTENT FIDELITY → fix → 仅 echo FINAL URL)；3 层 defence-in-depth 修全局 URL rule vs render PNG echo 冲突 (in-context QA-only marker + `artifactRole: 'review'` + global rule EXCEPTION clause)；`c2bd16f` + `96753e0`
- **2026-05-01 14:00 — PDF 能力 Batch A：simple ops + render** —— `pdf-lib` 6 helpers (merge/split/delete_pages/watermark/add_page_numbers/prepend_cover) + `pdftoppm` render backend (zero API cost)；pdfTool actions 3 → 10；CJK 在 watermark/page_numbers reject；`resolveInputPdfPath` helper 修 input/output 路径解析不对称；`cd13148` + `98a1502`
- **2026-04-30 11:30 — 独立 image edit pipeline（用户产品级 audit 落实）** —— `codexImageEngine.editImageViaCodex` 两阶段（vision analysis → 短 edit prompt scaffold）+ `detectImageEditIntent` + chat fast-path 短路 ReAct loop；Codex D SSRF guard 收紧到 data-URI ONLY（拒所有 http(s)）；2 轮 C 收紧 `IMAGE_FOLLOW_UP_PATTERN` 仅 image-OBJECT 短语 + Gate 5 双 pattern 同时为真才 fire（防 "把这个函数改成 async" 误编辑截图）。`41d20cf` + `94518d0` + `2a417b2` + `7a871de` + `d64bfc0` + `fcafa6d`
- **2026-04-30 09:30 — Codex 内联图编辑模式（image-to-image edit）** —— `messagesHaveInputImages` + `buildCodexResponsesTools(hasInputImage)` + `CODEX_INLINE_IMAGE_EDIT_INSTRUCTION` 三件套；4 轮 Codex C 修后撤销 effectiveModel→gpt-5.5 silent swap、保留 caller's model；用户实测 Codex 拒 input_fidelity → 改 bare `{type:'image_generation'}` 形态。`2618ec5` + `672b2c0` + `bc640c1` + `3ab34b5`
- **2026-04-29 00:30 — Codex chat 流内联图：image_generation tool 真正打通** —— `createCodexResponsesReply` 加 workspacePath 参数启用裸 image_generation tool；`readCodexSseResponse` 抓 `image_generation_call.done` emit markdown URL 注入 deltaText；3 轮 Codex C 修真 bug（dedup tracker vs emit tracker 拆 / final-text 必须含 prose+image / mime sniff strict by magic-byte，不信 output_format）。`1f17365` + `e7a7311` + `6edfc5e`
- **2026-04-28 13:30 — 用户截图反馈三连：MiniMax key 保存丢值 + 模型版本 + Voice 面板高度** —— 真因：connector-config 表单没接 draft mirror，password input 每次 background render 回 SSR `value=""` → 提交空被 keepIfBlank 当 preserve；后续 17+ 轮 Codex C/D 分别修 dispatcher / autosave / `_autosaveRevision` gate / `withConfigLock` 原子化 / refreshModelCatalog 锁外 discovery / catalog-only 契约（loadConfig + getResolvedConfig + getDesktopBootstrap 全链 `skipModelNormalize`）。`28a47b1` … `554c079`
- **2026-04-28 12:30 — Codex D 第三轮：initMcpServers 无条件 reconcile + 抽出可测模块** —— 去 `hasServers` 短路（empty config 也跑 reconciler）；抽 [src/mcp/init.js](src/mcp/init.js) DI hook 可测；toolId.test.js 里 NUL 字节修成 unicode escape 让 git 当 text。`479a897` + `5a9afa9`
- **2026-04-28 12:00 — Codex C 第四轮：MCP server id 契约 + 共享 toolId helper（safe vs safe:evil）** —— 新建 [src/mcp/toolId.js](src/mcp/toolId.js) `MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/`，用 `parseMcpToolId` 替 `split(':')[1]` 防 agent 授权 `safe` 静默放行 `safe:evil`；启动时 stderr 警告非法 server name。`3876cdc`
- **2026-04-28 11:30 — Codex C 第三轮：agentDraftFor 漏 enabledMcpServerIds → 静默清空 + stale 撤销失效** —— 抽 [desktop-ui/agentDraft.js](desktop-ui/agentDraft.js) `agentDraftFromProfile(agent)` 纯函数补 `enabledMcpServerIds: Array.isArray(...) ? [...] : []` deny-all 默认；12 个契约测试覆盖 round-trip 保留、unsubmitted 不丢、stale chip whitelist 撤销路径。`75f9f72`
- **2026-04-28 11:00 — Codex D 第二轮：MCP lifecycle reconciler（全局 disable 真生效）** —— `bootstrapMcpServers` 加 reconciler phase，先 disconnect stale active 再 connect effective；`connectMcpServer(disabled)` 也 disconnect 旧 client；抽 `reconcileMcpLifecycle` 纯函数 + 7 lifecycle 测试。`6957783`
- **2026-04-28 10:30 — Codex C 第二轮：mcpAuthSurface 统一 + boolean 严格 + 测试 NUL 修复** —— bootstrap 暴露 built-in ∪ user MCP 的 union surface（之前 UI 只列 built-in，user MCP 死锁）；`/api/mcp/preset-toggle` 严格 `typeof === 'boolean'`；test 文件里 NUL 字节用 python 替换。`4d9dc73`
- **2026-04-28 10:00 — Codex D 第一轮：MCP 默认全关 + cwd reframe + path 加严 + agent UI 撤销** —— md2pdf 默认改 false（4 层模型）；cwd 不再叫 sandbox（不限制绝对路径），改 default working dir；path 禁 `.`/`..`/无字母数字 leaf + resolve 校验 root；chip 改 CSS 类（仍可点撤销已有授权）；README 加 4 层状态文档。`799a9a4`
- **2026-04-28 09:00 — MCP 全局接入 + per-agent 白名单 + Advanced UI（AntV chart + markdown→pdf）** —— 4 phase 一次性：BUILTIN_MCP_PRESETS（antv-chart + markdown2pdf）+ McpStdioClient cwd + 默认 cwd 子目录；agent profile `enabledMcpServerIds`（deny-all）+ filterMcpToolsForAgent prompt/dispatch 双 enforcement；buildMcpTool 默认 requiresPermission=true 走 approval；bootstrap mcpPresets[] + Advanced toggle UI + agent customize chip-row + `/api/mcp/preset-toggle` 端点。30 新单测，1133/1133 全绿。`8778052` + `3ae3285`
- **2026-04-27 16:50 — TTS / 视频 / 配置入口 4 处体验断点** —— Voice 面板加 Auto radio + WKWebView 改名 Desktop native voice + 视频附件 chip 读 extractedMedia 显示真实状态 + Voice 面板加配置 MiniMax/Whisper 跳转。`9f5a87a`
- **2026-04-27 19:30 — Codex D fix: desktopStore re-export gap + server import smoke net** — af2e3b7→768d511 left `restoreArtifact`/`purgeStaleSoftDeletes` un-re-exported, server boot would throw on first ESM load; added the missing re-exports + `src/server.imports.smoke.test.js` (parses server.js import list and asserts every name is reachable through desktopStore). Codex S. `5a888ee`
- **2026-04-27 19:00 — Codex C round 2: artifact soft-delete reader audit + 11 regression tests** — af2e3b7 missed 4 readers (dynamicContext/search/apply/connector count); added `isLiveArtifact`/`visibleArtifacts` helper, wired 7 readers, +11 tests. `768d511`
- **2026-04-27 18:30 — artifact soft-delete contract → server-driven** — `e1a8ecf` used a client setTimeout (timer lost on reload) → Codex C; switched to server-side `deletedAt` + `/api/artifacts/restore` + 7d GC, client became fire-and-forget pair, 17 backend tests. `af2e3b7`
- **2026-04-27 18:00 — 5 处次级 UX 体验提升** —— 批 1 `5f9107a`：PDF 入口 + Advanced Copy state.json + Tasks lane overflow + Search 空状态分类提示 + showFlashToast helper。批 2 `e1a8ecf`：artifacts 软删 + undo toast 第一版（client-timer，被 18:30 D-grade 改成 server-driven）；undoToast.js + 16 单测。test:ui 71/71，memory 330/330。
- **2026-04-27 17:30 — desktop-ui test harness 落地** —— byte-for-byte port `describeVideoExtractionStatus` + 拆 `renderAdvancedPage` 成显式 props；`npm run test:ui` 52/52 全绿；闭环 14:30 Advanced B + 本批 ⚪ 两条 same-root follow-up；后续 desktop-ui "抽纯函数 + .test.js" 标准模式确立。Codex S。`a9aa5a8`+`7a6710e`
- **2026-04-27 16:25 — Codex B 第三轮：threshold capture 真正 mid-call 锁定** —— compactQualityThreshold 始终返回 finite number（空/非法 → 0.6 默认），evaluator 不再回头读 env；contract test 锁定 mid-call env 突变不影响 fallback 决定。`da4e09e`
- **2026-04-27 16:10 — Codex B 追加 follow-up：MELO_SUMMARY_QUALITY_THRESHOLD="" 边界** —— `Number('') === 0` 让 fallback 全放行；trim + 空字符串短路 + 2 回归测试。`d339782`
- **2026-04-27 15:55 — Codex B 4 条 follow-up：bench rank / vec-aware / threshold capture / fallback DI** —— 🔵 `--rank tier\|global` 默认 tier；🟡 `embeddingActive && vecAvailable` 才报 ANN；🟡 入口 capture threshold；⚪ `_setCallLocalLlmForTests` DI hook + 4 mock 测试。`9d504b2`
- **2026-04-27 15:30 — F-3C：README "Memory and embeddings" 节落地** —— bge-m3 onboarding 引导（`ollama pull bge-m3` + 4 级降级链 + env 矩阵 + bench 跑法）；闭环最后一条横评扣分项。`dece161`
- **2026-04-27 15:15 — F-2C：reference-free summary quality + dreams diary 接入** —— 新增 `src/memory/dreaming/summaryQuality.js`（length / entityCoverage / tokenGroundedness 三指标 score = 0.1+0.4+0.5）+ `auditSummary` 写当日 DREAMS.md；`compact.js` 接入按 `MELO_COMPACT_QUALITY_GATE` 处理 LLM 输出；18 新单测 + memory 套 323/323 全绿。`aad4f72`
- **2026-04-27 14:45 — F-1A：memory retrieval bench（黄金集 + recall@k 报告）** —— 新增 `bench/memory/{golden.example.json, README.md}` + `scripts/bench-memory.js` + npm `bench:memory`；支持 `--no-embed` / `--validate` / `--json` / `--threshold-recall5` CI gate；305/305 memory tests 不退化。`eb74e07`
- **2026-04-27 14:30 — 后台能力分层：MCP / plugins / background-tasks 挪到 Customize → Advanced** —— 新增 renderAdvancedPage() 4 subsection；侧栏 Runtime → Advanced 入口 coerce；删 684 行死代码；regression 1057/1057；Codex B。`e9eb5b6`+`40c747b`
- **2026-04-27 14:00 — UI overlap 全局 audit：根因 .detail-card height: 100% 一处修光** —— 删 styles.css:3262 `height: 100%`，保留 min-height; 6 类 UI 叠加 audit 仅此一处中招。Codex A。`2731e90`
- **2026-04-27 13:30 — Codex C #16/#17/#18/#19 fix chain：customize grid 1101px+ 真实可用宽度** —— 三轮宽度+折叠 Codex C 闭环：grid 220/270/440 总 700px，撤单列折叠，修 ≤1100px overflow:hidden 裁切。`3022905`+`f20767b`+`bcc2b09`+`ae0a964`
- **2026-04-27 13:00 — Customize 页面布局调整：列宽 + 卡片间距 + 重复 .toggle-row 清理** —— grid 改 220/270/440-1fr；删旧 `.toggle-row` 副本；padding 14×16 给文字呼吸；`.skill-health-card` 加 margin-top。`ab06fca`
- **2026-04-27 12:30 — Codex C #15 fix：stale localStorage cache 不再回写覆盖 saved default** —— `src/shared/minimaxVoiceResolver.js` 抽出纯函数（cache 校验后才优先；stale cache 命中 fallback 链 + drop flag 清 localStorage）；10 个 unit case + 3 个 SECRET_LIKE 防擦 case，bisect 验证。（待 commit）
- **2026-04-27 12:00 — Codex C #14 fix：activate-minimax-voice 不再擦掉 saved Default Voice ID** —— client 优先链加 `bootstrap.settings.config.minimaxVoiceId` fallback + 三者都空时 toast 错误不发 POST；server `SECRET_LIKE_CONFIG_KEYS` 加 `minimaxVoiceId` 兜底防意外擦。（待 commit）
- **2026-04-27 11:30 — Codex C fix：MiniMax 数据契约统一 + 测试按钮支持 saved key** —— `connectorRollup.js` 给 connector config 加 4+4 字段（minimax/whisper），TTS 面板改读 `hasMinimaxKey`，`/api/tts/test-minimax` 表单空字段 fallback 到 saved。（待 commit）
- **2026-04-27 11:00 — MiniMax 完整配置入口：connector 表单 + agent voiceId 字段 + 测试播放** —— bootstrap 暴露 `hasMinimaxKey/maskedMinimaxApiKey/minimaxGroupId/minimaxVoiceId`；server 加 `POST /api/tts/test-minimax`；connector 表单加 4 input + Test 按钮；agent 编辑页加 minimaxVoiceId 字段。（待 commit）
- **2026-04-27 10:30 — Codex C #12 fix：WKWebView Browser voice 流式累积 + 末段一次播报** —— Desktop app 下 streaming TTS 累积成末段单播（WKWebView bridge 不支持 FIFO 队列）；真浏览器仍逐句 enqueue speechSynthesis。（待 commit）
- **2026-04-27 10:00 — Browser voice 在 desktop app 没声音 fix：路由到 Swift native bridge** —— `speakWithBrowser` 检测 `webkit.messageHandlers.meloVoice`，desktop app 走 Swift AVSpeechSynthesizer；voice picker 在 desktop 下 disabled + 提示。（待 commit）
- **2026-04-27 09:30 — TTS 拆清楚三种声音来源：Browser / macOS / Edge / MiniMax / API** —— 把"System voice"拆成 Browser voice（speechSynthesis）+ macOS voice（/usr/bin/say）；新加 `/api/tts/say-voices` 端点。（待 commit）
- **2026-04-27 09:00 — Codex B 跟进：OCR 受控测试 + ESRCH 严格断言** —— 加 `_setTesseractForTests` DI hook + 2 个 mid-createWorker / mid-recognize abort 测试；yt-dlp 测试 `process.kill(pid, 0)` 收紧到只接 `/ESRCH/`。（待 commit）
- **2026-04-27 08:30 — Codex C #11 fix：fake yt-dlp 改 exec 防 orphan + OCR 提前注册 abort listener** —— fake bash 末行 `sleep 99999` → `exec sleep`；`runOcrWithAbort` listener 提前到 createWorker 之前注册 + flag/workerRef 三种 abort 路径。（待 commit）
- **2026-04-27 08:00 — Codex B 跟进：OCR 改 Tesseract worker 可中断 + yt-dlp 测试反假绿加固** —— `Tesseract.recognize` 换成 `createWorker` + `worker.recognize` + 可 terminate；yt-dlp fake 写 4 marker 证明 SIGKILL 真生效。（待 commit）
- **2026-04-27 07:30 — Codex C #10 fix：videoExtractor 直接调 AbortSignal.any 改走 composeAbortSignals** —— 抽出 `composeAbortSignals(...signals)` 通用版；videoExtractor.js 3 处 `AbortSignal.any` 全替换；2 个 monkeypatch 回归证 fallback 仍 propagate。（待 commit）
- **2026-04-27 07:00 — Phase 4 第 1 刀：orchestrator abort 全链路 + 全 extractor signal 贯通** —— image / PDF / link / yt-dlp 信号链路一次扫干净；`combineSignals` 抽到 common.js；4 个 orchestrator-level integration test。（待 commit）
- **2026-04-27 06:30 — Codex B-grade follow-up：AbortSignal.any 兼容 fallback + 测试 fixture-fail 显式 skip** —— `combineSignals` 加 Node <20.3 manual fallback；whisper-cli 假绿测试改 `t.skip()`。`424cbe8`
- **2026-04-27 05:00 — audioExtractor signal 测试反假绿 + 下载阶段补 signal（C #6）** —— 加 `_setWhisperCliForTests` DI hook 解决 module-load 资源化；OpenAI 测试 authMode 改 'api-key'；新增 download abort 测试；`readAttachmentBuffer` 接 signal 走 combineSignals。`aadc7dd`
- **2026-04-27 04:30 — audioExtractor 全链路 signal 化（C #5）** —— `tryWhisperCpp` / `convertToWavForNative` 走 `execFileAsync({ signal })`；native + OpenAI fetch 走 combineSignals；3 个真 child-kill / fetch-abort 测试证明 backend 真响应 abort。`0ed90fd`
- **2026-04-27 04:00 — Video Phase 3 hardening：audio + keyframes 真并行** —— audio + keyframes 改 `Promise.all` 并行，独立 budget（audio 10s / keyframe 5s）；新增 `withAudioBudget` + `audioBranch`（spawnWithAbort 接 ffmpeg）；slow/hanging audio + 100ms budget → frames-only entry。`1f29b00`
- **2026-04-27 03:30 — Video Phase 3 落地：keyframes 不再依赖 transcript 成功** —— 加 `_setExtractAudioContentForTests` DI hook；audio 抽取 fail/null 时不再吞 keyframes，改返 `source: 'video-keyframes-only'` entry；意外抓到 silent-video 真 bug（ffmpeg -vn 在无音轨时 reject 整个 extraction）。`a5d855c`
- **2026-04-27 03:00 — Video Phase 2 修复 #2：abort 链路贯通 ffprobe + ffmpeg** —— 抽 `spawnWithAbort(bin, args, { signal, collectStdout, onSpawn })` 统一 child + signal 耦合；`probeDurationSec` 接受 signal；3 个 child-kill 测试用真挂死的 `node -e setInterval` 证 SIGKILL 实落地。`1dba8b4`
- **2026-04-27 02:30 — Video Phase 2 修复：keyframe 抽取 5s 硬超时** —— 加 `KEYFRAME_BUDGET_MS = 5000`、`extractKeyframes(_,_,{signal})` 接收 AbortSignal、`withKeyframeBudget(work, ms)` race 内部 AbortController 与 setTimeout，超时 SIGKILL ffmpeg 子进程 + resolve []，transcript 成头等公民。`5d33930`
- **2026-04-27 02:00 — Video Phase 2 上线：关键帧抽取（音轨 transcript + 5 张关键帧）** —— `videoExtractor.js` 加 `probeDurationSec` + `extractKeyframes`，每 N 秒一帧 / scale 512px / JPEG q4 / cap 8 张；`messageBuilder.js` 按 `attachmentId` 把 keyframes emit 成 `image_url` parts；UI 副标改 "transcript + keyframes"。后被 5d33930 / 1dba8b4 / a5d855c 多轮 Codex C-grade gate 修补。`adb21ca`
- **2026-04-27 01:35 — Video Phase 1：UI 文案诚实化** —— 视频 attachment 实际只走 `ffmpeg -vn` 抽音轨转写、无视觉信息，UI 加副标 "audio transcript only" / drop banner / caption hint 三处同步，避免用户误以为模型能看画面。`75b9370`
- **2026-04-27 01:10 — Composer Link 入口统一 URL 分类** —— `desktop-ui/app.js` 的 manual Link 改走 `promoteTextUrlsToAttachments`（共享 `/shared/urlDetector.js` 静态路由），YouTube/音频/视频/PDF/普通网页粘贴文字 vs 点 Link 得到同样的 kind/mimeType/title；6 个 promoted-shape 契约测试。`207ea6a`
- **2026-04-27 00:45 — Artifacts UI 按钮重新设计** —— Edit/Delete 改 `.small-button` 文字变体（is-outline / is-danger / is-primary），跟已有 Queue write 同款语言；删 unused pencil/trash icon；编辑表单加 surface-card 类对齐创建表单。`0a8064a`
- **2026-04-27 00:30 — Artifacts CRUD：补 service-layer 单元测试** —— `workspaceMutations.test.js` 加 8 个测试覆盖刚抽出的 `updateArtifact` + `deleteArtifact`（identity 保留 / 空 content 拒 / 未知 id 报错 / 项目 updatedAt bump 等），用 mkdtemp + dynamic-import + after()-cleanup 同款隔离模式。`fac4732`
- **2026-04-27 00:00 — Artifacts：只读产物架升级成可管理知识架** —— 修语义闭环（`artifact.summary` 不存在字段 → 改读 `artifact.content` 安全截断）；后端 + UI 加 update/delete CRUD（POST `/api/artifacts/update` / `/api/artifacts/delete`）；UI 加 Edit/Delete 按钮 + 编辑表单 + UUID + uiState.editingArtifact{Id,Draft}。`2777eab`
- **2026-04-26 23:30 — Phase 7d-5ζ：Telegram + Discord polling clusters 一并搬走** —— `src/services/remote/telegramPolling.js`(~610 行) + `discordPolling.js`(~750 行) byte-for-byte 抽出；desktopStore 净减 ~1140 行 → 2029（本会话累计 -76.2%）。`5419a9b`
- **2026-04-26 23:00 — Phase 7d-5ε commit 3：4 簇 mutations 一并抽走** —— project + task + workspace + approval = 17 funcs / 412 行，4 个 sibling leaf 模块同 commit 创建；workspaceMutations.js 后续作为 Artifacts CRUD 升级落点。`b997e14`
- **2026-04-26 22:30 — Phase 7d-5ε commit 2：抽出 Skill mutations 簇** —— `src/services/skill/skillMutations.js` byte-for-byte 把 10 个 exported skill CRUD 搬走（~331 行）。`208e51d`
- **2026-04-26 22:00 — Phase 7d-5ε commit 1：抽出 External Connector CRUD 簇** —— 7 个 exported CRUD 函数搬到 `src/services/connector/externalConnectorMutations.js`（~277 行）。`9721cd1`
- **2026-04-26 21:30 — desktopStore unused-import cleanup r2 + PROGRESS condense** —— 第二轮死 import 清理（9 整删 + 2 trim），同时 PROGRESS 从 189 → 127 行。`55b7630`
- **2026-04-26 21:00 — Phase 7d-5δ commit 8f：抽出 sendChatMessage（path B 真正收尾）+ scanRecentChatsForSkillProposals** —— `src/services/chat/sendChatMessage.js`（~360 行）+ `src/state/skillProposalScan.js`（49 行）；本会话累计突破半数 (-51.2%)。`9895335` + `f1ced20`
- **2026-04-26 20:30 — Phase 7d-5δ commit 8e：抽出 getDesktopBootstrap + 4 cluster-private helper** —— `src/state/desktopBootstrap.js`(~240 行)；getAgentMarkdownPaths 工厂用 lazy `() => join(getMeloHome(), ...)` 形式遵守 CLAUDE.md §6 调度时捕获 env。`0a05a30` + `e7d2872`
- **2026-04-26 20:00 — Phase 7d-5δ commit 8d：抽出 search-results builder 簇（644 行 6 函数 + 1 const，单 commit 第二大瘦身）** —— `src/services/search/searchResultsBuilder.js` byte-for-byte 抽走整个 cluster；getDesktopBootstrap 的最大 LOCAL 依赖。`edd3e76`
- **2026-04-26 19:30 — Phase 7d-5δ commit 8c：抽出 refreshChatMemorySummary + buildConnectors** —— refreshChatMemorySummary 追加到 chatThreadContext.js；buildConnectors 搬到新建 `src/services/connector/connectorRollup.js`（共 105 行）。`66cd1a8`
- **2026-04-26 19:00 — Phase 7d-5δ commit 8b：updateStateAtomically 搬回 state/stateStore.js（§5 carve-out 反转）** —— 13 行 helper 从 desktopStore byte-for-byte 搬到该住的 stateStore.js；§5 carve-out 失去存在理由后退役。`3c71ee6`
- **2026-04-26 18:30 — Phase 7d-5δ commit 8a：抽出 ensureSelectedEntities（最大 LOCAL 依赖，58 callers）** —— 67 行 selection-coercion helper 搬到 src/state/stateSelections.js；retire 了 §5 carve-out 的 ensureSelectedEntities 阻塞物，让 8b 能把 updateStateAtomically 搬回 stateStore。`9955870`
- **2026-04-26 18:00 — desktopStore unused-import cleanup（path B 完成后的 housekeeping）** —— Python 脚本扫 110 个 import block，22 整删 + 17 trim，共减 105 行；中间踩过"花括号里夹注释"导致 `projectAgentOverrideFor` 被误吞的小 bug，regression suite 即时抓到。`46a85b8`
- **2026-04-26 17:45 — Phase 7d-5δ commit 7d：smoke 测试加 MELO_HOME 隔离（gate 第 3 次 D + 数据丢失事件 + 恢复）** —— 此前 7c smoke 测试没隔离 MELO_HOME，运行时**真覆盖了 ~/.melo/desktop/state.json**；恢复 04-22 备份；测试加 mkdtemp + after() hook + mtime 哨兵双保险。`b4cc16a`
- **2026-04-26 17:00 — Phase 7d-5δ commit 7b：抽出 runChatAgentExecutionGraph 大象（517 行）** —— 单 commit 史上最大 byte-for-byte 抽取；getSharedSkillIndex 同行迁移；gate 一次 D（getAllTools 漏 import）即时修复。`9c76db9` + `91a25d9`
- **2026-04-26 16:45 — Phase 7d-5δ commit 7a：抽出 MODE_DEFS** —— 20 行静态数组，elephant 抽取的最后一个 prereq。`2f52bf2`
- **2026-04-26 16:30 — Phase 7d-5δ commit 6：抽出 runTaskAgentExecutionGraph（第一个 runner，pattern 验证通过）** —— 87 行任务执行图搬到 services/chat/taskExecutionRunner.js，零 desktopStore 反向 import。`ce97d12`
- **2026-04-26 16:00 — Phase 7d-5δ commit 5：抽出 effectiveAgentProfile + projectAgentOverrideFor** —— 两个 profile 组合 helper 放进现成的 state/agentProfiles.js；实查 8 callers 不是 57。`7055c17`
- **2026-04-26 15:30 — Phase 7d-5δ commit 4：抽出 taskExecutionPrompt** —— 26 行纯函数搬到 services/task/taskPrompt.js，唯一依赖 agentUsesTool 已是 leaf。`12e85aa`
- **2026-04-26 15:00 — Phase 7d-5δ commit 3：抽出 buildWorkspaceSnapshot（带 APP_ROOT 深度调整）** —— 52 行 async 搬到 services/workspace/workspaceSnapshot.js，APP_ROOT 用 4 个 dirname 重算（同 stateHydration 模式）。`f3f61d5`
- **2026-04-26 14:30 — Phase 7d-5δ commit 2：抽出 4 个 findXById finder 簇** —— `findProjectById/findExternalConnectorById/findTaskById/findApprovalById` 共 16 行搬到 src/state/stateLookups.js；35 callers 走 imported name。`be96ec6`
- **2026-04-26 14:00 — Phase 7d-5δ commit 1：抽出 chat-graph action planner 簇** —— 7 函数（normalizeGraphNeedle / planCommandAction / planExternalConnectorAction / 等 + planChatGraphAction + buildApprovalResponse）共 ~210 行搬到 services/chat/chatActionPlanning.js。`7866271`
- **2026-04-26 13:30 — Phase 7d-5γ commit 4：抽出 buildAgentMemoryNodeContext + 私有 helper（单 commit 史上最大瘦身 -330 行）** —— 337 行函数 + 5 行 latestUserMessageRecord 搬到 services/agent/agentMemoryContext.js；解码"Explore agent 报 7+ LOCAL deps，实查只 1 个"。`b30d563`
- **2026-04-26 13:00 — Phase 7d-5γ commit 3：抽出 buildChannelRoutePrompt（实查后是真叶子）** —— 117 行函数搬到 services/remote/channelRoutePrompt.js；中间踩过一个 import 路径错认（normalizeConversationSnippet 实际在 memory/heuristics.js 不在 viz/citation.js），被测试套件即时捕获。`8bda000`
- **2026-04-26 12:45 — Phase 7d-5γ commit 2：抽出 buildToolRoutingPrompt（拿到 S 评级）** —— commit 1 把 COMMAND_TEMPLATES 抽走后 buildToolRoutingPrompt 降级为零依赖叶子。Codex 评 S。`de7815c`
- **2026-04-26 12:30 — Phase 7d-5γ commit 1：抽出 COMMAND_TEMPLATES + commandTemplateDescriptor** —— 静态数据 + 专用 shaper 一起搬到新建 services/command/ 子目录，6 个内部 caller 走 imported name。`6e2e171`
- **2026-04-26 12:00 — Phase 7d-5β commit 3：抽出 buildDynamicContext + PROGRESS condense** —— 61 行 async 搬到 services/chat/dynamicContext.js；同 commit 把 fix-5/6/7 三个详细条目移入归档。`6d18e87`
- **2026-04-26 11:30 — Phase 7d-5β commit 2：抽出 buildProjectContextSection（单依赖）** —— 5 行函数搬到 services/project/projectContext.js，唯一依赖 agentUsesTool 已经是 leaf。`8364a5f`
- **2026-04-26 11:00 — Phase 7d-5β commit 1：4 真叶子 bundle commit + re-export fixup** —— matcherContext / connectorPrompts / skillPrompts / visionDebug 共一个 commit，gate 抓出 contract-break (C → A fixup)。`d056e8d` + `ce56b0c`
- **2026-04-26 10:15 — git pp B-finding 顺手修：commit_count == 0 早退出** —— 本地落后 upstream 时不再浪费一轮 Codex eval。`5742e66`
- **2026-04-26 10:00 — git pp 第二轮收紧：显式 refspec push** —— 用 `git push <remote> HEAD:<remote-branch>` 替代裸 `git push`，绕开 push.default 影响。`2c43ec2`
- **2026-04-26 09:30 — git pp 收紧范围：上游必需 + 拒绝额外参数** —— 强制 tracking upstream + 拒绝转发任何 args + pre/post 共用 base_sha。`137c9a6`
- **2026-04-26 09:00 — Phase 7d-5α-A1 fix-8：applyMemoryStoreSchema 返回 vecAvailable（第 8 次 C 评级修复）** —— vec_memories CREATE 失败时把 disposable handle 的 vec 标志降为 false，下游 _runReplaceMemoriesOn 不再 prepare 不存在的 vec_memories；fix-7 测试加固直接查 memories 行。`5d2c6ac`
- **2026-04-26 07:30 — Phase 7d-5α-A1 fix-7：memory store cross-home isolation（pre-push gate 第一次实战）** —— `applyMemoryStoreSchema` 抽出私有函数；`withDisposableStoreAt` + `runInTransactionOn` 给替代 storePath 走独立 sqlite 句柄；`getCachedEmbedding`/`resolveCacheModelId` 都接受 explicit database 参数（transitive call chain 隔离）；新增 fix-7 回归测试。`559fbae`
- **2026-04-26 06:30 — Phase 7d-5α-A1 fix-6：StateLoadContext 贯穿全 chain（结束 6 轮 isolation 修复）** —— 把 home 升格为 first-class context object：`checkpointer` 4 op + `hydrateChatThreads` + `persistChatThreads` 全部接受 `{ threadsDir }`；缓存改 by-dir 索引；`captureLoadContext` 扩展为 `{home, stateFilePath, threadsDir, getAgentMarkdownPaths}` 贯穿整个 load chain；新增 stateLoadContextChain.test.js（3 tests）。`f3b0f29`
- **2026-04-26 05:30 — Phase 7d-5α-A1 fix-5：readStateSnapshot 整体 home capture（CLAUDE.md §6 落到调用链）** —— `captureLoadContext()` 在 readStateSnapshot 入口一次性捕获 home + path + helpers，整个 load chain 共享；`saveState/persistStateAtomically` 接受 `capturedStatePath`；新增 readStateSnapshot full-chain capture 测试。`08cfab3`
- **2026-04-26 04:30 — Phase 7d-5α-A1 fix-4：async-timing capture (Q5-B + Q6-b + CLAUDE.md §6 落盘)** —— `queueAgentMarkdownPrime` + `importAgentMarkdownFiles` 改成调度/入口时一次性捕获 home-bound factory，async 体内禁止再读 env；CLAUDE.md §6 写入硬规则。`2063d9e`
- **2026-04-26 03:30 — Phase 7d-5α-A1 fix-3：cache-level cross-home isolation (Q3-B + Q4-b + 扩大 audit)** —— `checkpointCache` 改嵌套 `Map<home, Map<threadId>>`、`markdownPrimeQueued` 改 Set；4 项 module-level state 全审计无遗漏。`a104f23`
- **2026-04-26 02:30 — Phase 7d-5α-A1 commit 8+9 fix：MELO_HOME 隔离修复 (Q1a + Q2b)** —— `markdownSynced` 单 boolean → by-home Map；`createAgentMarkdownFileHelpers` 接受 lazy `() => agentsDir`；checkpointer.js 的 `THREADS_DIR` const 改 lazy。`808db9e`
- **2026-04-26 01:30 — Phase 7d-5α-A1 收尾 (Commit 8+9)：state-machine 全部搬出 desktopStore** —— 新增 `markdownSync.js` + `stateStore.js`（共 ~280 行）；desktopStore 净减 ~196 行（7304 → 7186）；`enqueueStateWrite` §5 carve-out。`856aa07`
- **2026-04-26 00:55 — Phase 7d-5α-A1 commit 7 fix：恢复 sanitizeWorkspacePath wrapper + 审计 commits 1-6** —— `stateHydration.js` 找回 1-arg local wrapper（绕 2-arg `Raw` 函数的 byte-for-byte 漏洞）；新增 10 个回归测试。`a6c1802`
- **2026-04-26 00:28 — git pp 改成 push 前先 evaluation** —— `scripts/codex-review.sh` 升级双门：pre-push evaluation 解析评级阻断 C/D，保留 post-push 兜底。（用户改，未单独 commit；后续被 `f4bc254` 替换）
- **2026-04-26 00:25 — Phase 7d-5α-A1 (Commit 7/9)：抽出 stateHydration 簇** —— 9 个 export（4 hydrate + 2 normalize + 1 helper + 4 const），`APP_ROOT` 多套一层 `dirname` 适配深 1 层目录。`7b051fa`
- **2026-04-25 23:55 — Phase 7d-5α-A1 (Commit 6/9)：抽出 mergeDiskSkillsIntoState** —— 41 行纯叶子搬到 `diskSkills.js`，desktopStore 的 `reloadDiskSkills` 从此 import。`c332b07`
- **2026-04-25 23:35 — Phase 7d-5α-A1 (Commit 5/9)：抽出 memorySnapshot 簇 (~400 行最大单 commit)** —— `syncMemoryStoreSnapshot` + `buildMemoryStoreEntries`(384 行) + `buildSpeakerMemoryNamespace`，零循环。`f0b528e`
- **2026-04-25 23:10 — Phase 7d-5α-A1 (Commit 4/9)：persistChatThreads 加入 chatPersistence.js** —— commit 3 已搬走 `ensureChatThreadContext`，所以 4 个 deps 全外部化。`8ab7817`
- **2026-04-25 22:55 — Phase 7d-5α-A1 (Commit 3/9)：抽出 chatThreadContext 簇** —— 9 个 export（cache helper + builder + checkpoint payload），后续 commit 4/7 的 prerequisite。`2cc94a8`
- **2026-04-25 22:30 — Phase 7d-5α-A1 (Commit 2/9)：抽出 serializeChatForPersistence 纯叶子** —— 17 行 pure object reshape 单独 commit；同时把原"7-commit 计划"修订为 9 commit。`4d81ef4`
- **2026-04-25 22:00 — Phase 7d-5α-A1 (Commit 1/7)：抽出 chatPruning（撤回 cec12c3 错方向，重做 path A）** —— 4 个 chat-pruning 符号搬到 `state/chatPruning.js`，byte-for-byte。`80efd7d`
- **2026-04-25 21:30 — Phase 7d-5α：暴露 state-machine helpers 为后续 elephant 移植铺路** —— 5 个函数加 `export` 关键字，纯加 export 不动逻辑。（无独立 commit hash；后续被 `856aa07` 调整覆盖）
- **2026-04-25 19:30 — Phase 7d-2：抽出 systemPrompt + CLAUDE.md §5 落盘** —— `buildReActSystemPrompt` + 5 helper 搬走（~210 行 + 25 测试）；§5 byte-for-byte 规则首次写入。`ffc477a`
- **2026-04-25 19:03 — 增加 git pp 后 D/C/B/A/S 质量评估 gate + codex.md 改本地派生** —— `EVALUATION.md` 写入五档评分；`codex.md` 加进 `.gitignore`。`1f636e2`
- **2026-04-25 00:20 — Phase 7d-1：抽出 messageBuilder (chatExecutionService 拆解 ①/N)** —— 8 函数 + 9 常量搬走（~280 行），desktopStore 净减 269 行（最大单次瘦身），首次发现"简化重写"陷阱并回退。`8c387a4`
- **2026-04-24 23:45 — Phase 7c：抽出 agentProfileService 纯逻辑核心** —— 3 块纯逻辑（normalize patch / stale-draft guard / new agent seed），18 个新单元测试。`7250cd7`
- **2026-04-24 23:00 — Phase 7b：抽出 workspaceService + 强化 review prompt** —— 3 个 workspace I/O 函数 + 测试；`codex-review.sh` 强制 4 步探索流程。`33aba21` + `0f7d2af`
- **2026-04-24 22:10 — Phase 7a：抽出 searchService (desktopStore 解耦 ①/④)** —— 2 个 search 函数搬到 `services/search/`，DI 边界 + 薄壳 re-export 范式确立。`8c03a68`
- **2026-04-24 21:47 — `npm run progress:codex` 自动生成 codex.md 快照** —— 跨会话快速接续机制。`3fcbdea`
- **2026-04-24 21:30 — 首次远程推送 + 工作协议落盘** —— 配置 `origin = github.com/MortredVigoss/Melo`，3 个积压 commit 全量推送。`5f128c6` + `8fb3cf9` + `f87c06c`
- **2026-04-24 20:00 — 修复图片生成 HTTP 400** —— `/codex/responses` 请求体加 `instructions` 字段，模型不再编造"等了 180 秒"。`8fb3cf9`
- **2026-04-24 19:00 — 修复 4 处历史测试失败** —— `audioExtractor.js` 加 codex-env-fallback；`openai.js` 去掉 `[Audio attachment: …]` 占位符。`5f128c6`
- **2026-04-24 14:00 — 初始化工作协议** —— 新建 `CLAUDE.md`（三条硬性规则）和 `PROGRESS.md`。`f87c06c`

- **2026-04-30 11:30 — 独立 image edit pipeline（用户产品级 audit 落实）** —— `codexImageEngine.editImageViaCodex` 两阶段（vision analysis → 短 edit prompt scaffold）+ `detectImageEditIntent` + chat fast-path 短路 ReAct loop；Codex D SSRF guard 收紧到 data-URI ONLY（拒所有 http(s)）；2 轮 C 收紧 `IMAGE_FOLLOW_UP_PATTERN` 仅 image-OBJECT 短语 + Gate 5 双 pattern 同时为真才 fire（防 "把这个函数改成 async" 误编辑截图）。`41d20cf` + `94518d0` + `2a417b2` + `7a871de` + `d64bfc0` + `fcafa6d`
- **2026-04-30 09:30 — Codex 内联图编辑模式（image-to-image edit）** —— `messagesHaveInputImages` + `buildCodexResponsesTools(hasInputImage)` + `CODEX_INLINE_IMAGE_EDIT_INSTRUCTION` 三件套；4 轮 Codex C 修后撤销 effectiveModel→gpt-5.5 silent swap、保留 caller's model；用户实测 Codex 拒 input_fidelity → 改 bare `{type:'image_generation'}` 形态。`2618ec5` + `672b2c0` + `bc640c1` + `3ab34b5`
- **2026-04-29 00:30 — Codex chat 流内联图：image_generation tool 真正打通** —— `createCodexResponsesReply` 加 workspacePath 参数启用裸 image_generation tool；`readCodexSseResponse` 抓 `image_generation_call.done` emit markdown URL 注入 deltaText；3 轮 Codex C 修真 bug（dedup tracker vs emit tracker 拆 / final-text 必须含 prose+image / mime sniff strict by magic-byte，不信 output_format）。`1f17365` + `e7a7311` + `6edfc5e`
- **2026-04-28 13:30 — 用户截图反馈三连：MiniMax key 保存丢值 + 模型版本 + Voice 面板高度** —— 真因：connector-config 表单没接 draft mirror，password input 每次 background render 回 SSR `value=""` → 提交空被 keepIfBlank 当 preserve；后续 17+ 轮 Codex C/D 分别修 dispatcher / autosave / `_autosaveRevision` gate / `withConfigLock` 原子化 / refreshModelCatalog 锁外 discovery / catalog-only 契约（loadConfig + getResolvedConfig + getDesktopBootstrap 全链 `skipModelNormalize`）。`28a47b1` … `554c079`
- **2026-04-28 12:30 — Codex D 第三轮：initMcpServers 无条件 reconcile + 抽出可测模块** —— 去 `hasServers` 短路（empty config 也跑 reconciler）；抽 [src/mcp/init.js](src/mcp/init.js) DI hook 可测；toolId.test.js 里 NUL 字节修成 unicode escape 让 git 当 text。`479a897` + `5a9afa9`
- **2026-04-28 12:00 — Codex C 第四轮：MCP server id 契约 + 共享 toolId helper（safe vs safe:evil）** —— 新建 [src/mcp/toolId.js](src/mcp/toolId.js) `MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/`，用 `parseMcpToolId` 替 `split(':')[1]` 防 agent 授权 `safe` 静默放行 `safe:evil`；启动时 stderr 警告非法 server name。`3876cdc`
- **2026-04-28 11:30 — Codex C 第三轮：agentDraftFor 漏 enabledMcpServerIds → 静默清空 + stale 撤销失效** —— 抽 [desktop-ui/agentDraft.js](desktop-ui/agentDraft.js) `agentDraftFromProfile(agent)` 纯函数补 `enabledMcpServerIds: Array.isArray(...) ? [...] : []` deny-all 默认；12 个契约测试覆盖 round-trip 保留、unsubmitted 不丢、stale chip whitelist 撤销路径。`75f9f72`
- **2026-04-28 11:00 — Codex D 第二轮：MCP lifecycle reconciler（全局 disable 真生效）** —— `bootstrapMcpServers` 加 reconciler phase，先 disconnect stale active 再 connect effective；`connectMcpServer(disabled)` 也 disconnect 旧 client；抽 `reconcileMcpLifecycle` 纯函数 + 7 lifecycle 测试。`6957783`
- **2026-04-28 10:30 — Codex C 第二轮：mcpAuthSurface 统一 + boolean 严格 + 测试 NUL 修复** —— bootstrap 暴露 built-in ∪ user MCP 的 union surface（之前 UI 只列 built-in，user MCP 死锁）；`/api/mcp/preset-toggle` 严格 `typeof === 'boolean'`；test 文件里 NUL 字节用 python 替换。`4d9dc73`
- **2026-04-28 10:00 — Codex D 第一轮：MCP 默认全关 + cwd reframe + path 加严 + agent UI 撤销** —— md2pdf 默认改 false（4 层模型）；cwd 不再叫 sandbox（不限制绝对路径），改 default working dir；path 禁 `.`/`..`/无字母数字 leaf + resolve 校验 root；chip 改 CSS 类（仍可点撤销已有授权）；README 加 4 层状态文档。`799a9a4`
- **2026-04-28 09:00 — MCP 全局接入 + per-agent 白名单 + Advanced UI（AntV chart + markdown→pdf）** —— 4 phase 一次性：BUILTIN_MCP_PRESETS（antv-chart + markdown2pdf）+ McpStdioClient cwd + 默认 cwd 子目录；agent profile `enabledMcpServerIds`（deny-all）+ filterMcpToolsForAgent prompt/dispatch 双 enforcement；buildMcpTool 默认 requiresPermission=true 走 approval；bootstrap mcpPresets[] + Advanced toggle UI + agent customize chip-row + `/api/mcp/preset-toggle` 端点。30 新单测，1133/1133 全绿。`8778052` + `3ae3285`
- **2026-04-27 16:50 — TTS / 视频 / 配置入口 4 处体验断点** —— Voice 面板加 Auto radio + WKWebView 改名 Desktop native voice + 视频附件 chip 读 extractedMedia 显示真实状态 + Voice 面板加配置 MiniMax/Whisper 跳转。`9f5a87a`
- **2026-04-27 19:30 — Codex D fix: desktopStore re-export gap + server import smoke net** — af2e3b7→768d511 left `restoreArtifact`/`purgeStaleSoftDeletes` un-re-exported, server boot would throw on first ESM load; added the missing re-exports + `src/server.imports.smoke.test.js` (parses server.js import list and asserts every name is reachable through desktopStore). Codex S. `5a888ee`
- **2026-04-27 19:00 — Codex C round 2: artifact soft-delete reader audit + 11 regression tests** — af2e3b7 missed 4 readers (dynamicContext/search/apply/connector count); added `isLiveArtifact`/`visibleArtifacts` helper, wired 7 readers, +11 tests. `768d511`
- **2026-04-27 18:30 — artifact soft-delete contract → server-driven** — `e1a8ecf` used a client setTimeout (timer lost on reload) → Codex C; switched to server-side `deletedAt` + `/api/artifacts/restore` + 7d GC, client became fire-and-forget pair, 17 backend tests. `af2e3b7`
- **2026-04-27 18:00 — 5 处次级 UX 体验提升** —— 批 1 `5f9107a`：PDF 入口 + Advanced Copy state.json + Tasks lane overflow + Search 空状态分类提示 + showFlashToast helper。批 2 `e1a8ecf`：artifacts 软删 + undo toast 第一版（client-timer，被 18:30 D-grade 改成 server-driven）；undoToast.js + 16 单测。test:ui 71/71，memory 330/330。
- **2026-04-27 17:30 — desktop-ui test harness 落地** —— byte-for-byte port `describeVideoExtractionStatus` + 拆 `renderAdvancedPage` 成显式 props；`npm run test:ui` 52/52 全绿；闭环 14:30 Advanced B + 本批 ⚪ 两条 same-root follow-up；后续 desktop-ui "抽纯函数 + .test.js" 标准模式确立。Codex S。`a9aa5a8`+`7a6710e`
- **2026-04-27 16:25 — Codex B 第三轮：threshold capture 真正 mid-call 锁定** —— compactQualityThreshold 始终返回 finite number（空/非法 → 0.6 默认），evaluator 不再回头读 env；contract test 锁定 mid-call env 突变不影响 fallback 决定。`da4e09e`
- **2026-04-27 16:10 — Codex B 追加 follow-up：MELO_SUMMARY_QUALITY_THRESHOLD="" 边界** —— `Number('') === 0` 让 fallback 全放行；trim + 空字符串短路 + 2 回归测试。`d339782`
- **2026-04-27 15:55 — Codex B 4 条 follow-up：bench rank / vec-aware / threshold capture / fallback DI** —— 🔵 `--rank tier\|global` 默认 tier；🟡 `embeddingActive && vecAvailable` 才报 ANN；🟡 入口 capture threshold；⚪ `_setCallLocalLlmForTests` DI hook + 4 mock 测试。`9d504b2`
- **2026-04-27 15:30 — F-3C：README "Memory and embeddings" 节落地** —— bge-m3 onboarding 引导（`ollama pull bge-m3` + 4 级降级链 + env 矩阵 + bench 跑法）；闭环最后一条横评扣分项。`dece161`
- **2026-04-27 15:15 — F-2C：reference-free summary quality + dreams diary 接入** —— 新增 `src/memory/dreaming/summaryQuality.js`（length / entityCoverage / tokenGroundedness 三指标 score = 0.1+0.4+0.5）+ `auditSummary` 写当日 DREAMS.md；`compact.js` 接入按 `MELO_COMPACT_QUALITY_GATE` 处理 LLM 输出；18 新单测 + memory 套 323/323 全绿。`aad4f72`
- **2026-04-27 14:45 — F-1A：memory retrieval bench（黄金集 + recall@k 报告）** —— 新增 `bench/memory/{golden.example.json, README.md}` + `scripts/bench-memory.js` + npm `bench:memory`；支持 `--no-embed` / `--validate` / `--json` / `--threshold-recall5` CI gate；305/305 memory tests 不退化。`eb74e07`
- **2026-04-27 14:30 — 后台能力分层：MCP / plugins / background-tasks 挪到 Customize → Advanced** —— 新增 renderAdvancedPage() 4 subsection；侧栏 Runtime → Advanced 入口 coerce；删 684 行死代码；regression 1057/1057；Codex B。`e9eb5b6`+`40c747b`
- **2026-04-27 14:00 — UI overlap 全局 audit：根因 .detail-card height: 100% 一处修光** —— 删 styles.css:3262 `height: 100%`，保留 min-height; 6 类 UI 叠加 audit 仅此一处中招。Codex A。`2731e90`
- **2026-04-27 13:30 — Codex C #16/#17/#18/#19 fix chain：customize grid 1101px+ 真实可用宽度** —— 三轮宽度+折叠 Codex C 闭环：grid 220/270/440 总 700px，撤单列折叠，修 ≤1100px overflow:hidden 裁切。`3022905`+`f20767b`+`bcc2b09`+`ae0a964`
- **2026-04-27 13:00 — Customize 页面布局调整：列宽 + 卡片间距 + 重复 .toggle-row 清理** —— grid 改 220/270/440-1fr；删旧 `.toggle-row` 副本；padding 14×16 给文字呼吸；`.skill-health-card` 加 margin-top。`ab06fca`
- **2026-04-27 12:30 — Codex C #15 fix：stale localStorage cache 不再回写覆盖 saved default** —— `src/shared/minimaxVoiceResolver.js` 抽出纯函数（cache 校验后才优先；stale cache 命中 fallback 链 + drop flag 清 localStorage）；10 个 unit case + 3 个 SECRET_LIKE 防擦 case，bisect 验证。（待 commit）
- **2026-04-27 12:00 — Codex C #14 fix：activate-minimax-voice 不再擦掉 saved Default Voice ID** —— client 优先链加 `bootstrap.settings.config.minimaxVoiceId` fallback + 三者都空时 toast 错误不发 POST；server `SECRET_LIKE_CONFIG_KEYS` 加 `minimaxVoiceId` 兜底防意外擦。（待 commit）
- **2026-04-27 11:30 — Codex C fix：MiniMax 数据契约统一 + 测试按钮支持 saved key** —— `connectorRollup.js` 给 connector config 加 4+4 字段（minimax/whisper），TTS 面板改读 `hasMinimaxKey`，`/api/tts/test-minimax` 表单空字段 fallback 到 saved。（待 commit）
- **2026-04-27 11:00 — MiniMax 完整配置入口：connector 表单 + agent voiceId 字段 + 测试播放** —— bootstrap 暴露 `hasMinimaxKey/maskedMinimaxApiKey/minimaxGroupId/minimaxVoiceId`；server 加 `POST /api/tts/test-minimax`；connector 表单加 4 input + Test 按钮；agent 编辑页加 minimaxVoiceId 字段。（待 commit）
- **2026-04-27 10:30 — Codex C #12 fix：WKWebView Browser voice 流式累积 + 末段一次播报** —— Desktop app 下 streaming TTS 累积成末段单播（WKWebView bridge 不支持 FIFO 队列）；真浏览器仍逐句 enqueue speechSynthesis。（待 commit）
- **2026-04-27 10:00 — Browser voice 在 desktop app 没声音 fix：路由到 Swift native bridge** —— `speakWithBrowser` 检测 `webkit.messageHandlers.meloVoice`，desktop app 走 Swift AVSpeechSynthesizer；voice picker 在 desktop 下 disabled + 提示。（待 commit）
- **2026-04-27 09:30 — TTS 拆清楚三种声音来源：Browser / macOS / Edge / MiniMax / API** —— 把"System voice"拆成 Browser voice（speechSynthesis）+ macOS voice（/usr/bin/say）；新加 `/api/tts/say-voices` 端点。（待 commit）
- **2026-04-27 09:00 — Codex B 跟进：OCR 受控测试 + ESRCH 严格断言** —— 加 `_setTesseractForTests` DI hook + 2 个 mid-createWorker / mid-recognize abort 测试；yt-dlp 测试 `process.kill(pid, 0)` 收紧到只接 `/ESRCH/`。（待 commit）
- **2026-04-27 08:30 — Codex C #11 fix：fake yt-dlp 改 exec 防 orphan + OCR 提前注册 abort listener** —— fake bash 末行 `sleep 99999` → `exec sleep`；`runOcrWithAbort` listener 提前到 createWorker 之前注册 + flag/workerRef 三种 abort 路径。（待 commit）
- **2026-04-27 08:00 — Codex B 跟进：OCR 改 Tesseract worker 可中断 + yt-dlp 测试反假绿加固** —— `Tesseract.recognize` 换成 `createWorker` + `worker.recognize` + 可 terminate；yt-dlp fake 写 4 marker 证明 SIGKILL 真生效。（待 commit）
- **2026-04-27 07:30 — Codex C #10 fix：videoExtractor 直接调 AbortSignal.any 改走 composeAbortSignals** —— 抽出 `composeAbortSignals(...signals)` 通用版；videoExtractor.js 3 处 `AbortSignal.any` 全替换；2 个 monkeypatch 回归证 fallback 仍 propagate。（待 commit）
- **2026-04-27 07:00 — Phase 4 第 1 刀：orchestrator abort 全链路 + 全 extractor signal 贯通** —— image / PDF / link / yt-dlp 信号链路一次扫干净；`combineSignals` 抽到 common.js；4 个 orchestrator-level integration test。（待 commit）
- **2026-04-27 06:30 — Codex B-grade follow-up：AbortSignal.any 兼容 fallback + 测试 fixture-fail 显式 skip** —— `combineSignals` 加 Node <20.3 manual fallback；whisper-cli 假绿测试改 `t.skip()`。`424cbe8`
- **2026-04-27 05:00 — audioExtractor signal 测试反假绿 + 下载阶段补 signal（C #6）** —— 加 `_setWhisperCliForTests` DI hook 解决 module-load 资源化；OpenAI 测试 authMode 改 'api-key'；新增 download abort 测试；`readAttachmentBuffer` 接 signal 走 combineSignals。`aadc7dd`
- **2026-04-27 04:30 — audioExtractor 全链路 signal 化（C #5）** —— `tryWhisperCpp` / `convertToWavForNative` 走 `execFileAsync({ signal })`；native + OpenAI fetch 走 combineSignals；3 个真 child-kill / fetch-abort 测试证明 backend 真响应 abort。`0ed90fd`
- **2026-04-27 04:00 — Video Phase 3 hardening：audio + keyframes 真并行** —— audio + keyframes 改 `Promise.all` 并行，独立 budget（audio 10s / keyframe 5s）；新增 `withAudioBudget` + `audioBranch`（spawnWithAbort 接 ffmpeg）；slow/hanging audio + 100ms budget → frames-only entry。`1f29b00`
- **2026-04-27 03:30 — Video Phase 3 落地：keyframes 不再依赖 transcript 成功** —— 加 `_setExtractAudioContentForTests` DI hook；audio 抽取 fail/null 时不再吞 keyframes，改返 `source: 'video-keyframes-only'` entry；意外抓到 silent-video 真 bug（ffmpeg -vn 在无音轨时 reject 整个 extraction）。`a5d855c`
- **2026-04-27 03:00 — Video Phase 2 修复 #2：abort 链路贯通 ffprobe + ffmpeg** —— 抽 `spawnWithAbort(bin, args, { signal, collectStdout, onSpawn })` 统一 child + signal 耦合；`probeDurationSec` 接受 signal；3 个 child-kill 测试用真挂死的 `node -e setInterval` 证 SIGKILL 实落地。`1dba8b4`
- **2026-04-27 02:30 — Video Phase 2 修复：keyframe 抽取 5s 硬超时** —— 加 `KEYFRAME_BUDGET_MS = 5000`、`extractKeyframes(_,_,{signal})` 接收 AbortSignal、`withKeyframeBudget(work, ms)` race 内部 AbortController 与 setTimeout，超时 SIGKILL ffmpeg 子进程 + resolve []，transcript 成头等公民。`5d33930`
- **2026-04-27 02:00 — Video Phase 2 上线：关键帧抽取（音轨 transcript + 5 张关键帧）** —— `videoExtractor.js` 加 `probeDurationSec` + `extractKeyframes`，每 N 秒一帧 / scale 512px / JPEG q4 / cap 8 张；`messageBuilder.js` 按 `attachmentId` 把 keyframes emit 成 `image_url` parts；UI 副标改 "transcript + keyframes"。后被 5d33930 / 1dba8b4 / a5d855c 多轮 Codex C-grade gate 修补。`adb21ca`
- **2026-04-27 01:35 — Video Phase 1：UI 文案诚实化** —— 视频 attachment 实际只走 `ffmpeg -vn` 抽音轨转写、无视觉信息，UI 加副标 "audio transcript only" / drop banner / caption hint 三处同步，避免用户误以为模型能看画面。`75b9370`
- **2026-04-27 01:10 — Composer Link 入口统一 URL 分类** —— `desktop-ui/app.js` 的 manual Link 改走 `promoteTextUrlsToAttachments`（共享 `/shared/urlDetector.js` 静态路由），YouTube/音频/视频/PDF/普通网页粘贴文字 vs 点 Link 得到同样的 kind/mimeType/title；6 个 promoted-shape 契约测试。`207ea6a`
- **2026-04-27 00:45 — Artifacts UI 按钮重新设计** —— Edit/Delete 改 `.small-button` 文字变体（is-outline / is-danger / is-primary），跟已有 Queue write 同款语言；删 unused pencil/trash icon；编辑表单加 surface-card 类对齐创建表单。`0a8064a`
- **2026-04-27 00:30 — Artifacts CRUD：补 service-layer 单元测试** —— `workspaceMutations.test.js` 加 8 个测试覆盖刚抽出的 `updateArtifact` + `deleteArtifact`（identity 保留 / 空 content 拒 / 未知 id 报错 / 项目 updatedAt bump 等），用 mkdtemp + dynamic-import + after()-cleanup 同款隔离模式。`fac4732`
- **2026-04-27 00:00 — Artifacts：只读产物架升级成可管理知识架** —— 修语义闭环（`artifact.summary` 不存在字段 → 改读 `artifact.content` 安全截断）；后端 + UI 加 update/delete CRUD（POST `/api/artifacts/update` / `/api/artifacts/delete`）；UI 加 Edit/Delete 按钮 + 编辑表单 + UUID + uiState.editingArtifact{Id,Draft}。`2777eab`
- **2026-04-26 23:30 — Phase 7d-5ζ：Telegram + Discord polling clusters 一并搬走** —— `src/services/remote/telegramPolling.js`(~610 行) + `discordPolling.js`(~750 行) byte-for-byte 抽出；desktopStore 净减 ~1140 行 → 2029（本会话累计 -76.2%）。`5419a9b`
- **2026-04-26 23:00 — Phase 7d-5ε commit 3：4 簇 mutations 一并抽走** —— project + task + workspace + approval = 17 funcs / 412 行，4 个 sibling leaf 模块同 commit 创建；workspaceMutations.js 后续作为 Artifacts CRUD 升级落点。`b997e14`
- **2026-04-26 22:30 — Phase 7d-5ε commit 2：抽出 Skill mutations 簇** —— `src/services/skill/skillMutations.js` byte-for-byte 把 10 个 exported skill CRUD 搬走（~331 行）。`208e51d`
- **2026-04-26 22:00 — Phase 7d-5ε commit 1：抽出 External Connector CRUD 簇** —— 7 个 exported CRUD 函数搬到 `src/services/connector/externalConnectorMutations.js`（~277 行）。`9721cd1`
- **2026-04-26 21:30 — desktopStore unused-import cleanup r2 + PROGRESS condense** —— 第二轮死 import 清理（9 整删 + 2 trim），同时 PROGRESS 从 189 → 127 行。`55b7630`
- **2026-04-26 21:00 — Phase 7d-5δ commit 8f：抽出 sendChatMessage（path B 真正收尾）+ scanRecentChatsForSkillProposals** —— `src/services/chat/sendChatMessage.js`（~360 行）+ `src/state/skillProposalScan.js`（49 行）；本会话累计突破半数 (-51.2%)。`9895335` + `f1ced20`
- **2026-04-26 20:30 — Phase 7d-5δ commit 8e：抽出 getDesktopBootstrap + 4 cluster-private helper** —— `src/state/desktopBootstrap.js`(~240 行)；getAgentMarkdownPaths 工厂用 lazy `() => join(getMeloHome(), ...)` 形式遵守 CLAUDE.md §6 调度时捕获 env。`0a05a30` + `e7d2872`
- **2026-04-26 20:00 — Phase 7d-5δ commit 8d：抽出 search-results builder 簇（644 行 6 函数 + 1 const，单 commit 第二大瘦身）** —— `src/services/search/searchResultsBuilder.js` byte-for-byte 抽走整个 cluster；getDesktopBootstrap 的最大 LOCAL 依赖。`edd3e76`
- **2026-04-26 19:30 — Phase 7d-5δ commit 8c：抽出 refreshChatMemorySummary + buildConnectors** —— refreshChatMemorySummary 追加到 chatThreadContext.js；buildConnectors 搬到新建 `src/services/connector/connectorRollup.js`（共 105 行）。`66cd1a8`
- **2026-04-26 19:00 — Phase 7d-5δ commit 8b：updateStateAtomically 搬回 state/stateStore.js（§5 carve-out 反转）** —— 13 行 helper 从 desktopStore byte-for-byte 搬到该住的 stateStore.js；§5 carve-out 失去存在理由后退役。`3c71ee6`
- **2026-04-26 18:30 — Phase 7d-5δ commit 8a：抽出 ensureSelectedEntities（最大 LOCAL 依赖，58 callers）** —— 67 行 selection-coercion helper 搬到 src/state/stateSelections.js；retire 了 §5 carve-out 的 ensureSelectedEntities 阻塞物，让 8b 能把 updateStateAtomically 搬回 stateStore。`9955870`
- **2026-04-26 18:00 — desktopStore unused-import cleanup（path B 完成后的 housekeeping）** —— Python 脚本扫 110 个 import block，22 整删 + 17 trim，共减 105 行；中间踩过"花括号里夹注释"导致 `projectAgentOverrideFor` 被误吞的小 bug，regression suite 即时抓到。`46a85b8`
- **2026-04-26 17:45 — Phase 7d-5δ commit 7d：smoke 测试加 MELO_HOME 隔离（gate 第 3 次 D + 数据丢失事件 + 恢复）** —— 此前 7c smoke 测试没隔离 MELO_HOME，运行时**真覆盖了 ~/.melo/desktop/state.json**；恢复 04-22 备份；测试加 mkdtemp + after() hook + mtime 哨兵双保险。`b4cc16a`
- **2026-04-26 17:00 — Phase 7d-5δ commit 7b：抽出 runChatAgentExecutionGraph 大象（517 行）** —— 单 commit 史上最大 byte-for-byte 抽取；getSharedSkillIndex 同行迁移；gate 一次 D（getAllTools 漏 import）即时修复。`9c76db9` + `91a25d9`
- **2026-04-26 16:45 — Phase 7d-5δ commit 7a：抽出 MODE_DEFS** —— 20 行静态数组，elephant 抽取的最后一个 prereq。`2f52bf2`
- **2026-04-26 16:30 — Phase 7d-5δ commit 6：抽出 runTaskAgentExecutionGraph（第一个 runner，pattern 验证通过）** —— 87 行任务执行图搬到 services/chat/taskExecutionRunner.js，零 desktopStore 反向 import。`ce97d12`
- **2026-04-26 16:00 — Phase 7d-5δ commit 5：抽出 effectiveAgentProfile + projectAgentOverrideFor** —— 两个 profile 组合 helper 放进现成的 state/agentProfiles.js；实查 8 callers 不是 57。`7055c17`
- **2026-04-26 15:30 — Phase 7d-5δ commit 4：抽出 taskExecutionPrompt** —— 26 行纯函数搬到 services/task/taskPrompt.js，唯一依赖 agentUsesTool 已是 leaf。`12e85aa`
- **2026-04-26 15:00 — Phase 7d-5δ commit 3：抽出 buildWorkspaceSnapshot（带 APP_ROOT 深度调整）** —— 52 行 async 搬到 services/workspace/workspaceSnapshot.js，APP_ROOT 用 4 个 dirname 重算（同 stateHydration 模式）。`f3f61d5`
- **2026-04-26 14:30 — Phase 7d-5δ commit 2：抽出 4 个 findXById finder 簇** —— `findProjectById/findExternalConnectorById/findTaskById/findApprovalById` 共 16 行搬到 src/state/stateLookups.js；35 callers 走 imported name。`be96ec6`
- **2026-04-26 14:00 — Phase 7d-5δ commit 1：抽出 chat-graph action planner 簇** —— 7 函数（normalizeGraphNeedle / planCommandAction / planExternalConnectorAction / 等 + planChatGraphAction + buildApprovalResponse）共 ~210 行搬到 services/chat/chatActionPlanning.js。`7866271`
- **2026-04-26 13:30 — Phase 7d-5γ commit 4：抽出 buildAgentMemoryNodeContext + 私有 helper（单 commit 史上最大瘦身 -330 行）** —— 337 行函数 + 5 行 latestUserMessageRecord 搬到 services/agent/agentMemoryContext.js；解码"Explore agent 报 7+ LOCAL deps，实查只 1 个"。`b30d563`
- **2026-04-26 13:00 — Phase 7d-5γ commit 3：抽出 buildChannelRoutePrompt（实查后是真叶子）** —— 117 行函数搬到 services/remote/channelRoutePrompt.js；中间踩过一个 import 路径错认（normalizeConversationSnippet 实际在 memory/heuristics.js 不在 viz/citation.js），被测试套件即时捕获。`8bda000`
- **2026-04-26 12:45 — Phase 7d-5γ commit 2：抽出 buildToolRoutingPrompt（拿到 S 评级）** —— commit 1 把 COMMAND_TEMPLATES 抽走后 buildToolRoutingPrompt 降级为零依赖叶子。Codex 评 S。`de7815c`
- **2026-04-26 12:30 — Phase 7d-5γ commit 1：抽出 COMMAND_TEMPLATES + commandTemplateDescriptor** —— 静态数据 + 专用 shaper 一起搬到新建 services/command/ 子目录，6 个内部 caller 走 imported name。`6e2e171`
- **2026-04-26 12:00 — Phase 7d-5β commit 3：抽出 buildDynamicContext + PROGRESS condense** —— 61 行 async 搬到 services/chat/dynamicContext.js；同 commit 把 fix-5/6/7 三个详细条目移入归档。`6d18e87`
- **2026-04-26 11:30 — Phase 7d-5β commit 2：抽出 buildProjectContextSection（单依赖）** —— 5 行函数搬到 services/project/projectContext.js，唯一依赖 agentUsesTool 已经是 leaf。`8364a5f`
- **2026-04-26 11:00 — Phase 7d-5β commit 1：4 真叶子 bundle commit + re-export fixup** —— matcherContext / connectorPrompts / skillPrompts / visionDebug 共一个 commit，gate 抓出 contract-break (C → A fixup)。`d056e8d` + `ce56b0c`
- **2026-04-26 10:15 — git pp B-finding 顺手修：commit_count == 0 早退出** —— 本地落后 upstream 时不再浪费一轮 Codex eval。`5742e66`
- **2026-04-26 10:00 — git pp 第二轮收紧：显式 refspec push** —— 用 `git push <remote> HEAD:<remote-branch>` 替代裸 `git push`，绕开 push.default 影响。`2c43ec2`
- **2026-04-26 09:30 — git pp 收紧范围：上游必需 + 拒绝额外参数** —— 强制 tracking upstream + 拒绝转发任何 args + pre/post 共用 base_sha。`137c9a6`
- **2026-04-26 09:00 — Phase 7d-5α-A1 fix-8：applyMemoryStoreSchema 返回 vecAvailable（第 8 次 C 评级修复）** —— vec_memories CREATE 失败时把 disposable handle 的 vec 标志降为 false，下游 _runReplaceMemoriesOn 不再 prepare 不存在的 vec_memories；fix-7 测试加固直接查 memories 行。`5d2c6ac`
- **2026-04-26 07:30 — Phase 7d-5α-A1 fix-7：memory store cross-home isolation（pre-push gate 第一次实战）** —— `applyMemoryStoreSchema` 抽出私有函数；`withDisposableStoreAt` + `runInTransactionOn` 给替代 storePath 走独立 sqlite 句柄；`getCachedEmbedding`/`resolveCacheModelId` 都接受 explicit database 参数（transitive call chain 隔离）；新增 fix-7 回归测试。`559fbae`
- **2026-04-26 06:30 — Phase 7d-5α-A1 fix-6：StateLoadContext 贯穿全 chain（结束 6 轮 isolation 修复）** —— 把 home 升格为 first-class context object：`checkpointer` 4 op + `hydrateChatThreads` + `persistChatThreads` 全部接受 `{ threadsDir }`；缓存改 by-dir 索引；`captureLoadContext` 扩展为 `{home, stateFilePath, threadsDir, getAgentMarkdownPaths}` 贯穿整个 load chain；新增 stateLoadContextChain.test.js（3 tests）。`f3b0f29`
- **2026-04-26 05:30 — Phase 7d-5α-A1 fix-5：readStateSnapshot 整体 home capture（CLAUDE.md §6 落到调用链）** —— `captureLoadContext()` 在 readStateSnapshot 入口一次性捕获 home + path + helpers，整个 load chain 共享；`saveState/persistStateAtomically` 接受 `capturedStatePath`；新增 readStateSnapshot full-chain capture 测试。`08cfab3`
- **2026-04-26 04:30 — Phase 7d-5α-A1 fix-4：async-timing capture (Q5-B + Q6-b + CLAUDE.md §6 落盘)** —— `queueAgentMarkdownPrime` + `importAgentMarkdownFiles` 改成调度/入口时一次性捕获 home-bound factory，async 体内禁止再读 env；CLAUDE.md §6 写入硬规则。`2063d9e`
- **2026-04-26 03:30 — Phase 7d-5α-A1 fix-3：cache-level cross-home isolation (Q3-B + Q4-b + 扩大 audit)** —— `checkpointCache` 改嵌套 `Map<home, Map<threadId>>`、`markdownPrimeQueued` 改 Set；4 项 module-level state 全审计无遗漏。`a104f23`
- **2026-04-26 02:30 — Phase 7d-5α-A1 commit 8+9 fix：MELO_HOME 隔离修复 (Q1a + Q2b)** —— `markdownSynced` 单 boolean → by-home Map；`createAgentMarkdownFileHelpers` 接受 lazy `() => agentsDir`；checkpointer.js 的 `THREADS_DIR` const 改 lazy。`808db9e`
- **2026-04-26 01:30 — Phase 7d-5α-A1 收尾 (Commit 8+9)：state-machine 全部搬出 desktopStore** —— 新增 `markdownSync.js` + `stateStore.js`（共 ~280 行）；desktopStore 净减 ~196 行（7304 → 7186）；`enqueueStateWrite` §5 carve-out。`856aa07`
- **2026-04-26 00:55 — Phase 7d-5α-A1 commit 7 fix：恢复 sanitizeWorkspacePath wrapper + 审计 commits 1-6** —— `stateHydration.js` 找回 1-arg local wrapper（绕 2-arg `Raw` 函数的 byte-for-byte 漏洞）；新增 10 个回归测试。`a6c1802`
- **2026-04-26 00:28 — git pp 改成 push 前先 evaluation** —— `scripts/codex-review.sh` 升级双门：pre-push evaluation 解析评级阻断 C/D，保留 post-push 兜底。（用户改，未单独 commit；后续被 `f4bc254` 替换）
- **2026-04-26 00:25 — Phase 7d-5α-A1 (Commit 7/9)：抽出 stateHydration 簇** —— 9 个 export（4 hydrate + 2 normalize + 1 helper + 4 const），`APP_ROOT` 多套一层 `dirname` 适配深 1 层目录。`7b051fa`
- **2026-04-25 23:55 — Phase 7d-5α-A1 (Commit 6/9)：抽出 mergeDiskSkillsIntoState** —— 41 行纯叶子搬到 `diskSkills.js`，desktopStore 的 `reloadDiskSkills` 从此 import。`c332b07`
- **2026-04-25 23:35 — Phase 7d-5α-A1 (Commit 5/9)：抽出 memorySnapshot 簇 (~400 行最大单 commit)** —— `syncMemoryStoreSnapshot` + `buildMemoryStoreEntries`(384 行) + `buildSpeakerMemoryNamespace`，零循环。`f0b528e`
- **2026-04-25 23:10 — Phase 7d-5α-A1 (Commit 4/9)：persistChatThreads 加入 chatPersistence.js** —— commit 3 已搬走 `ensureChatThreadContext`，所以 4 个 deps 全外部化。`8ab7817`
- **2026-04-25 22:55 — Phase 7d-5α-A1 (Commit 3/9)：抽出 chatThreadContext 簇** —— 9 个 export（cache helper + builder + checkpoint payload），后续 commit 4/7 的 prerequisite。`2cc94a8`
- **2026-04-25 22:30 — Phase 7d-5α-A1 (Commit 2/9)：抽出 serializeChatForPersistence 纯叶子** —— 17 行 pure object reshape 单独 commit；同时把原"7-commit 计划"修订为 9 commit。`4d81ef4`
- **2026-04-25 22:00 — Phase 7d-5α-A1 (Commit 1/7)：抽出 chatPruning（撤回 cec12c3 错方向，重做 path A）** —— 4 个 chat-pruning 符号搬到 `state/chatPruning.js`，byte-for-byte。`80efd7d`
- **2026-04-25 21:30 — Phase 7d-5α：暴露 state-machine helpers 为后续 elephant 移植铺路** —— 5 个函数加 `export` 关键字，纯加 export 不动逻辑。（无独立 commit hash；后续被 `856aa07` 调整覆盖）
- **2026-04-25 19:30 — Phase 7d-2：抽出 systemPrompt + CLAUDE.md §5 落盘** —— `buildReActSystemPrompt` + 5 helper 搬走（~210 行 + 25 测试）；§5 byte-for-byte 规则首次写入。`ffc477a`
- **2026-04-25 19:03 — 增加 git pp 后 D/C/B/A/S 质量评估 gate + codex.md 改本地派生** —— `EVALUATION.md` 写入五档评分；`codex.md` 加进 `.gitignore`。`1f636e2`
- **2026-04-25 00:20 — Phase 7d-1：抽出 messageBuilder (chatExecutionService 拆解 ①/N)** —— 8 函数 + 9 常量搬走（~280 行），desktopStore 净减 269 行（最大单次瘦身），首次发现"简化重写"陷阱并回退。`8c387a4`
- **2026-04-24 23:45 — Phase 7c：抽出 agentProfileService 纯逻辑核心** —— 3 块纯逻辑（normalize patch / stale-draft guard / new agent seed），18 个新单元测试。`7250cd7`
- **2026-04-24 23:00 — Phase 7b：抽出 workspaceService + 强化 review prompt** —— 3 个 workspace I/O 函数 + 测试；`codex-review.sh` 强制 4 步探索流程。`33aba21` + `0f7d2af`
- **2026-04-24 22:10 — Phase 7a：抽出 searchService (desktopStore 解耦 ①/④)** —— 2 个 search 函数搬到 `services/search/`，DI 边界 + 薄壳 re-export 范式确立。`8c03a68`
- **2026-04-24 21:47 — `npm run progress:codex` 自动生成 codex.md 快照** —— 跨会话快速接续机制。`3fcbdea`
- **2026-04-24 21:30 — 首次远程推送 + 工作协议落盘** —— 配置 `origin = github.com/MortredVigoss/Melo`，3 个积压 commit 全量推送。`5f128c6` + `8fb3cf9` + `f87c06c`
- **2026-04-24 20:00 — 修复图片生成 HTTP 400** —— `/codex/responses` 请求体加 `instructions` 字段，模型不再编造"等了 180 秒"。`8fb3cf9`
- **2026-04-24 19:00 — 修复 4 处历史测试失败** —— `audioExtractor.js` 加 codex-env-fallback；`openai.js` 去掉 `[Audio attachment: …]` 占位符。`5f128c6`
- **2026-04-24 14:00 — 初始化工作协议** —— 新建 `CLAUDE.md`（三条硬性规则）和 `PROGRESS.md`。`f87c06c`
