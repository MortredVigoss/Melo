# Android Todo、Calendar 与 Reminder Engine 设计

日期：2026-10-26（Australia/Sydney）。状态：用户于 2026-10-26 回复“可以”，整体设计已认可，0.10.0 已实施；验证与未完成项见 [实施回执](../android-organizer-implementation-20261026.md)。
基线：主线 `248364b`；当前分支 `codex/android-organizer-20261026`。旧 Android 功能分支 `codex/phone-workflow-tools-20261021` 保留至 `1be64ad`，没有合并或覆盖其中的 Workflow / Progress 修复。

## 已确认的需求

- Todo 和 Calendar 各有独立侧边页面；Fold6 内外屏都能访问，旋转/折叠不丢编辑草稿。
- 默认通知、声音和振动；每条事项可选择闹钟式强提醒，提供稍后提醒与关闭/完成操作。
- Calendar 以 Melo 自建日历为基础，增加系统 Calendar Provider 和 ICS 订阅；统一 Provider 接口供以后直接登录 Google / Microsoft 等服务。
- 系统日历能显示哪些 Samsung / Google / Outlook / Exchange 日程取决于账号是否实际写入 Android Calendar Provider，不能保证安装对应 App 即可读取。
- 此次不接 Google / Microsoft 独立 OAuth 或 Exchange 服务器认证；用户已选择先系统日历 + ICS。

## 方案选择

推荐 A：共用 Organizer 数据契约和业务规则 + Android Provider / Alarm Adapter。这样 Chat、Todo 页面和 Calendar 页面访问同一份数据，系统提醒不依赖模型或截图操作；以后其他客户端可实现同一 Provider 接口。

B：全部放进系统日历。可借助系统同步，但 Todo 状态、ICS 本地缓存和提醒策略会被系统日历模型限制，不能完整满足两页的独立管理。

C：两页分别维护提醒和数据。实现入口较快，但编辑/删除/通知动作容易出现不同状态，不符合既有共享 Core 方向。

## 架构与边界

```text
Chat Tool Calls ─┐
Todo Page ───────┼─> Organizer Commands / Queries（共用契约、校验、Tool Schema、Effect）
Calendar Page ──┘                  |
                      Android Organizer Repository
                       |           |             |
                  Melo Records  Calendar Provider  ICS Provider
                       |
                  Reminder Engine -> AlarmManager -> Notification / Alarm UI
```

Organizer 与当前 Agent 执行 Tasks、Device Script Cache 是不同领域，使用独立稳定 ID，不把一次 Agent Run 当作待办或日程。

- 便携业务规则、Tool Schema / Effect、日期和提醒记录契约放在共享边界；Kotlin 负责持久化、系统权限、Calendar Provider、ICS 网络/解析及 AlarmManager。
- 使用独立的、带版本号的 Organizer 存储，避免改写现有聊天 JSON 文档；写入事务完成后由 Scheduler 做可重复的 reconcile。计划不是“存储和 Android AlarmManager 原子提交”，进程在两者之间退出时必须在启动/恢复时修复。
- UI 与 Tool 共用 Repository，不创建独立 Todo Agent 或新的嵌套 Loop。仅向真实已实现且授权的 Host 注册 Tools；普通本地功能不依赖 Accessibility。
- 第一版 Organizer 数据仅在此设备持久化；不冒称已加入既有跨端 Sync，也不自动将其他端未知的新记录写入旧同步协议。未来同步可通过稳定 ID / revision 接入。

## Todo 页面

- Today / Upcoming / All / Completed 视图；搜索、创建、编辑、完成/重新打开、删除。
- 标题、备注、可选到期时间、提醒时间、普通/强提醒；无日期 Todo 也可以保存，不自动创建无意义的 Alarm。
- 页面显示实际提醒状态：已排程、权限缺失、通知被关闭、已提醒、稍后提醒、已完成。完成或删除时取消关联 Alarm，编辑后使旧 revision 的 Alarm 失效。
- 第一版手工 Todo 为一次性事项；重复提醒由 Calendar 的重复日程承载，不把“完成今天”混同于“完成整个重复系列”。

## Calendar 页面与 Provider

- 月历 + 选中日 Agenda；来源筛选、日期跳转；新建、编辑、删除 Melo 日程。日程含标题、备注、地点、开始/结束、全天、IANA 时区与提醒设置。
- Melo 自建日程支持一次性、每天、每周、每月；明确结束条件。涉及重复日程时第一版编辑整个系列，入口清楚标示，不默默改动单个 occurrence 或整个系列。
- SystemCalendarProvider 经 READ_CALENDAR 读取用户选中的系统日历与已展开 Instances，不请求 WRITE_CALENDAR；显示来源和只读标记，修改通过系统日历编辑入口由用户完成。
- ICS Subscription Provider 支持 HTTPS / webcal 链接（webcal 规范化为 HTTPS）、来源名称、颜色、开关、刷新与移除。链接可能包含私密 token，放本机加密存储，Trace / 日志中只保留脱敏来源 ID。
- 使用成熟 ICS 解析器处理 UID、DTSTART / DTEND、TZID、全天日期、RRULE / EXDATE / RECURRENCE-ID 和取消记录；不自己用正则实现 recurrence。对不支持/损坏的条目显示来源错误，不默默生成错误提醒。
- 外部来源只读，移除订阅仅删除本地副本；不取消远端事件。系统与 ICS 的提醒默认关闭，用户可为选中的来源/事件启用 Melo 提醒，避免和系统重复响铃。
- 前台手动刷新；后台 WorkManager 定期刷新，使用 ETag / Last-Modified、大小/超时限制和安全 URL 校验。刷新失败保留最后成功数据并显示更新时间；不保证外部服务变化立即到达。展开窗口有界（当前查询区间与未来 90 天提醒窗口），分页/截断可见，不扫描无限重复系列。
- 日期以时区与 local-date 语义保存：全天事件不能通过 UTC midnight 直接换算；时区变化重新计算，覆盖 DST 跳时/重复时刻与月末重复。

