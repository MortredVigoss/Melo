# Melo 自修改与隔离开发能力审计

日期：2026-10-26（Australia/Melbourne）  
源码基准：`master`，`b39823f3c924c6a3148cd3e618dceb7fd2b9d005`。开始检查时工作树干净。  
授权范围：审计、临时夹具验证、报告；不实施产品修改，不合并产品分支，不推送，不安装，不改账号与数据。

## 1. 结论

**Melo 已经有修改代码的基础工具，但还没有“在隔离环境里自主开发，通过测试与独立审查后才合并、再安全更新自己”的完整工程系统。**

现在可以在用户授权下读源码、搜索、改文件、调用 shell；通过 shell 可以运行 Git、测试和构建。多 Agent、预算、取消、操作记录和文件备份也有实现。缺口集中在：受管理的代码副本、进程与数据隔离、长期作业恢复、可信测试回执、针对固定代码版本的审查、受控合并，以及独立的升级回滚流程。

不能用“给 Agent 打开运行命令”来代替这些机制。当前运行命令是信任该进程以用户身份执行，工作目录和工具开关并不限制脚本内部的文件、网络、Git 操作。

本轮的关键实证：在一个完全临时的示例 Git 仓库，通过 Melo 的真实 `executeTool` 和内置工具，完成了读取、搜索、worktree、修改、测试、提交、合并；随后让测试故意失败，批准合并命令后，**合并仍然成功**。这证明 Git 能力存在，但“测试通过才合并”的规则没有产品执行层保证。

## 2. 审计范围与证据等级

- 机械检索覆盖当前 Git 跟踪的 796 个运行时 JS/MJS/Swift/Kotlin 文件，范围为 `src/`、`shared/`、`desktop-ui/`、`desktop-app/`、`ios/Melo/`、`android/app/src/main/`；排除 `.test.js`、`dist`、iOS 生成场景和 Android assets。该数字是检索清单，不代表逐行证明 796 个文件无逻辑错误。
- 顺着实际注册、执行、权限、工作区、协作、任务、测试与安装调用路径阅读关键模块，清单见第 9 节。补查开发脚本、GitHub Actions、默认本机状态中的能力配置、已安装 App 的源码定位字段。
- 15 个现有相关测试文件：**273 通过，0 失败，0 跳过**。这是选定能力的回归，不是整个产品或发布验收。
- 临时仓库真实工具探针：20 条操作/检查记录，16 次夹具权限响应。权限由测试夹具模拟“允许”，并未让模型自动批准真实用户操作；没有真实模型调用，没有远端写操作。
- GitHub 只读 API：检查主线保护、rulesets 和适用规则；没有改变任何 GitHub 设置。
- 没有启动或操作用户的真实 Melo 窗口，没有新做手机真机验收。检查时 `43127` 没有监听者，不能据此断言其他端口或其他安装不存在。

证据目录：`.tmp/self-development-audit-20261026/`。包含可重跑探针、工具回执、测试日志、检索清单和 GitHub 规则快照。临时示例库本身保留在回执的 `fixture` 路径中；不属于 Melo 的真实仓库。

## 3. 能力对照

