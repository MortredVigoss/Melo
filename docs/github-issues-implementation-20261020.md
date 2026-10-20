# GitHub Issues 实施与验收（2026-10-20）

用户已授权按[独立核对](github-issues-review-20261020.md)的优先顺序实施；每项验证、提交、推送后在 GitHub 留简短结果并关闭。未达验收项保持打开。此授权不包含自动运行 `git pp`、替换用户数据或重装应用。

## 顺序与完成条件

| 顺序 | Issue | 状态 / 完成条件 |
| --- | --- | --- |
| 1 | [#1 文件身份](https://github.com/MortredVigoss/Melo/issues/1) | 已完成：`47da231` 已推送，issue 已关闭；[双平台 CI](https://github.com/MortredVigoss/Melo/actions/runs/39260200905)通过 |
| 2 | [#4 历史图片](https://github.com/MortredVigoss/Melo/issues/4) | 已完成：`94e76cb` 已推送，issue 已关闭；稳定图片身份、旧记录恢复与原图回归 |
| 3 | [#3 自然搜索](https://github.com/MortredVigoss/Melo/issues/3) | 已完成：`1c48b6a` 已推送，issue 已关闭；专项 95/95、JS 4098/4098 与 Swift 通过 |
| 4 | [#9 跨平台 CI](https://github.com/MortredVigoss/Melo/issues/9)、[#2 记忆库并发](https://github.com/MortredVigoss/Melo/issues/2) | #1 同步加入最小双平台文件安全工作流；完整平台矩阵与并发复现仍待完成 |
| 5 | [#5 通用循环](https://github.com/MortredVigoss/Melo/issues/5)、[#6 完成条件](https://github.com/MortredVigoss/Melo/issues/6)、[#8 事件](https://github.com/MortredVigoss/Melo/issues/8)、[#7 Android 上下文](https://github.com/MortredVigoss/Melo/issues/7) | 待执行；按 Host 适配与对照验收，不删现有行为 |
| 6 | [#11 项目生命周期](https://github.com/MortredVigoss/Melo/issues/11)、[#12 后端拆分](https://github.com/MortredVigoss/Melo/issues/12)、[#10 Fold 缓存](https://github.com/MortredVigoss/Melo/issues/10)、[#13 容量基线](https://github.com/MortredVigoss/Melo/issues/13)、[#14 Task Eval](https://github.com/MortredVigoss/Melo/issues/14) | 待执行；小型确定性回放伴随改动，真机/真实模型证据单列 |

## #1 实施约定与证据

方案：沿用 dirfd 原子操作，审批前持有父目录与已有叶子对象的内核句柄，阻止释放后 inode 复用；不存在的叶子记录“必须仍不存在”。不能用时间戳或更宽权限代替对象身份。

- `native/dirfd_ops.cc`：Linux `O_PATH | O_NOFOLLOW`、macOS `O_EVTONLY | O_SYMLINK`，只取身份，不读内容；close-on-exec。`dirfdOps.js` 内的身份 lease 用 bigint 比较存活对象；checked 删除/建链接不再接受裸 dev/ino。
- `fileSafetyGate.js`：令牌持有审批句柄，消费前同步取走令牌，成功后转交操作所有者；拒绝、取消、超时、到期、错误和批处理失败均清理。既有敏感路径与授权策略保留。
- 写入、编辑、mkdir、移动、回收、备份恢复和回收站恢复：持有身份跨过所有异步步骤；副作用前复查同一个父 dirfd；有身份约束的 open 先验证再 truncate，缺失文件以 O_EXCL 创建；创建失败清理仍持有原 FD，只删除本次的占位文件。
- 测试保留原安全断言；旧授权单元测试的虚构 `/tmp/elsewhere` 改为测试专属真实目录。新增回归实际注入父目录和同内容文件替换，并通过真实 FD 的 EBADF 验证清理；另覆盖过期和并发单次消费。
- 最小 `.github/workflows/file-safety.yml`：Linux/macOS 各自构建原生模块并运行相同安全测试。不能把该工作流写入等同远端 CI 已绿，也不据此关闭完整 #9。

最终本机证据（隔离数据，未使用真实账号）：`.tmp/github-issues-fix-20261020/`。

- `linux-baseline.log`：原主线 `b64fe54` 的 6 项 checked 回归独立复现 2 项失败（父目录重建后的删除/建链接）。
- `mac-safety-final.log`：最终文件安全组 376/376；`linux-safety.log`：Debian Node 22 容器最终同组 375/375。包含 21 条新增身份/生命周期回归，原生 addon 分平台构建。
- `daily.log`：日常全量 JS 4070/4070、语法、文档链接、两项设置浏览器、共享渲染 4/4、32 组 Swift 通过；之后的令牌/清理补强由上述最终专项复测，最终语法再次通过。
- 没有运行会打包安装的 `test:full`，没有运行 `git pp`；GitHub Actions run `39260200905` 两个平台均通过；issue #1 已评论并关闭。

边界：此项解决审批窗口与异步备份/恢复之间的身份复用，不声称 POSIX `statat` 与 `unlinkat/renameat` 具有按叶子 inode 条件执行的通用原子语义。真实目录不搬迁，备份/回收格式不变；iOS 沙盒文件实现不使用这个原生 addon。


## #4 实施与验收

由服务器依据已持久化的执行成果或附件登记解析图片身份，生成当前端口下可用的访问入口；聊天卡片、预览和保存使用同一身份。图片登记独立于短期执行场景清理，避免旧成果只剩失效 URL。只从当前 home 的受信记录取路径，拒绝跨 home、越界和软链接，不接受客户端解码 p 后重签。

验证覆盖 TTL、服务重启/端口变更、旧历史读取与原图 SHA；网络/文件缺失/图片损坏要有明确状态，自动恢复次数有界。保留已有缩放、下载及原生保存行为。

- `src/media/imageRecords.js` 将工具登记的图片身份独立持久化，清理执行场景前先保留登记；串行合并同一 run 的并发回填。`sendChatMessage` 捕获本轮工作目录。
- `src/services/media/savedImages.js` / `GET /api/media/images/resolve` 根据已保存的助手消息与附件解析；`GET /api/media/images/:scope/:run/:image` 读取原始字节。路径限制到登记根目录，逐级拒绝软链接，检查文件类型/大小；home 隔离。旧消息和原图不改写。
- 旧场景已清理时，仅可恢复所属工作区 `generated/` 内、文件名和服务端计算编码都与已保存附件一致的图片；不解码客户端 p 来授权任意文件。缺少可信记录的其他路径明确报不可用。
- 聊天卡片、预览、保存共享 `desktop-ui/imageResource.js`；自动恢复每个图片节点一次，缓存成功解析，下载保留原始字节。错误区分记录缺失、原图丢失、损坏、越界；五语与 iPhone 共用翻译资源同步。
- 7 项 HTTP 回归覆盖真正 TTL 过期、场景清理、两个真实服务进程重启和换端口、并发回填、越界/跨 home/叶子及祖先软链接；浏览器覆盖历史卡片/弹窗/原生保存桥、原图 SHA/字节一致及失败无重试循环。全部包含在 `image-daily.log` 的 JS 4079/4079 中。
- 边界：测试使用隔离 home 和临时图片；没有重装应用，没有操作用户历史图片。执行面板仍按既有逻辑在读取场景时更新签名；手机本机图片存储流程不改写。

## #3 实施计划

当前主线已经采用稳定核心工具列表，因此“自然问法完全看不到搜索工具”不能作为当前主聊天结论；缺口是自然推荐/追问没有搜索引导，能力禁止时仍可能提示使用不存在的搜索。对照 Mobile `shared/agent/search.js` 的任务/解释/App 分流思路，补充独立意图分类与当前工具可用性收敛；保持既有核心工具缓存策略。覆盖自然推荐、否定/引用/本地/App 边界、取消/换题与追问，以及真实 HTTP 模型协议夹具中的定义、执行、来源和失败说明。手机分支已有自然推荐路由，本项不合并整条移动分支；通用循环/跨 Host 收敛在 #5 继续。


#3 结果：`publicLookupIntent.js` 给公开、时效性的自然推荐提供搜索意图；短追问只继承最近的相关任务，跨否定/取消/换题停止。App 内搜索与纯文本任务独立处理；显式读链接仍优先于翻译/改写。`constrainSearchPlan` 依据本轮真正可用工具/原生搜索修正路由；不可用时明确说明而不接管手机。已有工具列表缓存、能力检查和搜索后端保持。

- 基线 `94e76cb` 的三个原始推荐问法均返回 none/no-web-intent；修复后 API Key→Melo Search、Codex→原生搜索。
- `search-targeted.log`：95/95，包括否定、引用、本地/App、闲聊、追问边界、链接翻译、真实 localhost Responses 请求中的工具定义→执行一次→来源继续传递、Agent 禁止联网。
- `search-daily.log`：JS 4098/4098；日常语法/文档/两项设置浏览器通过；共用渲染 4/4 与 32 组 Swift 最终复测通过。搜索结果为受控 HTTP/工具夹具，没有调用付费模型或真实外网搜索；不将夹具当成真实 provider 验收。

完整日常首次暴露 Swift `AgentTeamTests` 的异步取消回执竞态：生产已经发出取消，测试立即读取另一任务的 catch 副作用。改为最多 2 秒等待明确取消事件、计数器读写均加锁；保留取消/超时/无后续请求断言。`search-swift-final.log` 最终共用渲染 4/4 与全部 32 组 Swift 通过。没有改变生产取消语义。

## #9 实施计划

主线增加 Linux 全部 Node/HTTP/浏览器回归与 macOS Swift 独立工作流；沿用 #1 的双平台原生安全门禁。新 checkout 显式准备 Node、Python、Ruby、原生 addon 和 Chrome，不使用本机安装路径。环境准备单列步骤，测试失败保持红色，不用 skip/重试伪装通过；不运行安装用户应用的发布 gate。
Android 源码仅在 `codex/mobile-use-features`，在隔离 `.tmp/github-issues-mobile` 工作树修正该分支工作流并回推同一远端分支；不捆绑合并所有 Android 产品代码。旧 run 39253909144 在 setup-android v3 默认安装失效的 tools 包时失败；升级 action 并显式列依赖，随后执行 JVM/Lint/Debug/R8 与隔离 Emulator。远端各 gate 真正完成后才关闭 #9。


#9 进展：Android `6c4ab6b` 已推送到原手机分支，run `39344901902` 已越过环境准备并进入 JVM/Lint/APK 构建；待实际 Emulator 结果。主线验证使用独立 `.tmp/github-issues-main`（基于 `1c48b6a`），避免把共享 master 的另一个权限线程提交带入本项。

Linux 首次完整回归（临时 Debian 容器）4072 pass / 3 fail / 22 skip；缺环境的 skip 不作为完成依据。三个浏览器失败分别为 CJK 字体缺失、C locale 下 Chromium 把中文下载名降成 download，以及固定 4 秒回复窗口下的补充动作竞态。安装字体、UTF-8 locale 后前两项原断言通过；流式夹具改为等待补充提交事件，Mac/Linux 都通过。补齐 FFmpeg、ripgrep、内置模型与完整源码后重新跑全量；日志 `linux-full-final.log`。没有改产品的下载命名或布局，也未降低断言。

#9 本机最终：Debian Node 22.23.3 完整 JS 4095 pass / 0 fail / 2 平台或 root skip；其中附件写权限回归改以普通 node 用户单独通过，macOS 原生退出在 Mac 单独通过。未豁免任何失败。Linux 三个浏览器问题的原断言全过，Mac 流式专项通过。远端固定 Node 22.22.2，最终结论仍以远端 run 为准。
