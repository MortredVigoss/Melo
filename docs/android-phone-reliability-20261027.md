# Android 执行可靠性与 UI-first 阶段（2026-10-27）

此阶段继续用户已授权的修复，不重新请求设计确认。0.10.2（26）；下一阶段仍须落实用户最新澄清：成功动作/子流程立即缓存，不等待整个任务成功。本阶段没有冒称已实现该粒度。

## 真实记录与边界

- “再次重试”的实际 registeredTools 缺少 phone_use，OS Accessibility 已绑定。此前只补“重试”词表不足；本次按当前权限/执行器持续注册 phone_use，与路由建议分离，保留显式禁止与未授予权限的限制。每条新用户消息仍送模型，Android 不因 PHONE_UNAVAILABLE 规划直接跳过模型。
- 最新整次任务约158秒，子设备任务约150秒、16次模型请求，设备步骤耗时合计23377ms。剩余包含模型等待与 Runtime 处理，不能全部归为网络延迟。曾成功打开/输入/搜索，前台随后变为 Melo，重回汽水后连续 stale_screen；没有原始逐步截图，不能声称已还原每次失败的具体画面。
- 只读定位时打开汽水音乐、关闭系统覆盖层后看到会员推广页，未点开通/支付。关闭 X 灰度采样范围约215–254，对比度39；旧条件对比度至少50、梯度大于24会拒绝它。Pillow 按当前缩放/JPEG路径抽样得到edges24=4、edges8=127；是当前实景的可复现误判，不把当前页面当成全部历史失败证据。
- 私人数据库、画面和安装备份仅在外层本机 work 目录；未提交通知、聊天、凭证或页面截图。

## 本阶段行为

1. Shared Core 将已授权 phone_use 持续列入 availableTools，路由只是建议；模型结合完整提供的对话处理任意追问，不继续扩展重试词表。注册不等于可接管屏幕：纯公开资料 Research 的手机执行仍被独立 actionEvidence 拒绝。Node wrapper 保留 unavailable 状态，避免新能力说明文本覆盖不可用提示。
2. Native observation 先返回 UI Tree。真实文字/编辑框/可定位控件可用时不默认附图；空容器/自绘内容自动截图，模型可 observe(include_screenshot=true) 请求部分树中缺少的视觉信息。保留截图禁用开关、密码节点排除和尺寸/姿态边界。
3. 普通任务坐标点击不逐步再批准；命中原生敏感控件的坐标仍解析实际节点并确认，不能改用坐标绕过 Send 等检查。节点身份、窗口/尺寸、screen_id、时效及锁屏检查保留。任务覆盖层仅在运行期间保持屏幕亮起，按电源键仍取消。
4. 树可定位的坐标使用同一原生节点身份校验；图形目标仍检查局部截图。低对比边缘改用相对梯度，保留平坦区域、目标替换/移动、JPEG噪声等正反例。未全局忽略 stale_screen。

## 旧缓存重新验证

手机七条旧脚本 environment 均为空；当前作用域涉及的两个因此不兼容。新增独立 revalidate 路径，仅限同 scope、已验证/启用、可唯一精确绑定原任务的旧脚本；已知布局/版本不兼容、歧义、空布局与hinge-pending不使用此路径。

ScriptRunner 仍逐步解析新节点并核验终态；执行期间固定初始环境。只有 visible_facts 成功、权限/归属与 revision 未变才回填环境。失败、姿态中途变化或用户编辑不能把旧脚本升级成可信。Native Fixture 已验证重新校验后下一次 exact 为0模型请求；不代表手机七条脚本已被全部迁移。

## 验收

- Core 215/215；JVM 164/164；最终 Native 63/63（DeviceAgent、DynamicAd、ResearchExecution、SharedSearch、ChatPhoneUse、Organizer、TaskCache）。包含低对比关闭按钮、目标替换零点击、敏感坐标拒绝/取消、树优先/显式截图、三协议非标准追问、拒绝未请求的屏幕 Research、旧缓存成功/失败/歧义/中途折叠等。
- 最终快速档 `.tmp/test-runs/run-o8pVE5/summary.json`：语法/生成器/共享渲染、Android JVM/Lint/Debug/Release通过；JS 4622中4605 pass、2 fail、15 skip、0 cancelled。两个fail仍缺失私人winter原始素材，没有删除/跳过用例。完整门禁不为GREEN。
- `.tmp/capabilities-final-checked-native.log` 是最终APK对应运行；`.tmp/dim-close-red.log` 为修复前低对比误判。未运行macOS Swift、未重跑已知失败的整套宠物Native测试；不据Fixture声称真实汽水完整搜索/播放成功。

## 尚未完成

成功动作/子流程的即时发布与模型可调用目录还需实施。现有 Recorder 仍在整任务 achieved 后编译，裸坐标仍不能转成稳定 selector；这个限制不能用旧缓存迁移来冒充解决。
