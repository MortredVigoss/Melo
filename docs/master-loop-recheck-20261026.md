# 主线更新与 Loop 复核（2026-10-26）

## Git 与设备

用户要求 pull 最新 main；仓库默认分支实际为 master。已 fetch、将本地 master 从 5e1e3af fast-forward 到 248364b（76 个主线提交），再建立 codex/android-organizer-20261026。此前 Android 工作保留在 codex/phone-workflow-tools-20261021 的 1be64ad，未强制 reset、未混合合并、未 push。

Windows ADB 识别到 Fold6 SM-F956B、授权状态 device；只读 package 元数据表明仍安装 0.9.0/code22，SDK37。连接成功不等于安装了最新主线，也不等于完成 One UI 8.5 验收。本轮没有安装、清数据、操作个人日程或发起真实模型请求。

## 自上次 da86326 核查后的主线变化

- 1f0e57d：共享 goal.js 与结束前的无工具 Goal Check 接入桌面、iOS、Android；原始目标、证据 ID、有限纠偏与成功写入不重放。
- e05e65f：调整工具可见性与多步目标保留，将跨端意图规则迁到共享边界；取消 iOS 按关键词强制首步 Search。
- 6f10396 / 9ef3691 / 99d2fca / 5222034：Smart Routing、便携模型能力/运行配置、请求状态隔离与跨端界面行为修正。
- ccdcb04：快速/集成两档 gate、机器锁与紧凑 summary；f91fb09 / 248364b 记录桌面/iPhone 更新至 0.7.11(43)。这不是 Android 安装回执。

## 旧问题是否已修复

1. **Calendar 后过早询问地点**：主线已经有针对性修复。候选文字答案先交给 Goal Check，公开可查的缺口可回到工作 Loop，最多两次纠偏。读日历不再自动被当作未验证写入；但模型仍可能误判，不能承诺所有真实任务必然完成。
2. **任意搜过就表示天气已完成**：新的目标检查按 requirement 与实际 observation ID 评估，明确区分地点/日期/事实与中间来源；不再只靠 any-search。仍依赖模型对 evidence 内容的语义判断，不是独立事实 oracle。
3. **普通首轮强制 Search**：iOS 已改自动选择。Android/shared plan 保留 navigation 的额外 Research 约束与 plan.tools 路由；availableTools 会补上 Search / Fetch，不能据此声称“所有已授权 Tools 完全不受意图路由影响”。Android history reader 也仍只在 prepared.omitted 时实际加入 names。
4. **手机操作失败即退出**：仍存在。SharedChatAgent 的 phoneFailure 会阻止后续 sibling 并在 batch 后立即 finish，没有让 Goal Check 判断可恢复缺口。取消/明确拒绝应停止，但 recoverable failure 与它们还没有分开。
5. **重复截图 / 反复切换控制项**：主线没有合入旧分支 e5adda9 的 Android History / Progress 修复。DeviceContextBudget 仍按四次 call 压缩；DeviceProgress 仍把原始 JPEG 与瞬变 node 字段纳入 hash。这是源码确认的未合入，不能把所有循环故障都归为这一根因。
6. **Workflow Tool / Skill**：主线 COMMON_TOOLS 仍仅 read_history/web_search/fetch_url/phone_use，原分支 phone_workflow 等新增发布能力未合入。旧分支保留，后续整合需逐项移植到当前架构，不能整文件覆盖新 Goal Check / Smart Routing。

## 本轮验证

实际执行 `node --test shared/agent/goal.test.js shared/agent/completion.test.js src/services/chat/functionCalling.integration.test.js`：53/53，通过，无 skip。日志 `.tmp/master-goal-regression-20261026.log`。

其中真实生产 HTTP 传输 + 脚本 Provider 测试覆盖：日历一次 → 提前询问 → 无工具检查指出缺口 → 场馆搜索 → 天气搜索 → 回答 → 检查完成；5 次工作请求、2 次 Goal Check，calendar 不重复执行。另覆盖歧义/无效 JSON/伪造 Tool/两次纠偏上限/取消。它验证控制流，不验证真实供应商质量或原截图中的具体天气事实。

Android JVM 本轮实际通过 147 项，failures=0、errors=0、skipped=0；日志 `.tmp/master-android-jvm-20261026.log`。Swift / macOS / Fold6 真实多步任务本轮未执行。

## 新功能方向

用户确认 Todo / Calendar 独立页面，通知 + 可选闹钟强提醒；Calendar 先系统日历 + ICS，统一 Provider 接口。整体提案见 [设计稿](specs/2026-10-26-android-organizer-design.md)。新需求不意味着旧 Android 修复已经并入当前分支；两者的代码与验收边界继续分别记录。