| 用户希望完成的步骤 | 当前状态 | 实际能力与限制 |
| --- | --- | --- |
| 读取源码、目录、搜索代码 | 已有并实测 | `file_read`、`glob`、`grep`；有真实路径、符号链接、敏感路径检查。不是仅显示文件名。 |
| 新建、修改、移动、删除文件 | 已有；编辑实测，其余读实现和回归 | `file_write/edit/move/mkdir/delete`；编辑前预览、批准、旧内容/文件身份核对、文件备份；删除走回收目录。不是多文件事务。 |
| 执行测试、编译、安装依赖 | 可通过 shell 调用 | `bash` 调主机程序；取决于工具链是否安装、Agent 能力与操作授权。没有独立的受限测试运行器。 |
| Git 状态、diff、分支、commit、merge | 可通过 shell，worktree/commit/merge 已实测 | 没有专用 Git 工具或仓库管理领域模型；Git 命令通常逐次询问。 |
| GitHub PR、推送与 CI 查询 | 能通过获准的 CLI/MCP 扩展接入，但未内建开发流程 | 当前内置工具目录没有 GitHub 发布/合并工具；不能把本次 Codex 的 GitHub 连接当成 Melo 已拥有的连接。真实推送和凭据可用性本轮未试。 |
| 自动创建隔离分支与工作树 | 缺少产品管理层 | Agent 可以拼 `git worktree`，但没有任务归属、生命周期、清理、基线和变更收集的统一入口。 |
| 保护主机文件、账号、密钥与网络 | 不满足隔离开发要求 | 内置文件工具有审批与路径防护；批准的 shell/MCP 子进程仍是用户权限，没有 OS 文件/网络隔离。 |
| 测试数据隔离 | 部分已有 | 日常测试脚本创建独立 `MELO_HOME`；普通 Agent 命令没有自动分配专用数据、HOME、端口或凭据。 |
| 长时间测试、日志、停止 | 部分已有 | shell 能返回退出码/输出并取消进程组；后台命令 API 有运行状态。但后台作业未作为模型工具注册，也不是持久开发作业。 |
| 多步执行、目标保持、失败纠偏 | 已有通用能力 | 共享目标、工具续跑、证据检查、重复失败/停滞/预算保护；没有代码开发阶段的持久状态机。 |
| 实施 Agent + 审查 Agent | 已有通用团队 | 顺序、并行、实施/复核循环、结构化交接；不是固定 commit 的只读审查门禁。 |
| 多任务不互相覆盖 | 部分已有 | 同聊天串行，成员写工作区锁；没有覆盖所有根聊天/外部编辑者/独立进程的仓库事务锁。 |
| 全绿才能合并 | 缺失 | 没有将测试结果、源码树哈希、目标分支基线与合并操作绑定。 |
| 变更预览与最终批准 | 部分已有 | 文件级 diff、工具批准、执行面板、任务验收清单；没有开发作业级变更包、测试矩阵与合并入口。 |
| 更新自身、失败回滚 | 部分脚本已有，产品闭环缺失 | 有构建、安装暂存/替换及文件恢复；没有稳定控制端主持的版本切换、数据迁移回滚和健康验收。 |
| 从 iPhone 发起同一流程 | 尚未接通 | 手机有自己的工具与文件授权，当前不是桌面 Git/构建作业的远程控制客户端。 |

当前默认本机存档只读抽取显示：6 个 Agent 都开启了读文件、改文件、运行命令；`main` 开启委派并列出另外 5 个目标。`reviewer` 也有写文件和运行命令权限。现有 1 个项目指向一个基准仓库，并非 Melo 产品源码。上述是存档快照，未修改设置，也不等于已核实每个项目覆盖后的运行时权限。

## 4. 阻碍完整流程的问题

### P0-1：工作目录不是安全沙箱，shell 与 MCP 可触及宿主机

证据：[`bashTool.js`](../src/tools/builtins/bashTool.js) 第 219、277、291–296 行复制进程环境、设置 cwd 后直接 `spawn('bash', ['-c', command])`；[`MCP client`](../src/mcp/client.js) 第 35–47、73–84 行明确说明 cwd 不是沙箱，同样继承环境并创建本机进程。

临时探针只给执行 Agent `runCommands=true`，`readFiles/writeFiles/network=false`。批准 `node probe.js` 后，脚本成功读取临时工作区外的普通夹具文件、写入同一临时区域的标记文件、连接本机夹具 HTTP 服务，并看到继承的 `MELO_HOME` 和合成环境标记。没有读取真实秘密，也没有对外发送信息。

这不是“审批被绕过”：命令得到了夹具批准。它证明能力开关限制工具入口，不约束已获准进程的行为。内置文件工具的备份和敏感目录保护也不会自动拦截脚本里的文件调用。不能把这个执行模式标成隔离开发。

建议：开发作业使用独立执行器，最小环境、专用 home/cache/temp/端口、明确可写目录、外网策略；高风险测试放进可丢弃虚拟机。工作树只解决源码副本，数据目录只解决应用数据，两者都不能替代 OS 隔离。macOS/iOS 构建需要单独考虑 macOS 执行器及签名授权，不以 Linux 容器冒充完整平台验收。

