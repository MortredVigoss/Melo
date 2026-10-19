# GitHub Issues 实施与验收（2026-10-20）

用户已授权按[独立核对](github-issues-review-20261020.md)的优先顺序实施；每项验证、提交、推送后在 GitHub 留简短结果并关闭。未达验收项保持打开。此授权不包含自动运行 `git pp`、替换用户数据或重装应用。

## 顺序与完成条件

| 顺序 | Issue | 状态 / 完成条件 |
| --- | --- | --- |
| 1 | [#1 文件身份](https://github.com/MortredVigoss/Melo/issues/1) | 修复与最终验证通过，待本次提交推送及 GitHub 回执 |
| 2 | [#4 历史图片](https://github.com/MortredVigoss/Melo/issues/4) | 待执行；受信资源身份重新解析、过期/重启/端口回归 |
| 3 | [#3 自然搜索](https://github.com/MortredVigoss/Melo/issues/3) | 待执行；自然推荐和否定/引用/本地意图边界 |
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
- 没有运行会打包安装的 `test:full`，没有运行 `git pp`；远端 CI 状态推送后单列。

边界：此项解决审批窗口与异步备份/恢复之间的身份复用，不声称 POSIX `statat` 与 `unlinkat/renameat` 具有按叶子 inode 条件执行的通用原子语义。真实目录不搬迁，备份/回收格式不变；iOS 沙盒文件实现不使用这个原生 addon。
