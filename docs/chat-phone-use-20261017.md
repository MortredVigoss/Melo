# Chat Phone Use — 0.5.0（2026-10-17）

用户确认“生硬”来自独立手机助手入口，要求在普通 Chat 自然 invoke 手机能力，并明确 Go ahead；微信输入后置。[设计](specs/2026-10-17-chat-phone-use-design.md)，产品提交 `954b382`，分支 `codex/mobile-use-features`。

## 行为

`普通 Chat → 模型按需 phone_use → 现有 DeviceAgent → 回执 → 同一 Chat 整理回答`。

- 移除 Chat 的模式切换与首页 / 顶部独立助手入口。手机授权 / Display / 独立诊断留在「系统 → 手机控制设置与诊断」，Cache 管理在 Chat 的历史图标。每 Chat 可在对话设置关闭「允许调用手机」；不自动获取 Android 权限。
- 内置 Skill 是 ChatPhoneUse 的工具定义和调用指令，未安装外部 Skill / MCP / AutoInput。三种协议均注册高层 phone_use，子 Agent 继续只使用 android_device；普通问答不创建设备会话。对话历史用于解析“第二家”等追问，子目标需自包含。
- research 强制实时 Probe 且不自动缓存查询；action 复用既有 Exact / Similar / Probe。不能用缓存历史餐厅状态回答现在是否营业。Exact 仅设备执行可零模型，普通 Chat 的规划与整理仍调用模型。
- 任务捕获原 Chat 的模型、Key、角色、项目及指令；不随 UI 切换而改变。设备仍独占；普通 Chat 之间可并发。Chat 停止会取消自己的子任务，手机悬浮停止后不续跑；失败、需用户和重复目标停止。每轮最多 3 个不同子任务 / 15 分钟，每个子任务仍最多 10 分钟。
- 查询成功后尝试返回所属 Chat；普通打开 App 的 action 保留目标页面。回执和正常最终回复分别保存；完整 tree / screenshot / 工具原始参数不进入 Chat 或 sync。用户请求的查询摘要作为普通回复参与既有文字同步。后台拉起被系统拒绝时不丢失已保存结果。
- 子任务启动不清除下一条草稿；Activity 返回 / recreation 不重复清空。删除 Chat 后既不继续设备动作，也不在最终资料事务里写回迟到消息。

## 验证

最终源码 109 JVM / 39 Android 16 runtime（零失败 / skip）、Lint 零 errors、Debug / R8 Release 全通过；同一 development certificate、APK signature / 四 ABI 16 KiB alignment 通过。

Native 包含真实服务的 ChatEngine → localhost HTTP Tool → DeviceAgent → 完成回执 → Chat 回复；验证上下文快照、实时 Probe 不写查询 Cache、下一条草稿保留、取消后迟到动作不执行、删除隔离、受阻不续跑、关闭 Skill 回到原聊天，以及无需模式切换的卡片 / recreation 和原 Cache CRUD。

首轮 5 项新增 Native 链路通过，但原后台恢复测试在 teardown 失败；定位为 onNewIntent 更新 Intent 后夹具未保留 ActivityScenario 启动身份，并补实际 resumed 等待。没有删断言 / skip / 放宽超时。第二轮 Emulator 运行内存耗尽，停止本轮专属 QEMU，未停其他用户服务，该轮不计通过。最终先完成全部构建 / test APK，再启新 Emulator 跑完整 39 项，全部通过后关闭 Emulator。

日志 `.tmp/chat-phone-use-check-final.log`、`.tmp/chat-phone-use-prepare-tests.log`、`.tmp/chat-phone-use-connected.log`；反例日志保留为 `chat-phone-use-connected-first.log` / `chat-phone-use-connected-oom.log`。

## Fold6 最终同包实测

同证书升级 0.5.0 / versionCode 12，安装前后 7 Chat / 1 角色及其他 Accessibility Services 保留；未读取手机 Key。随后创建一个独立 QA Chat，保留供回看。模式 unfolded 1856×2160，既有真实 gpt-6.1-sol 连接。

1. 普通 Chat 提问 2+3，回复 5，没有手机任务卡片；未进入独立助手或模式切换。
2. 普通 Chat 请求在 Google Maps 搜索 Surry Hills 餐厅并读取两条当前营业状态。设备子任务 Probe 9 steps / 9 model requests / 53.543s；实际读到两条列表，明确广告和 Paddington 区域不确定性，然后原 Chat 输出独立最终回复。
3. 追问“第二家名称明确写的是哪个城区，并重查原结果，不重新搜索 / 打开详情”。高层 Tool 目标包含上一轮具体餐厅名称；设备 Probe 5 steps / 5 requests / 31.531s，原 Chat 回复 Paddington。上述 request counts 仅设备子任务，不是整轮 Chat 总计。

ActivityTaskManager 在后续 ADB 检查前，记录两次由 com.melo.android 自身发起的 MainActivity 返回、BAL_ALLOW_TOKEN 与 result code 2。windows 子命令不提供 focus 字段，空 focus 样本未算作失败或成功证据；保留系统启动记录作为返回路径证据。没有代点本步确认、预订、致电、路线导航或发送消息。餐厅内容只代表当时显示，不是当前推荐或独立商业事实核验。

[脱敏回执](evidence/chat-phone-use-fold6-050-20261017.json)。最终已安装 APK 与交付 SHA 一致：`d2328c41574e9b7c71eb5950b5a6c4eb9fd578d042048815af95f5c8d03c4a1e`，3,908,845 bytes。

## 边界

Phone Use 开启时本版普通 Chat 使用非 Streaming Tool Calling，整段回复返回后显示；关闭后及 Fixture 沿用原 streaming 路径。工具只在完整、有效回执后执行。

小红书未实机复测；0.5.0 本次没有重新做 folded 实机查询。0.4.2 的双模式截图是历史证据；Fold Cache 几何分区仍待做。微信空 tree 的独立输入 / IME 按用户要求暂缓。没有接入外部 PhoneUse、AutoInput、Shizuku 或新权限。未运行远端 CI / 整个 repo gate，未推送或 git pp。

## 0.5.1：减少 App discovery 往返并覆盖 Fold6

用户指出先列大量 App 不合理；本轮修正 Android Adapter 的调用指令与参数约束，准确名称 / 包名优先直接 open_app，本机解析并回传当前画面；失败先用已有候选，必要时定向检索。默认 10 候选、定向上限 20，清单浏览需 browse=true；精确候选不夹带模糊匹配，重名仍需消歧。屏幕动作使用已有新观察，完成仍由 Host 重查。

113 JVM / 40 Android 16 runtime、Lint / Debug / R8 Release 通过；三协议 HTTP Fixture 的直接打开子任务只需两次模型请求，真实 Service 的标签启动 / 空清单拒绝 / 小页查询通过。详情与失败记录见 [Android verification](../android/verification.md)。后续 0.5.1 同签名覆盖 Fold6 保留原 10 Chat / 1 角色；folded 真实模型首轮 12 步受阻，关闭旧搜索页后同 Chat 重试 5 步 / 23.806s 取得「设置」标题并完成。两轮无 list_apps，但跨包恢复与 stale-screen 额外恢复仍未修；[实机回执](evidence/app-discovery-fold6-051-20261017.json)。以上 0.5.0 SHA / unfolded 证据仍为历史，40 runtime 属于版本号更改前的同一产品逻辑基线。共享 Core 与搜索优先路由尚未完成。