### P0-2：当前安装依赖源码目录，改主目录会影响正在使用的 Melo

证据：[`main.swift`](../desktop-app/main.swift) 第 23–32 行从环境或 App 的 `MeloProjectDirectory` 选择源码；第 414–450 行从该目录运行 `src/server.js`。[`build-desktop-app.sh`](../scripts/build-desktop-app.sh) 第 87–89 行把构建时源码位置写入 App。当前 `~/Applications/Melo.app` 的该字段正是本产品仓库。

后果：直接在主仓库修改服务/前端，可能让已有进程、后续动态加载、页面刷新与下一次启动使用不一致版本；若从临时工作树打包并安装，之后清理工作树还可能破坏运行路径。不能等到安装时才认为“新代码生效”。

建议：稳定运行版本与开发源码分离。控制端不在作业中改写自己正在执行的代码；新版本生成完整、固定源码版本的发布物，验证后由独立更新器切换。

### P0-3：测试失败、审查缺失或代码已变化，都没有强制阻止合并

实测：临时分支测试从绿改为红，`npm test` 确实返回失败；随后获准执行 `git add`、`git commit`、`git merge --ff-only`，仍然合并成功。

现有 [`taskAcceptance.js`](../src/services/task/taskAcceptance.js) 会根据工具失败和人工勾选限制“任务验收”，是有效的通用保护；但它没有连接到 Git merge。目标完成检查 [`goal.js`](../shared/agent/goal.js) 校验任务证据，也不是 commit 级测试证明。开发者用的 [`codex-review.sh`](../scripts/codex-review.sh) 是外部 CLI 脚本，需要明确调用，本轮没有运行，不能视为 Melo 自动拥有的内部能力。

远端 2026-10-26 只读核对：`master.protected=false`，传统分支保护返回 `Branch not protected`，仓库 rulesets 和 master 适用规则均为空。已有 [GitHub Actions](../.github/workflows/verification.yml) 会执行验证，但目前没有配置“必需检查通过才能合并”的远端门禁。本轮没有修改它们。

建议：新增合并服务，只有它可以写主线；记录并核对 `baseSha/headSha/treeSha`、测试计划/实际退出码/报告哈希、审查版本与批准状态。测试后再改文件、主线前进、证据缺失或测试脚本被改，都必须使旧验收失效。合并在最新主线形成的候选树上验证；最终更新引用时再次核对基线。测试与门禁自身的变更须特别复核，不能让待测改动自己删检查再报告全绿。远端同时启用必需 CI/审查及适合该流程的主线保护。

### P0-4：`test:full` 包含安装，不是无副作用的纯测试

证据：[`verify-red-green.js`](../scripts/verify-red-green.js) 第 650–700 行在回归、构建后执行 `install:desktop`，再启动桌面/Launchpad 应用；[`desktop-install-paths.js`](../scripts/desktop-install-paths.js) 默认安装到用户 `Applications`。`MELO_SKIP_NATIVE_LAUNCH=1` 跳过窗口验收，但**没有跳过安装阶段**。

它作为现有发布流程有合理用途；风险是自修改 Agent 为“跑全套测试”直接调用它，提前替换使用中的应用。独立 `MELO_HOME` 不能阻止安装目标被覆盖。

建议：明确拆成纯验证、预览启动、正式发布三个入口。开发作业只能调用不安装的受控验证命令；预览使用独立 App 标识、端口和数据；安装是独立状态转换。本次没有运行完整发布 gate 或安装脚本。

### P1-1：复杂开发任务的运行时长和恢复机制不足

