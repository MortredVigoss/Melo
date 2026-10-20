# Shared Agent Core：本机 Runtime 与 Turn Guard 检查点

用户已选择同源本机 JavaScript Core、手机独立运行；规格和后续范围见 `specs/2026-10-17-shared-agent-search-design.md`、`shared-agent-implementation-20261017.md`。本阶段不依赖 Desktop 保持在线，不调用真实模型或读取私人手机资料。

## 已接入的路径

`shared/agent` 保存共同源码；可复现构建生成 bundle / 源码 SHA-256 manifest。Node 直接导入相同 reducer；Android 将 bundle 放入安装包，用 Application 共用 sandbox、每轮独立 isolate 执行。JSON 通过 named data 传入，不作为代码拼接；关闭一轮不关闭其他 Chat。

Node Main Loop 与 Android Chat / Device Probe 已在生产入口使用同一 Turn reducer：能力快照、整轮 call ID、call/result 配对、轮数 / deadline、持续失败与重复结果停止。Node 原有参数 / 权限 / 串并行执行器及 Android screen / native confirmation / completion verification 保留。尚未将整个 orchestration、Task Cache、Memory / Context 全部迁移。

URL / Request Policy / Skill Catalog 与 legacy Search Router 的逐字移植独立提交 `3f47e29`；旧入口兼容。Desktop 静态 URL 模块路由另补指向共享实现，浏览器不会加载 Node 兼容 wrapper。新增的 capability-aware Search reducer 已覆盖 Fixtures，**尚未接通生产 Search executor 和各端统一配置**，不能称 API-first 搜索已交付。

iOS 安装包资源、JSCore Adapter、生成工程和 Conformance 测试源码已加入。当前没有 macOS 执行器，未声称 Swift 编译 / iOS 原生执行通过，生产 Loop 暂不切换到尚未验收的 Adapter。

## 实际验证

- 共享 Node bundle / 20 个跨引擎 Fixtures、调用身份、批次许可、迟到结果、deadline、停止条件与隔离通过；bundle / iOS 资源逐字相同并检查每个源码 hash。
- Android 115 JVM、Lint、Debug、Release/R8 通过；Emulator API 36 的 34 项运行回归通过，含后台 Service 无 Activity 执行、中文数据桥接、isolate 关闭隔离，以及真实 Chat → Device Probe / 取消 / Task Cache。
- Node 真实 HTTP 模型 Fixture 集成确认：永久失败 3 次模型往返后停止（原执行器抑制第三次重复 effect），不变成功结果 6 次后停止；在途模型 deadline 取消后不执行迟到工具。
- iOS JS renderer / manifest gate 通过；Swift suite 明确 skipped。个人 Fold6 没有安装本阶段测试 APK；没有推送或运行 git pp。

完整机器可读证据：`evidence/shared-agent-runtime-20261017.json`；日志在 `.tmp/agent-core-audit-20261017/`。

## 广泛回归的边界

首次日常 gate 执行 403 个 JS 文件，报错包括 macOS Chrome 默认路径、旧的 10 轮断言、inode 复用和缺少 Ruby。已修本次引入的静态模块路径，更新停止行为断言，并以 WSL Chromium 复跑浏览器；并行 Persona 启动失败单独串行复跑通过。Chat Density 在当前树与独立 `ff0f128` baseline 都在相同排版检查超时，保留未解。

未改动的两个文件安全 suite 改用 tmpfs 后 71/71 通过；默认 `/tmp` 的 inode 立即复用不能充当目录替换反例。`ruby --version` 本机不存在，原 suite 的外部工具前提仍未满足。日常 gate 没有全绿，不能把本次定向通过写成完整发布验收。

## 接续

下一阶段将共同 Search plan / Tool contract 接入各端真实 Chat，并配置实际可用的 Hosted / HTTP Backend；没有 Backend 时明确 unavailable。接着迁移 Skill 调度、Context / Memory 与 Task Cache 对应模块。每个模块以真实入口和平台证据分别验收；iOS 原生接入仍需 macOS。
