# 剩余审计修复实施 · 2026-10-26

按用户给定的 0 → 1 → 2 → 3 → 4 → 5 顺序执行；每批独立本地分支，快速档按全部改动路径，合并前集成档一次。架构批次 6 先独立设计。语言使用 C 混合方案。H5 集成端点与 H20 TODO 本轮保留。

## 批次 0：规则与 CI 门禁

基准 `cce1e64`，分支 `codex/audit-0-20261026`。无产品运行时修改。

| 规则 | 校准前 | 校准后 | 原因 |
| --- | --- | --- | --- |
| H1 | 22 | 8 | 状态 / CLI / 后端名称逐 token 排除；只对 H1 排除 iOS 自检 |
| H3 | 17 | 13 | 排除发布测试端口；原生壳仅允许唯一数值回退定义，重复初始化仍报 |
| H18 | 56 | 38 | 主题定义文件排除，使用处仍扫描 |
| H19 | 34 | 18 | 扫描回退、参数默认、变量初始化；不扫描选项和语言映射 |

`--baseline` 仍输出可读增量；加 `--check --out .tmp/audit` 作为门禁，任何新增出现都失败。同一违规行复制一次也会失败，关闭旧命中不能抵消新增。CI 独立 audit job 无需安装依赖，先比本分支基线，再比 PR merge-base / push 前版本；防止同 PR 抬高基线放行。手动 CI 比仓库当前基线；PR / push 缺有效基准失败。生成物和差异保留为 CI artifact。

自测 6/6：允许名单边界、同一行状态与真实模型共存、默认与选项区分、同数换项、重复行、PR 基线抬高及缺历史均覆盖。扫描全部规则 +0，L5/L15/L16 仍 open。规则计数减少不等于行为问题已修复。

快速档（完整校准）与集成档 `npm test -- --base cce1e64` 均通过：JS 4629/4629、两组设置浏览器、37 Swift 套件，均无跳过 / 隔离复测。快速档约 150 秒，集成档约 151 秒。CI 最后补充了跨日期选择基线：本分支和目标版本分别选最新 inventory，夹具及集成档通过。仅更新审计 JSON 选脚本测试组（选测 17/17），未将基线变更当文档忽略。证据 `.tmp/audit-batch-0/`；快速档 `.tmp/test-runs/run-JWqJlz/summary.json`，集成档 `.tmp/test-runs/run-Mj6VhH/summary.json`。

## 批次 1：完成判断、记忆纠正与预算提示

基准 `bf828fa`，分支 `codex/audit-1-20261026`。L5/L15/L16 探针均 closed、规则新增 0。

- L5：词命中比例至少 0.5，或来源在正文 / citations 中出现；仍要求真实执行成功、可读取正文至少 40 字符、非 snippet。指定 URL 必须匹配，不可用其他网页代替。Node / iOS Host 均传递引用。回执仍为 supported，不声称独立核实事实。
- L16：保留抽取 subjectKey；任意主题同说话者新值覆盖旧值。不同主题 / 不同说话者保持，缺主题不凭关键词猜覆盖。旧 ES 例子显式提供主题键，新增保修期主题及无键共存反例。
- L15：budget.replyTemplate 与原因格式共用五语契约；共享 Core、Node 和 iOS 同步，iOS 通过同一 budget operation 渲染。20 个语言 × 限额夹具跨 Node VM / JavaScriptCore，未知语言英文回退。业务请求使用现有 config.replyLanguage；界面语言传输在批次 2 完成。
- J5 / J6：当前源码已经修复，`src/services/chat/promptPipeline.test.js` 的真实 runner 同时断言 Agent 固定模型用于核验、工具后最终回答流式、目标检查不流式。重新运行通过，避免重复改逻辑或重复测试。

新增回归先红（L5 无 URL、L16 未知主题），修复后最终专项 245/245；四组 Swift 专项通过，132 个共享 conformance 夹具。真实回归补出了共享策略加载失败被误报为 token 预算的边界，现使用独立五语提示；五语实际 AgentLoop 均断言零模型调用。旧“读过且已引用仍失败”夹具按新约定调整，保留无关未引用、无正文与未执行的失败反例。

最终快速档 `.tmp/test-runs/run-5yhv0C/summary.json`、集成档 `.tmp/test-runs/run-6Kx5nu/summary.json` 均 GREEN：JS 4660/4660、两组浏览器、37 Swift、Android JVM/Lint/Debug/Release，0 跳过、0 隔离复测。首次缺 Java 环境、旧夹具失败及共享策略错误均保留日志；使用本机已有 Java 21 / Android SDK，无新增安装。Android instrumentation 新夹具仅编译，未跑模拟器。证据 `.tmp/audit-batch-1/`。

## 批次 2：语言与事件

基准 `c37b0f8`，分支 `codex/audit-2-20261026`。C 混合：共享 runtimeMessages 管执行事件 ID/参数；serverText 管服务端错误/回复。请求头在边界捕获语言，异步请求上下文隔离；Agent → 最近用户消息 → 渠道 → 界面。iOS 读取正确的已保存偏好键，缺省跟随系统，已存选择保留。

H2 的五个文件仅是来源相关性分词、检索词权重与频道昵称边界，加入分词允许名单；voiceRewrite 的 @昵称使用 Unicode 字母/数字，TTS 统一 detector。规则 H2/H7/H8/H9/H19 = 0，新增命中 0。分词例外有边界测试，仍拒绝散落的语言猜测。


