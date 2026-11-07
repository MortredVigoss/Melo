# 模型设置双端发布 · 2026-11-07

用户授权正常推送并合入 master，原位覆盖 Mac / iPhone，保留账号、密钥和全部业务数据。起点 master bc75220d，远端 origin/master 6bb8da28。手机安装前实查 0.7.15 (47)，合并远端后使用 0.7.16 (48)。

## 执行链路和审计边界

- 本次合并保留模型连接 UI 与固定模型策略（81ae41a5），同时合入远端的成员检索、来源核验和任务空间修复。功能链路详见 [设置专项](model-settings-structure-20261107.md) 和 [主线审查](war-room-routing-review-20261107.md)。重点核对 ChatStore / AgentLoop、ChatEngine、chatExecutionRunner 与共享生成资源。
- 桌面发布：verify-red-green.js:runStep / releaseOnly → build-desktop-app.sh → install-desktop-app.sh:verify_bundle → 临时完整 bundle → 原位替换 ~/Applications/Melo.app → assertNativeLaunch。源代码路径仍是产品主检出，MELO_HOME 仍为原 .tmp/melo-home-user。安装只替换应用，不重置用户状态或配置。失败保留旧包备份，前置非 GREEN 不安装。
- 手机：原 bundle com.melo.iphone.mfpiao / team XL7DA6573A → devicectl 两次完整容器读取与 SHA-256 → xcodebuild Release 签名 → devicectl install app 原位覆盖 → 装后回读 → 首启 / PID → 再回读。JSON / plist 结构一致性单列，缓存变化不冒充数据丢失。Keychain 不迁移、不删除，签名身份不改变；账号标识与启动读取状态另验，不能用容器备份声称已导出 Keychain。
- 覆盖：全部任务文件快速档、合并基准集成档、桌面发布门禁、签名与版本、Mac 业务/配置快照、iPhone 完整容器与聊天/Agent/草稿/图片/偏好数据。
- 停止边界：供应商服务、远端同步部署、真实模型问答和长后台不在此次发布验收中。历史模拟器设置验收是此前 UI 提交证据，不能替代本次实体覆盖结果。

## 发布结果

- 合并提交 `701e43f5e67e3e029630fa082bf3302b0583ea95` 已正常推送 master，远端 ref 已回读一致；保留双方修改，未强推。
- Mac 已按用户确认恢复数据，正式 release:verify 17 项全绿后原位覆盖；正常启动和模型设置实界面已核对，安装前后 6,047 个文件完全一致，启动后原聊天与当前配置仍一致。
- iPhone 首次读取曾被 SplashBoard 文件保护拦住，用户解锁后两次完整备份一致，安装前第三次回读仍一致；0.7.16 (48) 已原位安装并完成首启和实机 UI 检查。
- 证据目录 `.tmp/model-settings-release-20261107/`，私有备份入口 `private-backup-path`；仅记录计数和校验，不提交秘密或用户内容。

## 发布前发现的测试隔离问题

- 当前 Mac state.json 在本次发布前已是 audit-unverifiedReport 夹具，真实聊天索引与 thread checkpoint 不完整。本次原样备份 6,013 文件 / 7,610,534,932 字节；与源目录逐文件一致。不得把这份受污染快照称为原业务数据保留成功。
- `orchestrationReview.test.js` 在模块顶层逐个 `await test()`，却注册根级 `after()` 恢复 MELO_HOME。Node 22 直接执行时根清理提前触发，后续 `saveState` / execution runner 捕获恢复后的默认用户目录。隔离源码副本以 sentinel-home 为“原目录”重放，测试全过但 sentinel 中出现 state.json（isolation-red.json）。该副本不接触正式目录。
- 修复边界为测试生命周期：一个父 test 内串行 `t.test`，父级 `t.after` 在全部子用例结束后清理；每个子用例入口检查 MELO_HOME 仍是隔离目录。生产路径和用例断言不变。隔离重放通过且 sentinel / 默认目录均无写入（isolation-green.json）；修复后的完整任务快速与基准集成均通过。
- 已定位 11-05 私有完整备份（33 聊天 / 752 消息 / 6 Agent / 1 项目），另有 3 段后续真实聊天的执行记录和 trace；当前账号连接配置比旧备份更新，必须保持当前 config.json，不能整目录回滚。
- 恢复候选、原始受污染快照和 trace 全保留；后续数据完整性结论必须区分原字节恢复与从执行记录补回的内容，不能声称未经证明的零丢失。

## 已完成的恢复与实界面核验

