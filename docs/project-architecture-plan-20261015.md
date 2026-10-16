# Melo 项目边界核对与重构计划

日期：2026-10-15（Australia/Melbourne）。根据用户提供的项目审计，核对当前共享源码并修订方案。本文是待实施设计；本轮只修改文档，没有迁移用户数据、执行文件工具、调用模型或安装软件。

## 1. 结论与证据边界

核心问题成立：项目配置、聊天归属、执行目录、上下文与生命周期缺少一致的解析和变更规则。`projectId` 出现在多个文件本身不是缺陷，关联表也不必全部嵌进一个大对象；重构目标是让项目配置有统一所有者，让跨实体操作维护明确的不变量。

核对基线：HEAD `2cae1cd` 加共享 WIP，27 个关键源码散列见 `.tmp/project-architecture-audit-20261015/source-manifest.json`。以下为源码证据，不声称所有推导场景均已通过原生界面复现。“49 个文件”没有约定统计范围，本轮不以该数字衡量架构好坏。

| 用户提出的点 | 当前源码核对与需要修正的说法 | 主要定位 |
| --- | --- | --- |
| 项目相关数据分散、生命周期不足 | 成立。项目配置、角色覆盖、资料关系、任务/审批与记忆在不同服务维护；当前项目服务有创建/更新/归档，没有完整删除工作流。物理分表可保留，必须统一业务入口 | `src/services/project/projectMutations.js`、`src/state/agentProfiles.js`、`src/persistence/agentMarkdownFiles.js` |
| 新建对象默认跟随界面选择 | 后端残留成立：chat 的 undefined 回退，task/approval 的 `||` 回退；后两者连显式 null 都会被 UI 选中值覆盖。但桌面 `handleCreateChat` 默认传 `newChatProjectId`，初始为 null；不能认定当前首页仅因浏览项目就一定挂错 | `src/services/chat/chatMutations.js`、`src/services/task/taskMutations.js`、`src/services/approval/approvalMutations.js`、`desktop-ui/app.js` |
| 开启项目对话依赖两次请求 | 确有先 patchSettings 再 createChat 两次请求；第二次**已经显式传 projectId**。应去掉不必要的前置设置写入，并补失败/并发测试，不必把该入口当成完全没有显式参数 | `desktop-ui/app.js` 的 `startProjectSession` |
| bootstrap 按选中项目提供资料 | 成立。但项目详情页需要“所浏览项目”，聊天需要“所属项目”，两种投影都合法；应明确分开，不能把全局项目页也一律改为当前聊天的项目 | `src/services/desktop/bootstrap.js` 的 `activeProject` / `projectArtifacts` / `activeChatArtifacts` |
| 项目 prompt 开关不统一 | 成立。目标/要求受 `projects` 角色工具开关影响；选用资料和角色覆盖走另外的路径。记忆不受该工具开关控制，但问候有 skipMemory，检索还受受众/有效性/预算限制，不能称“每次一定检索/注入”。近期成果和命令输出还有 dynamicContext 通道 | `projectContext.js`、`chatExecutionRunner.js`、`conversationSelection.js`、`dynamicContext.js`、`src/services/agent/agentMemoryContext.js` |
| 无项目/旧项目回退 APP_ROOT | 成立。无项目 snapshot 虽标 exists:false，仍返回 APP_ROOT 并传给工具；旧项目规范化、远程后台分支也有回退。**新建项目已默认创建 MELO_HOME/workspaces/<id>**。Bash 无 workspace 还会回退 process.cwd，必须一起收口 | `workspaceSnapshot.js`、`sendChatMessage.js`、`stateHydration.js`、`projectMutations.js`、`src/tools/builtins/bashTool.js` |
| 程序目录自动获得写权限 | 应收窄表述：APP_ROOT 会被误判为工作区内，Bash 的部分安全白名单命令可免提示；普通写文件仍经过已有 grant/规则/审批，不能据此断言所有写操作免确认 | `src/tools/builtins/bashTool.js`、`src/safety/fileSafetyGate.js` 的 `requestWrite` |
| 默认占位文案进入模型 | 成立。createProject 和 normalizeProject 均有默认文本，UI“项目目标”写 summary。只改创建接口不足以阻止旧数据规范化重新补回 | `projectMutations.js`、`src/domain/project/projectService.js`、`desktop-ui/app.js` |
| 移动聊天只改归属 | chat mutation 没有完整级联规则。记忆需细分：手动编辑/设作用域的记录被 userEdited 保护，通常仍留旧项目；未被保护的记录在 reconcileChatFacts 时可随 chat.projectId 更新。不能统一称“全部不迁移”，现状是迁移语义不一致 | `chatMutations.js`、`src/memory/factRecords.js`、`src/memory/derivedIndex.js` |
| 桌面/手机字段不同 | 桌面内部 summary 与协议 goal 的适配确实存在；**已有共用 schema，project wire 已携带 agentOverrides**。workspacePath/执行权限不进同步是应保留的设备边界，不是需要照搬到手机的缺失字段 | `src/services/chat/portableWorkspace.js`、`mobile-sync/workspaceProtocol.js`、`shared/protocol/sync.schema.json` |
| “处理项目代码”入口职责混乱 | 当前是带 projectId、mode=code 创建聊天的快捷入口。mode 属于聊天；保留此便利入口并不必然破坏模型。是否删除按产品体验决定，不作为数据重构的前提 | `desktop-ui/app.js` 的项目详情与 `startProjectSession` |

