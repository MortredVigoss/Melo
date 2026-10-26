# 环境开关目录

运行行为优先在「定制 → 高级 → 运行行为」修改，已有配置键是 `config.behavior`；保留该名称，避免把旧配置迁移成第二套 `advanced` 开关。完整保存 / 取消 / 环境覆盖规则见[本机运行配置](runtime-configuration.md)。变量必须在操作入口捕获，异步阶段使用快照；不能通过写 process.env 切换用户配置。

## 用户行为开关

| 设置 | 环境覆盖 | 默认 |
| --- | --- | --- |
| 浏览器操作 | MELO_CDP_ENABLED | false，仍经过 Agent 能力授权 |
| 工具历史 | MELO_TOOL_CHAIN_HISTORY | false |
| 系统提示中的本轮上下文 | MELO_TURN_CONTEXT_IN_SYSTEM | false |
| 离线记忆 | MELO_OFFLINE_ONLY | false，不改变聊天服务连接 |
| 附件提取 | MELO_DISABLE_MEDIA | false；对应 mediaExtraction=true |
| 外部网页读取 | MELO_DISABLE_EXTERNAL_WEB_READERS | false；对应 externalWebReaders=true |
| 工具记录 | MELO_TOOL_TRACE_ALWAYS | false |

以上接受 1/0 或 true/false（大小写不敏感），无效 / 空值使用已保存值。界面显示有效值、覆盖来源和锁定状态。允许浏览器工具不等于授权执行，原有审批继续有效。

## 诊断开关

以下均以 `1` 启用，其他值关闭，除特别说明。它们不进入普通用户设置；日志可能包含任务正文，排障后关闭。

| 变量 | 消费范围 |
| --- | --- |
| MELO_PROMPT_DEBUG | 聊天 runner 提示诊断 |
| MELO_VERIFY_DEBUG | 完成核验诊断 |
| MELO_DEBUG_VISION | 图片输入诊断 |
| MELO_GRAPH_DEBUG | 执行图状态 |
| MELO_SEARCH_TRAIL_LOG | 搜索与读取轨迹 |
| MELO_PERF_LOG | 当前 home 的耗时日志 |
| MELO_DEBUG_MEMORY | 记忆快照诊断 |
| MELO_TG_DEBUG | Telegram 轮询诊断；渠道仍归档 |
| MELO_DC_DEBUG | Discord 轮询诊断 |
| MELO_DC_VOICE_DEBUG | Discord 语音会话诊断 |
| MELO_DEBUG | 特例：逗号分隔 scope 或 `*`，不是布尔值 |

## 兼容与隔离测试

| 变量 | 语义 |
| --- | --- |
| MELO_FUNCTION_CALLING | auto/native/legacy，兼容布尔别名；不绕过模型能力和权限 |
| MELO_CHAT_TOOLS | 旧 opt-in，不覆盖显式 legacy |
| MELO_MEMORY_TIERS_RECALL | 1 开启 / 0 关闭 / 空值根据已有分层数据自动启用；不把自动模式改成永久关闭 |
| MELO_OFFLINE_DISABLE_LLM | 1 禁止离线压缩器调用本机 LLM；排障用途，保留原后备压缩逻辑 |
| MELO_TEST_MODE | 1 启用隔离测试行为，不用于真实用户启动 |
| MELO_FIXTURE_IGNORE_TERM | 1 让专用生命周期夹具忽略正常退出信号 |
| MELO_SKIP_NATIVE_LAUNCH | 1 仅在红绿灯脚本跳过原生启动；报告必须注明，不能当成原生验收 |

`MELO_CLASSIFIER_MODEL` 对应旧 extraFast 已下线，没有生产消费者。接口地址、路径、密钥和数值限额不属于布尔开关；见运行配置和对应功能文档。素材导入的 `MELO_PET_SOURCE_DIR` 必须显式设置或使用 `--from`，与桌宠打包代码来源 `MELO_PET_SOURCE` 不同。
