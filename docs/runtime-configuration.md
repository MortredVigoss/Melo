# 本机运行配置

「定制 → 高级 → 运行行为」支持编辑、保存或取消，保存到当前 MELO_HOME 的 config.json。环境变量显式覆盖，界面显示来源并锁定控件。取消不写磁盘，保存失败保留草稿。账号密钥和 Agent 权限不属于这些开关。

| config.behavior 字段 | 环境覆盖 | 默认 | 范围 |
| --- | --- | --- | --- |
| browserControl | MELO_CDP_ENABLED | false | 提供浏览器操作工具，仍须 Agent 授权 |
| toolChainHistory | MELO_TOOL_CHAIN_HISTORY | false | 工具调用历史进入后续上下文 |
| turnContextInSystem | MELO_TURN_CONTEXT_IN_SYSTEM | false | 本轮上下文放入系统提示 |
| offlineMemory | MELO_OFFLINE_ONLY | false | 记忆提取、压缩、向量只使用本机服务；不改变聊天连接 |
| mediaExtraction | MELO_DISABLE_MEDIA（反向） | true | 提取附件内容 |
| externalWebReaders | MELO_DISABLE_EXTERNAL_WEB_READERS（反向） | true | 允许已配置的外部网页读取服务 |
| toolTrace | MELO_TOOL_TRACE_ALWAYS | false | 显示成功工具记录 |

覆盖接受 true/false、1/0，不区分大小写；空或无效值使用保存值。不会改写 process.env。每次操作在入口捕获环境与当前 home。旧 toolChainHistory=true 在没有新版值时保留。
工具协议使用 config.toolCalling：auto/native/legacy；MELO_FUNCTION_CALLING 支持这些名称或布尔别名。目录显式 tools=false 时不发送原生工具。MELO_CHAT_TOOLS 是旧 opt-in，不能推翻显式 legacy。两种协议都经过能力与用户限制检查。

## 服务、预算与安装

- 本机 LLM 地址保存于 localServices，默认集中于 src/shared/localServices.js；自定义声音为 customVoiceBaseUrl，界面依据服务身份/地址，不猜端口。向量集成可显式用 MELO_EMBED_PROVIDER、MELO_OLLAMA_URL、MELO_EMBED_HTTP_URL；构造时捕获请求配置，连接/凭据变化不复用旧实例。
- 搜索数量、正文预算、超时、缓存时限使用 operationalLimits.search 及现有搜索设置。共享循环、委派、工具保护在 shared/protocol/agent-loop.json；记忆算法默认值集中于 src/memory/limits.js。实时预算与入口选项优先，安全边界不开放无限执行。
- 后台 scheduler 通过构造参数注入间隔；纯算法、绘图坐标、协议容量不全部塞进设置页。Telegram 已归档，不重新开放其轮询设置。
- 桌面安装默认 ~/Applications/Melo.app，快捷入口为产品仓库父目录；MELO_DESKTOP_INSTALL_DIR、MELO_DESKTOP_SHORTCUT_DIR 可指定绝对目录。拒绝覆盖非 Melo 应用和源构建目录，保留账号数据。
- 桌宠源默认仓库内 desktop-pet，MELO_PET_SOURCE 可覆盖；不再引用开发者个人目录。

## 开发诊断

| 变量 | 用途 |
| --- | --- |
| MELO_TEST_MODE | 隔离测试，不能用于正常用户启动 |
| MELO_DEBUG | 逗号分隔 scope 或 * |
| MELO_PROMPT_DEBUG / MELO_VERIFY_DEBUG | 提示与核验诊断 |
| MELO_DEBUG_VISION / MELO_GRAPH_DEBUG | 图片输入与执行图 |
| MELO_SEARCH_TRAIL_LOG / MELO_PERF_LOG | 检索证据轨迹与性能 |
| MELO_TG_DEBUG / MELO_DC_DEBUG / MELO_DC_VOICE_DEBUG | 渠道诊断；Telegram 仍归档 |
| MELO_DEBUG_MEMORY | 记忆诊断 |

旧诊断入口仍用 1 启用，默认关闭，不放入用户设置页。日志可能含任务内容，调试后关闭。MELO_CLASSIFIER_MODEL 随旧 extraFast 下线，无生产消费者，不作为可用配置。