另需注意资料语义：`summarizeProject` / bootstrap 用 `artifact.projectId OR knowledgeIds` 展示和计数；`selectedMaterials` 只把显式 `knowledgeIds` 与聊天选中资料作为完整资料注入。直接把所有旧 artifact.projectId 合并成 knowledgeIds，会让过去只展示的资料突然进入完整 prompt，甚至触发 8 份/24000 字限制。

## 2. 建议目标模型

```text
Project：项目配置与生命周期的所有者
  id, revision, name, goal, instructions, contextEnabled
  knowledgeIds（明确选作项目上下文的资料引用）
  agentOverrides（可同步的角色内容）
  archived, deletedAt

LocalWorkspaceBinding：本设备的执行位置与授权绑定
  projectId 或 chatId → workspaceId, path, revision, 本机授权状态

Chat → projectId 或 null
Task → 来源 chatId / 显式项目归属
Run / Approval → 创建时捕获的执行目标快照

Artifact / ImageAsset：独立内容与稳定资源身份
  聊天、项目、草稿、编辑链通过引用关联；原件不随文件夹归属迁移
```

Project 可以通过领域接口访问自己的工作区绑定，无须把全部聊天、任务、图片、记忆正文塞进项目记录。图片资源登记沿用[图片承载计划](image-capacity-plan-20261015.md)，避免建立第二套资产库。

`knowledgeIds` 统一表示显式选用集合。旧 artifact.projectId 的来源/展示语义先保留为兼容关系或来源元数据；不得直接把它升级为模型选用权限。迁移前比较旧/新资料可见集合和 prompt 选用集合；如产品要引入项目资料库的独立成员关系，定义一份规范关系，避免两份可独立写入的成员列表。

目标字段统一为 goal；summary 在兼容期只作为读入别名。保留现有 tag 或另行明确弃用，不能在收拢记录时丢掉分类。原有 Markdown 角色文件如含用户改动，须先核对差异、备份并决定权威来源；不能直接当缓存删除。

## 3. 工作区默认行为

建议采用 B。以下评分是本轮设计判断，按操作连续性、权限清楚、成果持久性综合，不是测试成绩。

| 方案 | 评分 | 行为与代价 |
| --- | --- | --- |
| A：每次涉及文件先选文件夹 | 8/10 | 边界最直观；普通生成文档和轻量计算也增加选择步骤。图片生成功能仍需独立资产库，不能要求为了预览先建项目 |
| **B：按需创建聊天独立的持久工作目录** | **9/10，推荐** | 首次需要文件工作时分配到 MELO_HOME/workspaces/chats/<chatId>；跨重启保留；访问用户其他目录仍明确授权。增加目录登记/容量治理，但保持普通使用顺畅 |
| C：操作系统临时目录 | 5/10 | 适合中间文件；会被清理，不能作为历史成图、导出文档或长期对话唯一保存位置 |

采用 B 的具体边界：