- [`bashTool`](../src/tools/builtins/bashTool.js) 自身默认 30 秒、参数最大 120 秒；[`executor.js`](../src/tools/executor.js) 第 223 行另有默认 60 秒外层上限，`bashTool` 没有更长的 `tool.timeout`。因此正常入口的单条命令不能靠把参数设成 120 秒就完整跑完数分钟的组合构建。
- shell 标准输入为 `ignore`，不能当作可持续交互的终端；每次新进程，`cd` 等状态不跨调用保留。
- [`BackgroundRunner`](../src/tasks/backgroundRunner.js) 支持长命令和停止；HTTP 入口在 [`server.js`](../src/server.js) 第 815–909 行。它没有注册成 Agent 的 start/status/wait/cancel 工具，运行记录放内存 Map；HTTP 入口没有提供完整开发作业持久化，默认保留完成任务 30 分钟、最多 20 个。
- [`taskRunLifecycle.js`](../src/services/task/taskRunLifecycle.js) 第 30 行起对重启中的任务标为中断/受阻并要求检查，不会自动重放副作用。这是正确的谨慎恢复，但还不是可从测试/审查阶段继续的持久作业。
- 当前普通回合默认 10 个循环、20 分钟/400000 输入 token/120 工具调用；成员默认 8 个循环、3 分钟。预算上限保护已有，但不能把一次普通聊天当成持续数小时的开发调度器。

建议：持久化开发作业与阶段检查点；将长命令注册成受控工具，返回 job ID、增量日志、退出码，支持等待、停止和重启后状态核对。模型在作业执行期间可以暂停；耗时测试不应一直占着一次模型调用的超时计时。

### P1-2：多 Agent 复核有实现，但审查权限和证据没有独立

[`team.js`](../src/agents/team.js) 的复核循环会检查实施结果和审查成员的 `handoff.review === 'approve'`，有轮数与预算；[`handoff.js`](../src/agents/handoff.js) 保留观察与成员自述。问题是批准仍是模型交接结论，没有绑定固定 Git 树，也没有强制要求测试报告。当前存档的 reviewer 还拥有写入和命令能力。

[`delegate.js`](../src/agents/delegate.js) 会用 [`workspaceScheduling.js`](../src/agents/workspaceScheduling.js) 串行化写成员；但运行时中 `withWorkspaceWriter` 的生产调用只有成员入口。根聊天使用 [`turnScheduler.js`](../src/services/chat/turnScheduler.js) 按聊天 ID 排队，不是按仓库排队。两个根聊天对同一项目以及仓库外部编辑者，不受这个成员锁统一保护。这里是调用路径审计，未以真实用户仓库制造并发冲突。

建议：审查者只读固定候选树与测试证据，不能在审查过程中修改候选代码；修复返回实施阶段。作业/仓库级租约覆盖所有开发入口，合并使用跨进程互斥和基线检查。Git worktree 共享 Git 元数据，本身也不是防止任意命令修改主线引用的安全边界。

### P1-3：工作协议与开发 UI 尚未产品化

源码检索与 prompt 拼装路径没有发现会自动读取目标仓库 `AGENTS.md` / `CLAUDE.md` 的加载器；现有相关命中主要是源码注释。项目指令、技能指令已经注入，Agent 也能手动用 `file_read` 读取协议，但目前不能保证每次开工、进入子目录、委派成员时都加载并展示适用规则。

UI 有文件预览、单操作审批、团队执行记录、任务验收，但没有“开发作业”页面展示基线、隔离目录、全部 diff、测试矩阵、审查意见、主线变更与待合并状态。

建议：仓库准入时明确记录目标和规则来源；规则加载应处理根目录与子目录作用域，并作为项目指导，不能用仓库文件扩大工具权限。桌面先接完整作业 UI；手机接同一后台作业的查看、补充要求和授权入口，不在手机上模拟桌面编译能力。

## 5. 已有机制应当保留

不是从零重做：保留 executor 的能力检查和显式旧版兼容、委派时收紧权限、操作确认、文件身份/陈旧内容检查、备份与回收、进程取消、重复失败保护、目标完成检查、任务副作用账本、分阶段检测和现有跨端协议。

[`operationLedger.js`](../src/services/task/operationLedger.js) 已有任务级副作用回执，能区分重复请求和结果未知的中断；不能说“完全没有恢复保护”。但它只覆盖有 task ID 的操作，不等于跨 Git、测试和版本更新的事务。

需要补的是把这些能力编成可验证的开发流程，以及把信任边界移到可强制执行的地方。文件级恢复不等于 Git 历史、数据库迁移、依赖安装与应用替换的整体回滚。

## 6. 建议目标流程（仅方案，未执行）

