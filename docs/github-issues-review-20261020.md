# GitHub Issues 独立核对（2026-10-20）

用户要求查看朋友发布的 issues 并给出判断。本轮读取 GitHub 原文、作者与状态，对照当前主线和 mobile 固定源码，并运行隔离诊断；没有修改产品、用户数据、远端 issue 或分支。

## 范围与结论

- GitHub：`MortredVigoss/Melo` 的 #1–#14，作者均为 `yrlf`，读取时全部 open、无评论。
- 当前本地与远端 master：`b64fe5450478995d82ae2f6c11f5e3f27fc05ccb`。
- issues 引用 mobile：`3614fbd740fc5523afd85f61c26468f588f2a6b1`；本次读取到的远端 mobile 为 `22db576640206c0320c62738649ded8aa6fc6794`，与该固定提交的差异只有 5 个文档/发布记录文件，相关产品源码一致。没有切换或合并分支。
- 总体：3 项优先缺陷（#1/#3/#4），1 项待调查（#2），其余 10 项为能力、架构、验证或测量工作。认可这些工作项的方向；不把它们合并表述为 14 个已复现产品 Bug。
- 原 Backlog A05 已在 mobile 修复，未另建未解决 issue：当前 Node 调用 `createCoreTurn` 已传 `MAX_FUNCTION_CALLS_PER_RESPONSE`，没有把旧的 8/32 上限冲突重新算成待修问题。

## 逐项判断