## Reminder Engine 与强提醒

- Reminder 是独立记录，包含 owner kind/id、occurrence key、scheduled instant、revision、mode、delivery 状态及 snoozeUntil。稳定 PendingIntent 身份与持久化 revision 防止编辑/删除后旧 Alarm 继续弹出。
- 到期触发不用网络、不请求 LLM；通知点击回到对应事项。Todo 的“完成”才改变完成状态；“关闭提醒”不等于完成 Todo。Calendar 关闭提醒也不删除日程。
- 普通提醒使用用户可管理的 Notification Channel，声音/振动遵从实际 Channel 和系统设置。强提醒使用 AlarmManager 的用户授权精准调度与 Alarm 用途音频，带显式停止和 5/10 分钟 Snooze；设置有限响铃时长，避免无人处理永久响铃。
- Notification Permission、Exact Alarm Permission、Full Screen Intent Permission 和当前 Channel 状态分别检查；只有获得权限才显示对应能力已启用。不以 ADB 静默授予权限作为正常产品流程，不绕过 DND。
- 不具备精准调度权限时明确显示提醒可能延后并提供系统设置入口；没有 Full Screen Intent 权限时保留可点击的高优先级通知，不宣称必然覆盖锁屏。
- BOOT_COMPLETED、时间/时区变更、升级与权限重新授权后 reconcile；已过期事项标记 missed 并给出补看入口，不在重启时把所有旧提醒连续响一遍。Android 强制停止、设备关机及用户阻断权限时不能保证送达，页面诚实显示边界。
- 计划提醒 / 已收到 Receiver / 已发布通知 / 用户确认分别记录；不能把“成功保存 Alarm”算成“用户已被提醒”。

## Chat Tools 与真实执行证据

- 共享目录提供 `todo_list/create/update/complete/delete` 与 `calendar_list_events/create_event/update_event/delete_event` 的一致 Schema；Provider 支持与授权决定是否可用，名称最终遵守现有契约避免同名不同义。
- 现有 `calendar_list_events` 继续表示读取日历，新增写入操作必须声明 effect=write；读取声明 effect=read。创建回执包含真实记录 ID 和提醒排程状态，权限缺失不能返回“强提醒已启用”。
- 本地待办创建/编辑可由用户直接明确请求授权；不通过手机截图点击设置来代替原生 API。需要 OS 权限时返回明确状态和 UI 入口，不让模型无限重试。
- 查询日期带明确时区、范围和来源；写入来源必须为 Melo。系统 / ICS 只读，不能静默把更新请求写到不相干的 Melo 副本。
- Chat 主循环每次请求持续提供可用且获授权的 Tools，候选结束使用现有 Goal Check；不为这两个页面再写一套关键词匹配执行流程。

## 页面与适配

- 沿用当前黑金 Compose 组件与文字风格，Todo / Calendar 各自独立文件模块，不继续扩大 MainActivity。
- 展开屏使用可滚动 NavigationRail，加入两个独立目的地；折叠窄屏通过 Drawer 提供同一目的地集合，并保留原五项底栏快捷入口，避免把七个入口挤进底栏。系统返回、旋转和折叠时保留当前页面、选中日期与未保存编辑。
- 提醒权限与来源设置留在两个页面的对应设置入口；不把实现术语放到创建事项的主流程。

## 实施顺序和验收

1. 先完成主线 Loop 核查，列明旧 Android 修复未合入的边界；不将 pull 误当作修复已装机。
2. 共用 Organizer 契约、纯业务测试与 Android 持久化；旧 AppData / 凭证 / DeviceScript 数据保持不变。
3. Todo / Calendar 页面、System / ICS Provider 和 Chat Tool Adapter。
4. Reminder Engine、系统权限、通知动作与重启恢复。
5. 按仓库 test:plan 的完整改动范围检查；批次集成 gate、JVM / Compose instrumentation / lint / Debug / R8；旧 Android 流程保持回归。
6. Fold6 实机验收两种姿态下创建/编辑/删除、普通/强提醒、锁屏和后台、Snooze、系统权限拒绝与撤销。仅用明确命名的测试事项，不改个人已有日程。

重点负例：重复 Tool Call 不重复建事项；删除后的迟到 Receiver 零弹窗；过期 revision 无响铃；通知关闭时不显示成功送达；ICS 刷新失败/取消事件/同 UID 更新；DST 和全天时间不偏一天；重启不爆发旧提醒；折叠变化不丢草稿。

## 官方参考

- [Android alarms](https://developer.android.com/develop/background-work/services/alarms)
- [Calendar Provider](https://developer.android.com/identity/providers/calendar-provider)
- [Full Screen Intent limits](https://source.android.com/docs/core/permissions/fsi-limits)

## 审阅边界

用户已确认提醒形式与多来源接入 A；整体设计已获用户认可，按下述阶段实施并逐项保留验收边界；尚未安装新 APK。