```text
稳定 Melo / 开发任务 UI
  → 确认目标仓库、基线、规则和授权范围
  → 创建作业副本 + 受限运行环境 + 独立测试数据
  → 实施 Agent 修改、补回归
  → 受控测试运行器输出带版本标识的证据
  → 只读审查 Agent 检查固定 diff 与测试结果
  → 在最新主线上形成候选合并树并跑组合验证
  → 显示变更包与验收结果，进入待合并状态
  → 合并服务核对精确版本和授权，写入主线
  → 单独构建发布物、备份与数据兼容检查
  → 独立更新器切换版本、健康验收、必要时回滚
```

实现边界应分为五个职责：

1. **开发作业管理**：持久化目标、仓库、基线、分支、工作目录、阶段、日志、预算、测试/审查证据；中断后核对再恢复。
2. **执行环境管理**：源码隔离、数据隔离、进程权限、外网策略、工具链与资源清理。无 OS 隔离的模式必须明确标为“受信任本机执行”。
3. **测试与审查**：复用现有测试选组，不删测试降成本；测试计划来自可核验的规则，审查与测试都绑定版本。
4. **合并与发布控制**：只有独立服务能更新主线或正式安装目录；开发 worker 不持有主线写权限、推送凭据或签名私钥。正式安装与普通合并分开。
5. **跨端 UI**：桌面与手机读取同一开发作业状态，显示真实等待/失败/部分验证，不能只显示模型说“已完成”。

### 建议分批顺序

| 阶段 | 交付 | 到这一阶段能做什么 |
| --- | --- | --- |
| A：保护当前使用环境 | 拆纯验证/发布命令；稳定运行版本脱离开发目录；明确隔离级别；保护主线与正式数据 | 可以安全开始做开发模式，不会误把测试当安装。 |
| B：受管理的开发作业 | 独立源码副本、规则加载、专用数据/端口、受控长命令、日志与恢复、必要的 OS 隔离 | Melo 能自主修改并验证候选代码，先停在待审查/待合并。 |
| C：可信验收与合并 | 固定版本测试回执、只读审查、最新主线组合测试、合并服务与远端保护 | 在明确授权策略下，只合并已验收的精确版本。 |
| D：更新与手机控制 | 独立发布物/更新器、备份与数据兼容、健康检查和回滚；手机控制同一作业 | 完成“自己改自己”的产品闭环，而不仅是改出一份源码。 |

第一版建议以 B/C 的“做好候选改动、出完整证据、等待最终合并”为可交付目标；完全自动合并、推送和覆盖安装是否启用，是后续独立产品决定，本次不据审计请求开通。

## 7. 实施时必须通过的验收

1. 两个开发任务同时修改同一文件，各自在独立副本执行，原主线和彼此文件不变。
2. worker 不能读真实账号目录或写主线、正式 App、测试范围外文件；不允许的网络请求实际被拒绝。验证子进程和 MCP，不只验证工具入口。
3. 普通纯验证命令不启动/替换真实 App，不改真实数据；退出后无遗留子进程和端口。
4. 十分钟以上的测试能完成，日志可增量查看；取消终止进程组；重启后明确恢复或判定未知，不重放已发生的 merge/push。
5. 任意必需测试失败、跳过未被接受、报告缺失或被篡改，合并请求均拒绝。
6. 测试后改一行、审查后改一行、主线推进，都使旧批准失效；必须验证新的候选合并树。
7. 改测试脚本/CI/权限/更新器本身需要额外审查；不能把检测程序改成永远成功获得合并。
8. 审查 Agent 修改文件的尝试实际失败；交接里一句 approve 不足以放行。
9. 合并失败或冲突时保留候选改动，主线不被 reset/覆盖；用户其他 WIP 保留。
10. 新版本健康检查失败可以回到可运行版本；旧账号、聊天、原图和数据库兼容性分别验收。
11. 手机展示与桌面同一个作业/版本/测试状态；手机点停止、批准不会越过后台合并门禁。

## 8. 本次验证记录

### 临时真实工具探针

