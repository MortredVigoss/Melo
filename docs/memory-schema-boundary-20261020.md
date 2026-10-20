# Memory Schema 职责拆分（GitHub #12）

只抽取 memory/store 内的 SQLite schema 与旧库迁移职责，现有公开 API、连接所有权、事务、向量更新与后台任务均留在原模块。初始化函数接收调用方已打开的 database 与 vecLoaded；不读取 home、不创建连接、不接管关闭。cached 与 captured-path 两条路径调用同一实现。

第一提交逐字节复制原函数（含注释、SQL、迁移与错误处理），仅增加已有依赖的 import 和内部 export；原入口暂不改。随后用真实临时 SQLite 覆盖旧 cache 迁移、孤立命中清理、cascade、request 去重、二次打开与缺失 vec0。第三步删除原函数并接 import。公开 API 保持；不重造统一出口，不改循环策略。

验收：源函数逐字节相同；新/旧 schema 行为、持久化、失败处理与幂等性；既有跨 home、调度时绑定、并发事务、取消/恢复与冷加载回归；完整日常和跨平台 CI。仅隔离数据库，不改用户数据库，不安装应用。