- 项目未绑定外部目录时，可以按需创建受管理的项目工作目录；保留现有独立目录，不整体搬家。闲聊本身不创建目录、不扫描磁盘。
- 没有工作区时以 null/明确状态表示，不把 APP_ROOT 或 process.cwd 作为默认值。所有工具消费者必须处理该状态，不能仅修改 snapshot 后留下另一层兜底。
- 原图与需要长期保留的成果进入资产存储；工作目录只包含任务文件及其引用。scratch/staging 与成果分区管理，TTL 不可应用到原件。
- 旧数据中路径恰好为 Melo 程序目录时，无法仅凭路径断言是旧默认还是用户主动选定。保留原记录与文件，要求补充明确绑定后才能执行；本轮不自动迁移或删除 generated/。
- 用户明确选择 Melo 源码作为项目工作区时仍可正常开发；禁止的是隐式赋予，不是禁止用户管理自身项目。

## 4. 统一解析入口的契约

建议 `resolveProjectContext({ state, chat, requestContext })` 返回不可变的领域结果：projectId/revision、goal/instructions、选用资料引用、角色覆盖、记忆范围、workspace binding。请求入口捕获 home、chat/project revision 与执行身份，后续异步阶段使用同一份快照，不再读取 UI 选中状态或全局可变 home。

解析入口不同时负责建目录、扫描文件、发模型请求和授予权限。目录/资源读取和安全检查由现有服务按解析结果执行。抽取已有逻辑时先逐字节移植、接线并回归，再在独立提交中改变行为，符合 CLAUDE.md §5。

“项目上下文启用”只控制语义内容：目标/要求、项目资料、项目记忆、项目角色内容及其他项目范围的提示块。当前聊天显式附件、自己的对话历史和自身资料保留。关闭时在界面展示生效范围，防止 dynamicContext/近期成果等旁路继续注入项目内容。该开关不能开启文件权限、改变受众边界或扩大工具授权；旧角色覆盖中的本机工具配置也必须与可同步角色内容分开处理。

远程渠道现有隔离、记忆有效性/遗忘、prompt 预算和删除过滤继续约束结果。移除 `projects` 工具/全局连接器对项目语义内容的重复开关；如未来加入“修改项目”的真实工具，其授权独立存在。

界面可提供“本次上下文来源”摘要：所属项目、上下文开关、选用资料、角色覆盖、实际工作目录与缺失原因。UI 的 selectedProjectId 仅用于导航；项目详情投影和聊天执行投影分别命名。

## 5. 创建、移动与删除规则

| 操作 | 建议规则 |
| --- | --- |
| 新建聊天 | 普通入口显式传 projectId:null，项目入口显式传 id；拒绝未知/已删除项目，归档项目沿用明确恢复流程。兼容期旧客户端省略参数统一视为无项目，并记录诊断；新客户端必须发送字段 |
| 创建任务 | 有来源聊天时从该聊天继承，显式 projectId 与聊天不一致则报错；没有聊天的任务允许显式项目/null，不能为了移除默认值破坏独立任务入口 |
| 生成审批/启动运行 | 持久记录 chatId、projectId、home、workspaceId/规范路径、绑定修订、待执行动作及必要文件身份。执行前重新校验授权/文件身份；目标变化则让旧审批失效或要求针对新目标审批，绝不能重新解析 UI 选择后执行 |
| 移动聊天 | 原子更新归属与修订；当前运行阻止移动。待审批/已准备任务的旧上下文失效；已完成运行保留当时项目/目录快照；未执行任务的后续归属按明确关联规则更新，重新准备执行 |
| 移动项目记忆 | 只询问该聊天来源的有效项目范围记忆是否迁移，不迁走旧项目其他聊天的事实。默认保留旧项目；用户选择迁移时记录迁移决定与修订。edited/forgotten/invalidated 记录不被后台 reconcile 或旧手机覆盖、复活 |
| 移动资料/图片 | 聊天自身资料和图片引用保持可读；旧项目选用资料不隐式赠送给新项目；新项目上下文按统一入口生效。原件物理位置与 assetId 不变，避免路径变化导致预览失效 |
| 归档项目 | 保留资料与历史；新建/执行可用性明确显示，保持与现有“恢复后新建”语义兼容，不把归档当删除 |
| 删除项目 | 默认解除聊天归属并保留对话、图片和资料；同时删除聊天应是明确的另一种用户操作。项目范围记忆隔离并保留可恢复记录；角色覆盖先停用，物理文件经备份和安全清理阶段处理；用户外部文件夹永不级联递归删除 |

项目删除跨 state、记忆库、角色文件、资产引用与同步，无法用一次 JSON 写入天然保证全部原子。采用有修订的删除状态/操作日志，先使业务不可再创建引用，再通过幂等步骤处理解除归属、记忆隔离和派生清理；中断后可续做并提供结果。未完成步骤要可见，不返回虚假的“全部删除成功”。

