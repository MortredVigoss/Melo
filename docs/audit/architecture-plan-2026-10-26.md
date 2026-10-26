# 架构后续批次 · 2026-10-26

本轮先交付行为、语言、配置与界面修复。以下按用户要求单独设计；每项单独分支，保持现有账号、数据和 v1 同步协议。评分衡量兼容性、维护成本和可验证性，满分 5。

| 项目 | 建议与评分 | 独立交付边界 | 机器验收与回退 |
| --- | --- | --- | --- |
| J2 路由 / 不可用原因 | 5 个用户语义类别 + 独立 backend / executor / action / reason 字段，5/5。直接把全部字符串替换成 5 个值只有 2/5，会丢失浏览器、原生搜索与宿主执行器的区别 | 第一批定义共享枚举和旧值到新结构的无损投影；第二批切换 Node、iOS、Android 消费；最后移除旧写入，保留历史读取 | 所有旧路由逐条映射且权限决策不变；禁止联网 / 无工具 / 手机执行器 / 浏览器回退 / unavailable 理由夹具跨端一致；回退仅切换输出版本，不迁移或重写历史 |
| J3 搜索 evidence | 三类产出先在生产出口提供结构化 evidence，模型可读文本在边界派生，5/5。直接删除 searchTask 适配层 1/5：它仍服务生产投影和历史数据 | 列出每个工具输出、toolResultProjection、持久化和移动端读取；先双读单写新结构，再移除生产 legacy 写入；历史适配器单独保留至版本迁移完成 | 三类产出相同 fixture 得到相同标题 / URL / 来源 / 读取状态；snippet 不能变成完整读取证据；旧聊天重开、缺字段、部分成功、取消和失败均不丢原始结果；实际消费者清零后才删适配入口 |
| J6 工具后流式 | 复核已有实现，5/5，无需再次重写 | 当前 invokeModelNode 已为工具后的最终回答传递 onDelta；目标检查等中间推理缓冲 | promptPipeline 实际 runner 已覆盖固定核验模型、最终轮流式和中间轮非流式；本轮只清理陈旧注释并保留测试 |
| J8 app.js 拆分 | settings → tts → composer，三次逐字节移植，5/5；抽取同时改逻辑 2/5 | 每次先移植原函数，仅调整 import / export 与注入边界，独立 commit 明示 byte-for-byte port；公共 API 和 DOM 事件顺序保持。后续逻辑改善另一个 commit | 设置编辑 / 保存 / 取消和错误恢复；TTS 播放 / 停止 / 切换；输入 IME / 草稿 / 附件 / 两至四行增长 / 滚动。每次依赖地图更新、快速档和合并前集成档；出现行为差异可独立回退对应移植 |

顺序：J2 契约先行；J3 在兼容投影上独立推进；J8 等本轮 UI 接口稳定后拆分。J6 已有行为证据，不用重复造实现。J2/J3 改动必须同时检查手机契约和旧数据读取，不能只凭规则字符串变少验收。每个方案的首个实现批次再登记精确文件集、基准提交和新旧样例，不把本设计文档视为已经实现。

## 实际入口与拆分约束

- J2：`shared/agent/retrieval/searchRouter.js`、`shared/agent/retrieval/intentRouter.js` 与 `shared/agent/search.js`；新增 contract 前记录所有 route/reason 的输入条件。none/fetch/search/phone/unavailable 是类别，不用于替代执行器选择或授予权限。
- J3：`src/services/search/searchTask.js` 仍有生产用途；`src/services/chat/toolResultProjection.js` 是结构化证据存储入口。迁移 `src/tools/builtins/fetchUrlTool.js`、`src/services/search/socialLinkReader.js`、`src/tools/builtins/webSearchTool.js` 三类产出时必须同时验证 cancelled、partial、snippet-only 和历史读取；不能通过删适配层降低行数。
- J6：`src/services/chat/execution/invokeModelNode.js` 的 onDelta 传递和 `src/services/chat/promptPipeline.test.js` 是现有行为证据；清理旧注释不改变执行。
- J8：`desktop-ui/app.js` 的 settings、tts、composer 按既有 features context/api/controller/view 边界逐块移出。每次独立比对迁移正文，所有跨边界注入在 README 记录；失败草稿、IME 和 TTS 停止顺序是不可变行为。

这些是独立实施计划，J2/J3/J8 仍标为 open；本轮不把方案文档算成代码修复，也不改 H5 外部集成地址和 H20 TODO。

五类 route 的边界：它只描述检索类别；独立 action 必须保留网页读取、导航与交互区别。不能把显式 browser 请求一律降成 none/fetch 来凑数；映射不能无损表达时保留旧 browser 值，先扩展契约再迁移。UI 展示 action 与 executor，不把 route=none 解释为没有执行。
