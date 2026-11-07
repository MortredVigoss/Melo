# 模型设置双端发布 · 2026-11-07

用户授权正常推送并合入 master，原位覆盖 Mac / iPhone，保留账号、密钥和全部业务数据。起点 master bc75220d，远端 origin/master 6bb8da28。手机安装前实查 0.7.15 (47)，合并远端后使用 0.7.16 (48)。

## 执行链路和审计边界

- 本次合并保留模型连接 UI 与固定模型策略（81ae41a5），同时合入远端的成员检索、来源核验和任务空间修复。功能链路详见 [设置专项](model-settings-structure-20261107.md) 和 [主线审查](war-room-routing-review-20261107.md)。重点核对 ChatStore / AgentLoop、ChatEngine、chatExecutionRunner 与共享生成资源。
- 桌面发布：verify-red-green.js:runStep / releaseOnly → build-desktop-app.sh → install-desktop-app.sh:verify_bundle → 临时完整 bundle → 原位替换 ~/Applications/Melo.app → assertNativeLaunch。源代码路径仍是产品主检出，MELO_HOME 仍为原 .tmp/melo-home-user。安装只替换应用，不重置用户状态或配置。失败保留旧包备份，前置非 GREEN 不安装。
- 手机：原 bundle com.melo.iphone.mfpiao / team XL7DA6573A → devicectl 两次完整容器读取与 SHA-256 → xcodebuild Release 签名 → devicectl install app 原位覆盖 → 装后回读 → 首启 / PID → 再回读。JSON / plist 结构一致性单列，缓存变化不冒充数据丢失。Keychain 不迁移、不删除，签名身份不改变；账号标识与启动读取状态另验，不能用容器备份声称已导出 Keychain。
- 覆盖：全部任务文件快速档、合并基准集成档、桌面发布门禁、签名与版本、Mac 业务/配置快照、iPhone 完整容器与聊天/Agent/草稿/图片/偏好数据。
- 停止边界：供应商服务、远端同步部署、真实模型问答和长后台不在此次发布验收中。历史模拟器设置验收是此前 UI 提交证据，不能替代本次实体覆盖结果。

## 当前进度

- Mac 已关闭，原数据目录与已装 bundle 已备份到 Library 私有备份目录；没有写入用户配置。
- iPhone 首次完整读取在系统 SplashBoard 快照上遇到文件保护，用户已解锁，重新读取中；备份未通过前不安装。
- 合并已暂存，源码自动合并；进度文档与生成资源冲突待消解。最终合并提交须在集成档通过后创建。
- 证据目录 `.tmp/model-settings-release-20261107/`，私有备份入口 `private-backup-path`；仅记录计数和校验，不提交秘密或用户内容。

## 发布前发现的测试隔离问题

- 当前 Mac state.json 在本次发布前已是 audit-unverifiedReport 夹具，真实聊天索引与 thread checkpoint 不完整。本次原样备份 6,013 文件 / 7,610,534,932 字节；与源目录逐文件一致。不得把这份受污染快照称为原业务数据保留成功。
- `orchestrationReview.test.js` 在模块顶层逐个 `await test()`，却注册根级 `after()` 恢复 MELO_HOME。Node 22 直接执行时根清理提前触发，后续 `saveState` / execution runner 捕获恢复后的默认用户目录。隔离源码副本以 sentinel-home 为“原目录”重放，测试全过但 sentinel 中出现 state.json（isolation-red.json）。该副本不接触正式目录。
- 修复边界为测试生命周期：一个父 test 内串行 `t.test`，父级 `t.after` 在全部子用例结束后清理；每个子用例入口检查 MELO_HOME 仍是隔离目录。生产路径和用例断言不变。重复隔离重放需证明 sentinel / 默认目录均无写入，再重跑完整任务快速与基准集成。
- 已定位 11-05 私有完整备份（33 聊天 / 752 消息 / 6 Agent / 1 项目），另有 3 段后续真实聊天的执行记录和 trace；当前账号连接配置比旧备份更新，必须保持当前 config.json，不能整目录回滚。
- 恢复候选、原始受污染快照和 trace 全保留；后续数据完整性结论必须区分原字节恢复与从执行记录补回的内容，不能声称未经证明的零丢失。

## 已完成的恢复与实界面核验

- 用户明确选择“恢复完整备份，保留较新记录副本”。先再次保存恢复前 state / threads / config，仅原子恢复旧 state.json 与对应聊天 checkpoint；没有回滚 config.json 或密钥。
- `recovery-applied.json`：33 聊天、752 条原消息、6 Agent、1 项目，与备份逐文件一致。较新 3 段的原始执行记录另存私有 recovery-candidate/later-execution-records.json，未当成完整聊天导入。
- 正常启动并通过原生窗口观察：主页显示 33 / 1 / 6；模型设置默认仍为原 Anthropic 连接且 API Key 已保存；切换到 ChatGPT 分支实际显示“ChatGPT 已登录”，默认连接不变。首页标签、五分支和星图无本轮视觉改动。
- 首次恢复启动后再次核对，752 条原消息与原账号连接配置仍一致；`desktop-recovery-ui.json`。这一步是恢复验收，正式 bundle 覆盖尚待发布门禁。
- iPhone 签名 Release 已构建成功，0.7.16 (48)，原 bundle / team / 设备白名单通过；签名到期 2026-11-13 13:50:40 UTC，未安装。见 `iphone-signing.json`。

## Final merge gates

- Final quick `run-M70gm7`: JS 5039/5039, no failures/cancellations/skips, no flaky retry; Android, settings browser, 38 Swift suites GREEN (388.8s).
- Base integration `run-paxLbP` against cc115e8e: all stages GREEN (554.1s), exact code fingerprints checked against final-source-hashes.json.
- Earlier merged-tree quick `run-7o6aKP` also passed, but it predates the test lifecycle fix and is not the final evidence.
