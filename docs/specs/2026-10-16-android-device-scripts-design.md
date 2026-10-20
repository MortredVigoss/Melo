# Android Task Cache：复用成功操作，未命中时 Probe

状态：用户于 2026-10-16 确认“按推荐：允许自动改写并实现”。Exact / 参数模板 Hit 零 LLM，Similar Hit 自动精简改写，Miss Probe；成功自动缓存，可编辑 / 删除。当前分支 `codex/mobile-use-features`；0.3.1 的重复启动修复独立收尾。

## 用户目标与方案选择

用户要求将成功操作当作 Cache：新目标先找已有脚本，命中则直接运行或修改相似脚本后运行；完全未命中进入 Probe 探索，成功后自动记录。缓存脚本支持编辑与删除，尽量降低 token 和网络 Latency。

推荐 Task Cache + 结构化 Action Script：Exact Hit / 参数模板 Hit 本机执行；Similar Hit 只让 LLM 改写候选脚本；Miss 才完整 Probe。它需要目标可被 Accessibility tree 识别，换来命中时零 LLM 重放和明确的失败位置。

坐标 Macro 的保存更简单，但 Fold6 的折叠、尺寸、弹窗和布局变化容易造成误点。只把旧步骤放入 Skill / Prompt 可更自由地适应变化，但每次仍需完整模型执行，节省有限。

## 用户流程与验收范围

`Chat 操作手机目标 → 本地 Cache lookup → Exact / 参数模板 Hit → 本机重放 → 验证终态`

`Similar Hit → LLM 读取目标 + 精简候选脚本 → 输出改写计划 → 本地校验 → 重放 → 成功写回新版本`

`Miss / 无可信候选 → Probe 探索 → 成功并通过 finish 校验 → 自动写入 Cache`

- 入口仍是 Chat 的“操作手机”。任务卡标记 Cache Hit / Similar Hit / Probe，显示实际模型请求次数与耗时；不能把 Similar Hit 描述成零 token。
- 新任务在显式设备 session 内录制；成功并验证后自动缓存，失败、取消、历史 completed 等未验证任务不作为可复用成功条目。截图、完整 UI tree、密码和模型凭证不随脚本保存。
- 历史 Run 只有动作摘要，不能恢复旧参数；升级前记录不能直接转换。新缓存跨重启保留。
- Chat 仍提供手动选择 / 运行入口；Cache 管理支持列表、编辑、删除、启用 / 禁用。第一版编辑器提供名称与 JSON 步骤编辑，以及可读摘要；修改后先校验，再写入。
- 可编辑 App package、目标 selector、文本输入参数、等待、步骤顺序与完成断言；允许增删步骤。无隐式模型生成或修复。
- 删除有名称确认。若同一脚本正在运行，先停止该次执行，再删除；保存的脚本与源 Chat 独立，删除源 Chat 不会隐式删除脚本。

## Cache lookup、参数化与失效

- Exact Hit 使用目标与必要运行范围匹配，只修剪目标外侧空白；实体名称、固定内容、参数值的大小写 / Unicode / 内部空白保持原样，避免把 Bob / BOB 或不同文字当作同一目标。相似候选检索可做大小写 / Unicode 归一化，但不能直接授权执行。
- 可从成功操作中提取文本输入参数；只有目标模板能无歧义绑定参数时才作为零 LLM 模板 Hit，值在本次运行内存中传递。不自动持久化原始输入值。
- Similar lookup 在本机按目标文本、App package 与步骤摘要检索最多 3 个候选；模糊匹配只是候选，不能直接授权执行。允许 LLM 读取新目标和精简脚本做一次计划改写；计划必须通过同一 Validator，不能包含任意代码。
- 相似候选不够可靠、改写失败或不受支持时进入 Probe；不会把“名称相似”当作任务相同。
- 缓存编辑后状态是“已编辑，待验证”；首次实际运行通过终态断言后才成为可信自动命中条目。
- 条目保存格式版本、验证时间、命中 / 成功 / 失败次数、最后失败步骤与失效原因。页面或目标变化后标记需要重新验证，而不是无限命中失败条目。
- 重放失效后停止当前序列。可基于当前实际页面继续 Probe，显式告诉模型已经执行的步骤和失败位置；不得从头盲目重放点击 / 输入 / 提交。含可能提交动作或无法判断已执行效果时使用 needs_user，不自动继续。
- 编辑和删除可清除错误条目；提供强制 Probe 入口，避免错误 Exact Hit 持续占用同一目标。

## 录制与稳定目标

只在显式用户启动的 DeviceAgent session 中，内存记录成功调用和它操作前的 observation；成功验证后写入精简 Cache。运行时的 screen_id、node_id、window_id 不可作为持久目标。