附件续问继承最近用户消息语言；Agent 固定语言优先，团队并发成员的请求上下文与错误提示互不串语言。桌面请求头实际被 HTTP 错误入口消费。执行事件发 ID/参数，持久化场景另带英文兼容文本，冻结的 v1 同步剥离扩展字段后仍可读，桌面可按新语言重新渲染；用户补充、模型正文、成员姓名不作为翻译键。

英文浏览器实测执行详情无中文，预算数值、字符计数与未知用量均保留，五语切换、草稿保留和重启恢复用例通过。截图 `.tmp/language-20261015/execution-english.png` 已目检。Swift 语言专项通过，包含附件续问、固定 Agent 与界面回退；完整 iOS Release / iphoneos 未签名构建通过（`.tmp/audit-batch-2/ios-build.log`），涵盖 UIKit / SwiftUI 页面；没有安装或真机体验验收。

首次快速档暴露 57 项失败：主要为旧测试依赖隐式中文，现明确设置夹具语言，原有断言保留；其中预算事件遗漏 used/limit 是实际回归，补回参数并保留原数字断言。最终专项 56/56、Swift 专项两组通过。最终快速档 `.tmp/test-runs/run-ZgBFZ6/summary.json`、集成档 `.tmp/test-runs/run-HOgEbi/summary.json` 均 GREEN：JS 4668/4668、两组浏览器、37 Swift、Android JVM/Lint/Debug/Release，0 跳过、0 隔离复测。完整日志 `.tmp/audit-batch-2/`，失败日志也保留。


## 批次 3：配置

基准 `02213c0`，分支 `codex/audit-3-20261026`。实际剩余 H1 是显示名、旧目录迁移快照与冒烟夹具，不是五个 Whisper 模型默认值；转写原本已读 providerDefaults.media.transcription。显示名和旧目录快照现共用目录，保留用户定制模型和迁移匹配规则。H1/H3/H4 = 0，其他规则新增 0。

地址 / 端口集中 localServices，原生壳只有一个启动回退。示例路径使用用户 Documents；桌宠素材导入必须 MELO_PET_SOURCE_DIR 或 --from，缺失在任何写入前失败，已存在资产与 lock 不变。七项行为开关及编辑保存取消已经存在，复用 config.behavior，不引入重复 advanced 键；补齐 docs/env-flags.md 和生产布尔变量完整性检查。专项 18/18，原生桌面壳编译通过（保留已有定位 API deprecation 警告，无编译错误）。首次快速档抓到 customize 新依赖的浏览器绝对路径不能由 Node 解析；修正为双环境相对引用并登记受限静态路由，专项 8/8。最终快速档 `.tmp/test-runs/run-rDYbH7/summary.json`、集成档 `.tmp/test-runs/run-6NFolE/summary.json` 均 GREEN：JS 4670/4670、两组浏览器、37 Swift、Android 四项，0 跳过/复测。设置浏览器实际检查环境覆盖锁定、保存失败保留草稿、重试、取消与重新加载持久化。证据 `.tmp/audit-batch-3/`；没有安装或调用真实付费供应商。

## 批次 4：桌面 UI 与双端词条

基准 `58158dd`，分支 `codex/audit-4-20261026`。通知统一 notify，错误条持续到关闭/成功并隔离页面；创建与动作表单复用 EditSession，错误上抛保留草稿，取消和请求确认保留真实语义。三种标题层级、四种普通操作按钮视觉变体；神经节点/选择卡片保留组件命中区，行为与布局 hooks 不算新的视觉设计。固定样式、单一转义和场景色同源后 H10/H13/H15=0，H14=5（hidden / reduced-motion）。

真实浏览器和截图复查发现并修正导航节点多余边框、窄屏语言菜单层级、展开详情挤窄输入、发送按钮超出窗口、通知覆盖标题。场景按实际输入控件高度限高并内部滚动，保留可见对话。新增实际创建取消重开/503 失败草稿/重试/Enter、尺寸与无遮挡断言。五语、阅读密度、执行详情/滚动、设置交互均通过。

U6 词条同步提前覆盖手机，个人资料、数据文件和会话令牌不误改成知识。此前手机门禁跳过全部插值，本批补齐 26 条五语格式并加入解析检查。H18 的 32 处是 SwiftUI 原生支持的插值或应原样显示的用户/模型文本，不转换为动态翻译键；规则保留固定 verbatim 文案与字体/颜色检测，实际字体 6 处留批次 5。专项 guard 10/10、文案与浏览器组合 15/15、场景尺寸 4/4。

首次检查中的旧文案断言、data-URL 装载器、缺词条和过期 scene manifest 失败已保留并修正，没有删除断言或跳过。最终快速档 `.tmp/test-runs/run-buMgfk/summary.json` 与集成档 `.tmp/test-runs/run-0v2rP6/summary.json` 均 GREEN：4677 JS、设置浏览器、37 Swift、Android JVM/Lint/Debug/Release，0 跳过/隔离复测。证据 `.tmp/audit-batch-4/`；截图 `.tmp/language-20261015/`、`.tmp/chat-density-20261014/`。Codex 界面读取被工具拒绝，未绕过；按 Melo 现行黑金/紧凑 token 实施。扫描在工作树生成，inventory.commit 是生成时 HEAD，修复归属以本批提交为准。无安装/推送。

## 后续批次

5. iOS：主题 token、本地化及双端术语检测。
6. 架构：J2 / J3 / J6 / J8 独立方案，随后按依赖验收。
