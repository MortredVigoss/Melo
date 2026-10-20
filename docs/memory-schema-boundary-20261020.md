# Memory Schema 职责拆分（GitHub #12）

只抽取 memory/store 内的 SQLite schema 与旧库迁移职责，现有公开 API、连接所有权、事务、向量更新与后台任务均留在原模块。初始化函数接收调用方已打开的 database 与 vecLoaded；不读取 home、不创建连接、不接管关闭。cached 与 captured-path 两条路径调用同一实现。

第一提交逐字节复制原函数（含注释、SQL、迁移与错误处理），仅增加已有依赖的 import 和内部 export；原入口暂不改。随后用真实临时 SQLite 覆盖旧 cache 迁移、孤立命中清理、cascade、request 去重、二次打开与缺失 vec0。第三步删除原函数并接 import。公开 API 保持；不重造统一出口，不改循环策略。

验收：源函数逐字节相同；新/旧 schema 行为、持久化、失败处理与幂等性；既有跨 home、调度时绑定、并发事务、取消/恢复与冷加载回归；完整日常和跨平台 CI。仅隔离数据库，不改用户数据库，不安装应用。

实施证据：移植提交 `39bd465`，函数/JSDoc/SQL 均与 `89dc1af` 原位代码逐字相同。新模块只导出内部初始化函数；原 store 公开 export 名称、连接生命周期与调用顺序不变。真实 SQLite 专项 4/4，包括旧缓存保留二进制、命中孤儿清理/级联、request 去重、向量不可用/旧索引保留、跨 handle 与重复重开。

接线后 `memory-schema-daily.log` 完整日常 **4335/4335 JS、35/35 Swift**，生成检查、浏览器与共享 Core 全过（149.7 秒，零 JS 跳过）。包含 cached/captured-path 冷锁、后台 home 绑定、嵌套回滚、取消与恢复既有回归。GitHub 跨平台 CI 待运行；未改数据库内容格式或安装应用。

跨平台回执：`e64bfe6` 的 [CI 39377921633](https://github.com/MortredVigoss/Melo/actions/runs/39377921633) Linux Node/HTTP/Browser 与 macOS Swift/shared rendering 全部通过。按 #11 → #12 顺序发布；不合并 Android 分支或把模拟器结果当作实体设备验收。