同步 tombstone 必须纳入现有共享协议的因果合并与兼容策略。仅在本地加 deletedAt 不够：当前 project 序列化只保留白名单字段，旧端可能重新发送完整项目。支持混合版本期间，应明确能力协商/拒绝不支持的删除同步或延迟开放跨端删除；并测试旧设备离线回来与并发编辑，不通过丢弃旧端整个工作区解决冲突。

## 6. 与图片治理合并后的落地顺序

不把工作区行为变化归为普通“低风险字段修正”，也不承诺原分析中 1+2+2 天即可完成迁移验收。按以下可独立回滚节点推进；实际耗时以调用点盘点、数据样本和验证反馈估算。

| 阶段 | 范围 | 必要验收 |
| --- | --- | --- |
| **I0：图片预览修复** | 沿用图片计划 P0，基于已可信引用恢复访问；可先独立交付 | 过期/重启/换端口/历史预览与下载；不重生成；原件 SHA 一致；越界与跨 home 拒绝 |
| **R1：归属与工作区纠错** | 移除 UI 选择默认；合并开启项目对话请求；空目标/要求不造文本；默认工作区、远程分支和工具 process.cwd 回退一并收口 | null/undefined/无效 id；A 项目→主页与并发创建；无项目不执行到 APP_ROOT；未知旧目录先停止执行；已有授权不扩大；生成图片仍可用 |
| **R2：统一解析与可见性** | 先抽入口，再统一项目语义开关/调用者，分离本机授权与可同步内容；bootstrap 明确区分页面/聊天投影 | 同轮 prompt、记忆、角色与执行位置一致；关闭后所有项目语义旁路失效；远程受众隔离；切换/重试/后台不串上下文 |
| **I1：资产基线与存储** | 图片 P1/P2 与工作区登记对齐；资源台账、原件发布与恢复，不要求先完成整个项目模型迁移 | 覆盖已登记工作区；旧 generated 读兼容；换项目不改变资源身份；ENOSPC/崩溃恢复和备份 SHA 验证 |
| **R3：配置与协议迁移** | goal/角色覆盖收拢；资料选用与来源关系澄清；扩展已有共享 schema，不另造同步协议 | 版本化备份、幂等迁移、旧格式只读适配、明确双写期限/单一权威；before/after 资料可见性和 prompt 一致；旧新客户端往返和冲突测试 |
| **R4：生命周期** | 移动记忆选择、任务/审批失效规则、项目删除日志/tombstone/恢复 | A→B→无项目，运行/审批/后台索引竞态；离线旧端不复活删除项目；共享图片/资料不丢；每步故障后可重试 |
| **I2：容量和交付验收** | 图片 P3–P6 的缩略图、缓存、分页、队列与双端产品接入；项目/聊天/资产关联的大数据集 | 按像素/字节/并发测量峰值；清缓存不删原件/记忆；桌面原生、手机专项、完整发布 gate、保数据安装分别留证 |

图片 P0 可立即独立开展；自动原件回收必须等资产引用规则及 R4 生命周期稳定。缓存预算、压测规模和照片保存边界继续以图片计划为准。项目改造不能顺手修改生图质量、账号连接、视觉设计或其他线程的执行面板/语言 WIP。

旧占位文本的清理不能只按字符串全库替换：新建/空值停止补写；已有数据只对可证明系统生成的值迁移，无法确认来源时保留并提供编辑入口。备份恢复和回滚必须保留迁移后新产生的数据，不能简单把旧 state.json 覆盖回来。

## 7. 本轮交付与后续验证

- 本轮：逐项核对源码、明确八类问题中的现行差异、补充工作区/资产/审批/同步边界；检查本地文档链接和 diff。没有修改产品代码、读取或重写用户记忆库，没有运行产品 gate。
- 后续：为实际行为改动建立回归，不用“某文件是否出现 resolver 字符串”代替行为验证；记录预览修复与项目重构各自的通过/失败证据。
- 实施时按范围执行日常 gate、记忆/同步/工具/图片与 UI 专项；发布时运行完整 gate，再分别核对当前安装实例、原生交互和实体手机。源码通过不代表用户正在运行的实例已更新。
- 每阶段单独提交，只暂存本线程片段；更新 MELO_OVERVIEW.md、短 PROGRESS.md 与进度快照。本文中的推荐行为尚未实施。