- 用户明确选择“恢复完整备份，保留较新记录副本”。先再次保存恢复前 state / threads / config，仅原子恢复旧 state.json 与对应聊天 checkpoint；没有回滚 config.json 或密钥。
- `recovery-applied.json`：33 聊天、752 条原消息、6 Agent、1 项目，与备份逐文件一致。较新 3 段的原始执行记录另存私有 recovery-candidate/later-execution-records.json，未当成完整聊天导入。
- 正常启动并通过原生窗口观察：主页显示 33 / 1 / 6；模型设置默认仍为原 Anthropic 连接且 API Key 已保存；切换到 ChatGPT 分支实际显示“ChatGPT 已登录”，默认连接不变。首页标签、五分支和星图无本轮视觉改动。
- 首次恢复启动后再次核对，752 条原消息与原账号连接配置仍一致；`desktop-recovery-ui.json`。这一步是覆盖前的恢复验收；正式 bundle 覆盖及启动结果见文末。
- iPhone 签名 Release 已构建成功并原位安装，0.7.16 (48)，原 bundle / team / 设备白名单通过；签名到期 2026-11-13 13:50:40 UTC。见 `iphone-signing.json` 与下述实机验收。

## 最终合并门禁

- 最终快速档 `run-M70gm7`：JS 5039/5039，失败 / 取消 / 跳过均为 0，无隔离复测；Android 四阶段、设置浏览器、38 组 Swift 全绿（388.8 秒）。
- 基准集成档 `run-paxLbP`（基准 cc115e8e）：全部阶段全绿（554.1 秒），最终代码与 final-source-hashes.json 逐项一致。
- 更早合并树快速档 `run-7o6aKP` 也通过，但早于测试生命周期修复，仅为过程记录，不代替最终证据。

## iPhone 原位覆盖与实机验收

- 原设备 / bundle / 签名身份不变，`devicectl install app` 成功，没有卸载；安装后 apps 信息回读为 0.7.16 (48)，首启 PID 57131 与新 bundle 可执行路径一致。
- 安装前完整容器 285 文件、192,701,408 字节，重复读取与安装前最后一次读取逐文件一致。安装后只有两份 SplashBoard 快照改名，文件大小和 SHA-256 多重集仍完全一致。
- 首启后 18 段聊天、199 条消息、6 个 Agent、27 张原图及偏好均保留。草稿和执行记录字节变动但 JSON 值一致；其余变化为 runtime-events.json 与 dyld 缓存。`phone-after-launch-summary.json` 的 criticalOK 为 true，不能把这些运行期变化误报成零文件变动。
- 已通过 Device Hub 查看并操作实体 iPhone：旧聊天 / 原图可见，模型设置两种连接方式切换时下方内容实际变化；现有 API Key 显示已保存，ChatGPT 页显示 Codex 已连接 / 已登录、凭证已存本机钥匙串。没有重新输入、保存或切换默认账号，没有发送真实模型请求。
- 证据：phone-preinstall-summary.json、phone-install.json、phone-apps-after.json、phone-after-install-summary.json、phone-launch.json、phone-processes-after.json、phone-after-launch-summary.json、phone-ui.json。备份保留在私有目录，Keychain 未导出；身份连续性与实机读取结果单列。

## Mac 发布门禁首轮拦截

- 第一轮 `desktop-release.log` 退出 1，releaseOnly 按规则拒绝安装；错误在汇总打印前抛出，未留下各阶段状态，不能把已运行阶段都算通过。
- 定位到本轮隔离 development journey 的临时任务已达到 awaiting_merge、容器测试 / 审核均通过，但浏览器验收回执未写出。相同脚本单独重放通过，见 journey-probe.log；首轮具体异常文字缺失，不能断言只是超时。
- 第二轮仍使用原 `npm run release:verify`，仅通过临时 preload 对子进程 stdout / stderr / exit 加旁路记录（release-observer.mjs），不改命令、断言、退出码或安装门禁；证据在 desktop-release-observed/。必须本轮全部前置 GREEN 才允许安装。

## 发布调度与失败诊断修正（执行前边界）

- 第二轮旁路日志捕获 agentPersona、agentSettingsSecurity 与 committedSave 三个浏览器文件的时限失败；当时 load 34、16 GB 内存机使用约 12 GB swap。没有实际业务断言失败证据，但本轮未全过，不允许安装。停止本线程诊断进程树并保留原日志，不终止其他线程或用户应用。
- 执行链：`release:verify` → `verify-red-green.js:runStep` → `runCommand` → `run-unit-tests.js` → `discoverRunnableTests` 全量文件集 → Node test runner。仅给 unit runner 增加经校验的 `MELO_TEST_CONCURRENCY`（默认仍 4，发布本次设 1），隔离 MELO_HOME、发现机制、断言、时限和非零退出保持；无测试删减或跳过。用真实子进程夹具检查串行执行、全发现、数据目录隔离和失败传播。
- 失败可观察性：runStep 结束立即打印阶段状态和耗时，RED 带原异常；releaseOnly 的全 GREEN 条件不动。覆盖脚本接线测试、发现器和发布策略；停止在 Node / 子进程边界，产品与 iPhone 二进制不变。
- 这是门禁基础设施改动，按 AGENTS / 开发规范需要全量快速与基准集成，再以完整 release:verify 校准，不能拿前两轮产品代码的绿灯替代。