脚本 `capability-probe.mjs` 使用本次源码导出的真实 executor、注册工具与安全门。基于新建的最小仓库，执行：读取 → glob/grep → 红测试 → 创建 worktree → 改文件 → 绿测试 → diff 检查 → commit → merge；随后再次修改造成红测试，确认仍能经批准 merge；另验证缺少能力与身份会拒绝、已批准脚本不受文件/网络开关的进程级限制。

结果：20 条记录成功满足审计断言；其中故意的失败测试、能力拒绝是预期观测，不能把它们说成产品缺陷已修复。16 次权限由临时测试夹具处理。首次探针受 Codex 的外层执行沙箱限制，启动本机服务报 `listen EPERM`；在获准的本机执行环境重跑后完成。该失败属于审计环境，不能算 Melo 自身提供了沙箱。

### 现有专项回归

运行 `node --test --test-concurrency=2`，显式设置临时 `MELO_HOME` 和 `MELO_TEST_MODE=1`，选中：

```text
src/tools/executor.capabilityScope.test.js
src/tools/executor.capabilityElevation.test.js
src/tools/executor.cancellation.test.js
src/tools/builtins/phase2a.fileTools.test.js
src/tools/builtins/phase2d.bashTool.test.js
src/services/workspace/projectR1.test.js
src/agents/workspaceScheduling.test.js
src/agents/collaboration.test.js
src/agents/team.test.js
src/tasks/backgroundRunner.test.js
src/tasks/approvedBackgroundTask.test.js
src/services/task/taskAcceptance.test.js
src/services/task/operationLedger.regression.test.js
shared/agent/goal.test.js
shared/agent/completion.test.js
```

273/273 通过，约 2.65 秒，无跳过、无超时复测。没有改产品或测试代码，因此不重复完整产品 gate；报告与交接文档另走文档计划和链接检查，`run-a30ZUI` 通过。

### GitHub 只读核对

```text
GET repos/MortredVigoss/Melo/branches/master
  protected: false; required_status_checks.enforcement_level: off
GET repos/MortredVigoss/Melo/branches/master/protection
  404 Branch not protected
GET repos/MortredVigoss/Melo/rulesets
  []
GET repos/MortredVigoss/Melo/rules/branches/master
  []
```

这只说明当前规则状态；不推断未来配置，也不证明某个账号当前一定能成功推送。

## 9. 关键源码核对清单

- 工具：`src/tools/{registry,executor,permissions,tool,workspace}.js`；`builtins/{bashTool,fileReadTool,fileWriteTool,fileEditTool,fileDeleteTool,globTool,grepTool}.js`。
- 权限：`src/domain/agent/{capabilities,capabilityScope}.js`；`src/services/agent/capabilityContext.js`；`src/safety/{fileSafetyGate,commandRules,permissionContext,sensitivePaths,backup,restorePreview}.js`。
- 工作区：`src/services/workspace/{toolWorkspace,workspacePolicy,workspaceSnapshot}.js`；`src/runtime/{paths,requestContext}.js`。
- 协作：`src/agents/{delegate,team,handoff,workspaceScheduling,memberBackground}.js`；共享 `shared/agent/{turn,goal}.js`、`shared/protocol/agent-loop.json`。
- 任务：`src/services/task/{prepareTaskExecution,taskAcceptance,taskRunLifecycle,operationLedger}.js`；`src/tasks/{backgroundRunner,approvedBackgroundTask}.js`；后台任务 HTTP 路由；`src/services/chat/turnScheduler.js`。
- 上下文：`src/services/chat/systemPrompt.js`、项目上下文拼装；目标源码中仓库规则文件的引用检索。
- 构建/发布：`scripts/{verify-daily,verify-red-green,desktop-install-paths}.js`、`build-desktop-app.sh`、`install-desktop-app.sh`、`codex-review.sh`、`package.json`、`.github/workflows/verification.yml`、`desktop-app/main.swift`。
- 扩展/手机：`src/mcp/{client,manager}.js`；`ios/Melo/{DeviceTools,LocalFileAccess}.swift`；Android `device/DeviceTools.kt`、`chat/SharedChatAgent.kt` 的工具入口。

本报告是上述基准的“自修改工程能力”专项审计；没有宣称已审完所有产品业务逻辑，也没有把已有绿测试当成自主开发流程已经完备。