| Issue | 判断 | 核对依据与建议 |
| --- | --- | --- |
| [#1 / A01 文件身份](https://github.com/MortredVigoss/Melo/issues/1) | 有效的高优先级安全问题；Linux 复现来自提交者 | `dirfdOps.js` 的 checked 操作仍只比较旧 dev/ino，操作时才重新打开目录。相同编号被复用时无法区分替换对象。提交者的 Linux/WSL 8 次探针与结构一致；本机 macOS 的 6 项相关测试通过，没有复跑 WSL。需处理审批到执行的对象持有/复查生命周期，不能只加毫秒 birthtime。 |
| [#2 / A02 记忆库锁](https://github.com/MortredVigoss/Melo/issues/2) | 保留调查，不能按当前稳定复现的 P1 修 | 本轮真实 HTTP 编辑、同步、冷重启测试通过。此前表单重绘清空与 SQLite 锁是不同问题。下一步应制造保存、后台索引与同步并发，记录事务/连接所有权；不因旧日志盲目加重试。 |
| [#3 / A03 自然搜索](https://github.com/MortredVigoss/Melo/issues/3) | 当前主线探针确认，优先修 | 三种中英文自然餐厅推荐问法均为 `none/no-web-intent`，API Key 的 web_search/fetch_url 被过滤；显式“帮我搜索”则开放。Codex 原生搜索另有入口，不能概括成所有模型都无法搜索。mobile 的共享 router 已扩展餐厅等意图，可作为收敛输入，但仍需保留否定、引用、后续追问与工具能力边界。 |
| [#4 / A04 历史图片](https://github.com/MortredVigoss/Melo/issues/4) | 当前主线生命周期与源码确认，优先修 | 默认签名 600 秒，过期或新签名实例都拒绝旧 URL；`imagePreview.js` 预览和下载仍直接复用原 src，失败只提示。应从登记的附件/成果身份解析有效资源并有限刷新，保留签名、安全范围和原件。本轮未实点用户历史图片。 |
| [#5 / A06 通用循环](https://github.com/MortredVigoss/Melo/issues/5) | 架构缺口成立，接现有 P3 | 主 Chat、subAgent、skillExecutor、Swift 仍分别实现循环；已有预算/权限 helper 与 JSON 契约，不能称完全无共享。mobile 的 reducer 也尚未覆盖主线所有规则。先统一状态/效果/终态接口和对照测试，再逐入口迁移；合并文件不等于多端逻辑同源。 |
| [#6 / A07 完成条件](https://github.com/MortredVigoss/Melo/issues/6) | 方向正确，需要按任务定义 | 当前主线无工具调用时结束，事实核实由 uncertainty marker 触发；mobile requiredTools 只确认工具名称成功。应补任务目标与证据状态。但普通问答/创作可以无工具结束，不能一律强制工具或额外 Judge。Android 已有屏幕终态核验，应复用。 |
| [#7 / A08 Android 上下文](https://github.com/MortredVigoss/Melo/issues/7) | mobile 分支能力差距确认 | Kotlin `ChatPhoneUse.history` 仍取近 60 条、160000 字符；共享聊天主要注册 web_search/fetch_url/phone_use，未提供同等原文回读工具。主线 Node/iOS 的预算和原文回读不能算作仍未修；Android 应接同一策略，并保留平台存储。 |
| [#8 / A09 事件记录](https://github.com/MortredVigoss/Melo/issues/8) | 合理，收口现有记录来源 | 当前循环历史、ToolInvocationRecord、Scene 和可选 Tool Chain 是多条组织路径；历史工具链默认关闭。先定义事件身份与模型/UI 投影，不以此为由重做全部存储；回看事件不得重放外部动作。 |
| [#9 / A10 跨平台 CI](https://github.com/MortredVigoss/Melo/issues/9) | 应提前，至少 Linux 安全回归跟 #1 一起落地 | master 没有提交 `.github`/`.gitlab` 工作流，mobile 有 Android workflow；testChrome 已提供可配置路径，旧“全部硬编码”说法在 issue 中已修正。分平台报告失败与环境缺失，不能拿 Mac 通过证明 Linux 同样通过。没有核实外部 CI 服务设置。 |
| [#10 / A11 Fold 缓存](https://github.com/MortredVigoss/Melo/issues/10) | 合理优化，未证实错误点击 | cacheScope 含 Agent/项目/displayId/指令，脚本没有姿态或 App 版本；但 ScriptRunner 每步重新 observe/定位 selector、使用新 screen_id，并核对终态。增加兼容性/失效策略有价值，不能写成已证实跨姿态盲点旧坐标。需 Fold 真机验收。 |
| [#11 / A12 项目生命周期](https://github.com/MortredVigoss/Melo/issues/11) | 已登记的产品/架构工作，应落实 | 项目服务提供 create/update，归档可用，但完整删除/恢复/级联尚待定义。回执和聊天文件删除不等于项目生命周期完成。设计与保护规则可先行，不必等 #2 未复现锁问题调查完；实现时需验证并发、离线同步与资源引用。 |
| [#12 / A13 后端拆分](https://github.com/MortredVigoss/Melo/issues/12) | 接入既有架构计划，避免重复立项 | issue 已承认 UI P2 完成并更新 app.js 行数；memory/store、chatExecutionRunner、webSearchTool 的维护边界仍大。按职责逐字迁移，接口/事务/取消保持，逻辑修改另做；不要为行数搬文件。 |
| [#13 / A14 容量基线](https://github.com/MortredVigoss/Melo/issues/13) | 合理测量任务，当前慢的程度尚无结论 | bootstrap 仍 loadState、排序全部聊天并构造投影。bench:turn 已有合成历史、轮次和本地阶段计时，模型与 embedding 是 stub；可扩展已有脚本，先量冷/热、p50/p95、字节/内存再决定优化。没有执行大历史压测。 |
| [#14 / A15 Task Eval](https://github.com/MortredVigoss/Melo/issues/14) | 必要质量工作，最小用例适合伴随重构 | 仓库有记忆检索 bench、Stub 性能 bench 和回归测试，缺统一的跨 Host 任务 Dataset/Runner/Scorer。确定性的失败用例可立即作为重构对照，较大真实模型评测随后推进；不阻塞 Core，也不把绿色 fixture 当真实成功率。 |

## 本轮实测与证据边界

1. 隔离临时 MELO_HOME，运行 `node --test src/safety/dirfdOps.checked.test.js src/http/projectMemorySync.http.test.js`：7/7 通过，其中 6 项文件边界、1 项记忆本编辑/同步/冷重启。它没有覆盖保存与后台索引竞争，也没有复测 Linux inode 复用。
2. 直接调用当前生产 `buildSearchPlan` 与 `filterToolsForSearchPlan`：三种自然推荐皆无搜索工具；显式搜索得到两工具；明确禁止联网与工作区搜索仍正确拒绝公网搜索。
3. 直接调用生产 URL 签名/验证：初始 URL 有效，模拟超过 TTL 后拒绝；重新加载独立模块签名实例同样拒绝旧 URL。该测试不访问用户图片，不等同原生 UI 端到端验收。
4. 核对 mobile 固定源码中的上下文限制、缓存 scope、逐步定位/新屏幕/终态检查、通用 turn 状态机及 Node 调用参数；没有安装 Android、运行真机或真实供应商调用。
5. 本机证据：`.tmp/github-issue-review-20261019/mac-targeted.log`、`routing-and-signing.json`。提交者的 Linux 数据位于 mobile 的 `docs/evidence/melo-review-20261019-inode.json`，来源与本机实测分开。

## 建议顺序

1. #1 文件身份 + 最小 Linux/macOS 安全测试；#4 图片访问生命周期；#3 自然搜索路由。三者边界可分开交付，不需等待大重构。
2. #9 基础 CI 提前；#2 定向并发调查；#5 接架构 P3，#6/#8 随统一循环明确完成与记录语义；#7 随 Android 整合对齐。
3. #11 生命周期与 #12 后端职责按现有计划推进；#10 Fold 缓存用真机证据定方案；#13 先基准；#14 小型确定性回放贯穿上述改动，完整真实模型评测单独验收。

本轮只做判断与本地文档交接；未评论/关闭 issues，未修产品、提交、推送或安装。