- 新调度回归先红后绿，18 项脚本专项通过（unit-scheduling-red.log / unit-scheduling-green.log）：真实 CLI 子进程证明串行互斥、全部发现、MELO_HOME 隔离及失败退出；嵌套夹具移除 NODE_TEST_CONTEXT 后再验，未使用伪通过输出。新增测试改变功能地图，首轮预检 run-rrRuXC 正确拦住过期索引，已运行 generate:module-map 更新。
- 发布等待期间旧程序曾正常打开回看已结束的运行记录，随后已关闭。重新核对 33/752/6/1 与当前 config 仍一致；新安装前基线 6,047 文件，较最早基线无删除，变化仅派生索引、SQLite、state、dream scheduler，增加当天后台 dream 记录；旧基线另存 desktop-first-baseline-*，不覆盖丢弃。

- 调度修正后的完整快速档 `run-6LCJs3` 通过（611.7 秒）：JS 5042/5042、失败 / 取消 / 跳过 0、无隔离复测，38 组 Swift、设置浏览器、Android 四阶段及全部前置通过；源码指纹未变。基准 701e43f5 的集成结果见下一条。

- 调度修正后的基准集成 `run-mHbkO2` 通过（基准 701e43f5，553.8 秒）：JS 首轮 5041/5042，agentSettingsSecurity.browser.test.js 服务启动守卫超时；按既有运行器规则唯一一次串行隔离复测 11.81 秒通过，flaky 记录完整。设置浏览器、38 组 Swift 与其余前置通过；此档仅门禁文件改动，Android 不重复选入，已由上述任务快速档覆盖，正式发布已再次通过 Android。两档后源码指纹一致。
- 正式 `MELO_TEST_CONCURRENCY=1 npm run release:verify` 已完成，使用仓库原入口 / 原门禁，没有旁路 preload；新阶段日志直接记录在 desktop-release-final.log。

- 正式串行发布的全量 test:unit 已 GREEN（968.366 秒），没有隔离重跑；Development container isolation（4.850 秒）与 Development desktop journey（14.263 秒）均 GREEN。前两轮涉及的浏览器 / journey 在本轮均通过原断言；首轮具体异常未留存的边界仍保留，不倒推其确切原因。全部发布结果如下。

## Mac 正式覆盖、数据与界面验收

- `desktop-release-final.log` / `desktop-release-summary.json`：17/17 GREEN，包含真实容器、开发与设置浏览器、iPhone 协议和 Swift、Android 四阶段、桌宠资源、桌面打包、壳生命周期、桌面端到端、正式安装，以及桌面文件夹 / 应用程序两个原生启动入口。无跳过、无隔离复测。
- 发布 test:unit 为 5048/5048，失败 / 取消 / 跳过均 0；比日常档 JS 5042 多出的六项是日常已提前执行的地图 / 协议 / 语言预检，test:unit 不做预检去重，因此计数不同，没有删除用例。见 test-count-comparison.json。
- 正式包 `/Users/mortred/Applications/Melo.app` 严格深度签名验证通过，可执行文件 SHA-256 与本次构建一致；桌面快捷入口解析到这个正式包，MeloProjectDirectory 指向产品主检出。壳 Info.plist 仍为静态 0.2.0 (1)，不能称 Mac 的语义版本是 0.7.16。见 desktop-package.json。
- `desktop-after-install.json`：恢复后的最新安装前基线 6,047 文件，安装后无新增 / 删除 / 字节变化；33 聊天、752 条原消息、6 Agent、1 项目、26 成果及当前 config.json 一致。
- 正式普通启动 `/api/health` 指向原 `.tmp/melo-home-user` 和产品根目录；首次验收 runtime revision 为 701e43f5e67e，dirty=true 只来自尚未提交的门禁脚本与回执，产品源码指纹一致。正式窗口显示 33 段对话 / 1 项目 / 6 Agent；原默认连接及 API Key 已保存，切换到 ChatGPT 显示原有连接 / 已登录，下方表单确实变化；没有重新登录、修改凭证、设为默认或发起真实请求。首页五分支和文字实看正常。见 desktop-health-after-launch.json、desktop-installed-ui.json。
- `desktop-after-launch.json`：正常启动后共有 6,050 文件；33 段原聊天 checkpoint 与 752 条原消息仍逐字节匹配恢复备份，当前 config.json 不变，Agent / 项目 / 成果原 ID 均在。新增运行期文件不作业务丢失处理。
- 较新三段记录的私有副本仍在，SHA-256 已另验；它们仍是执行记录，不冒充完整聊天导入。双端实机 / 原生界面已核对，真实供应商问答、远端同步部署、长后台仍不在本次验收范围。