- open_app 保存已解析的确切 package_name。
- tap / type_text 保存 App package 与组合 selector：可用的 view_id、精确 text / description、class 及目标类型；重放必须唯一匹配，零个或多个匹配均停止。
- Fold6 多窗口通过前台 App、窗口 title 与当前 related_windows 重新定位；每次换窗重新 observe，不能复用旧坐标或 Node ID。
- observe / list_apps 是探索步骤，不直接重放；保留必要的 open_app、Node tap / type_text、home / back、swipe、wait，以及终态断言。
- 输入默认保存为运行时参数（如 input_1），不会自动固化原输入内容；能从目标模板绑定则自动填入，不能绑定则请求用户填写。用户可在编辑器明确填写固定文本。
- 纯坐标 tap 或无法生成稳定 selector 的任务，第一版不允许直接保存为可运行脚本；给出具体不支持的步骤，不生成会盲点的 Macro。
- swipe 保存在已识别 scrollable Node 内的方向与比例；无法识别容器则不可录制。屏幕尺寸变化时重新计算当前容器坐标。
- 出现失败调用、重复启动恢复、原生用户确认等记录时，只保留已成功且具可重放目标的动作；不可跳过无法证明必要性的步骤并仍宣称脚本完整。无法确定时拒绝转换并说明位置。

## 执行、终态和失败

Exact / 参数模板 Hit 的 ScriptRunner 直接使用现有 DeviceExecutor；不创建 DeviceAgentClient，也不要求模型连接或 Key。Similar Hit 改写与 Probe 使用所选模型。脚本快照与输入参数在调度时捕获。

`已保存步骤 → 新 observe → selector 唯一定位 → 使用本次 screen_id / node_id → 执行 → 新 observation`

- 一个设备 lease、现有悬浮停止按钮、取消、锁屏中断和原生本步确认继续生效；脚本与 LLM 任务不能同时操作设备。
- 导航或加载只进行有界等待 / 重新 observe，不自动重复 tap、type_text、提交或发送。单步等待最多 10 秒，整个脚本最多 60 个动作 / 10 分钟。
- 重放发现目标不匹配、权限不足、页面变化、App 不存在、系统拒绝等，立即停止当前序列并显示原因；进入 Probe 时标记模式变化与新的模型请求，不能仍显示为零 token Cache Hit。
- 完成断言复用 DeviceCompletion：重新观察所选窗口，检查保存的 expected_package 和 / 或 exact visible_text。复杂目标不能只因打开 App 而自动完成。
- 脚本为有限序列；第一版无任意代码执行、循环、条件分支、定时任务或跨设备同步。

## 数据与模块边界

- AppData 新增默认空的 deviceScripts；使用现有 Room document / Repository 模式，向后兼容已有 JSON。只缓存验证成功的可复用脚本，不进入 Snapshot / mobile-sync。
- DeviceScript / ScriptStep / NodeSelector / ScriptParameter / CompletionAssertion 为版本化的序列化数据，含 id、name、sourceRunId、createdAt / updatedAt。
- ScriptRecorder 从 session 内 observation 和成功 action 构建候选；ScriptValidator 校验导入 / 编辑的全部结构、大小、动作白名单与 selector；ScriptRunner 只负责本机重放。TaskCacheRouter 处理命中 / 相似候选 / Probe，ScriptPlanner 仅改写结构化计划。
- DeviceAgent 统一设备占用与 DeviceRun 结果；回放记录标记“本机脚本”，保留脚本版本与 step index，不保存参数值或完整目标 tree。
- 脚本编辑期间运行使用已捕获快照；删除当前脚本则取消该次执行。Activity recreation / 重启保留已保存脚本，重启不自动恢复设备动作。

## 验证

JVM：临时 ID 不入脚本、参数不自动持久化、selector 唯一匹配、旧数据兼容、编辑校验 / CRUD、取消、有限等待、错误步骤定位、终态重查；Exact Hit 使用会直接报错的模型客户端证明无 LLM 调用。另测意图不误合并、相似候选不能直接执行、参数唯一绑定、Miss Probe、改写校验、编辑后待验证、失效降级与不重复提交。

Android Emulator：Probe 原生 Node 操作 → 成功自动缓存 → 重启 → Exact Hit 无模型调用 → Similar Hit 改写复用 → 修改 / 运行 / 删除；拒绝坐标盲录、改变目标后零误点、lease 冲突、确认 / 停止 / 锁屏。不得在用户实体机运行会替换账号和资料的 Fixture。

Fold6：现有模型 Probe 一次只读设置任务，自动缓存后再次输入同一目标；验证 Exact Hit 无模型请求、相似目标复用、全新目标 Probe，以及编辑 / 删除和停止。保持现有聊天、角色、模型 Key 和其他辅助服务。

## 实施顺序

1. 先独立提交已验证的 0.3.1 loop / pane 修复及真实手机证据。
2. 用户认可本规格后提交设计，增加模型 / Recorder / Validator 和 JVM 验证。
3. 增加无 LLM 的 Runner、Cache router、Similar Hit planner，接入设备 lease 与结果记录。
4. 接入 Chat 自动缓存路由、模式显示、手动运行、Cache 管理与编辑 / 删除。
5. 运行 Android gate 与 Emulator flow，再覆盖安装 Fold6 做只读验证；更新总览和进度。
