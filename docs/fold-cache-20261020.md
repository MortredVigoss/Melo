# Android 布局与版本缓存（GitHub #10）

缓存按既有 Agent / Project / display / instructions 所有者隔离，再按显示尺寸、旋转、密度、字体比例、hinge 姿态与脚本所用 App 版本匹配。姿态来自公开 Sensor.TYPE_HINGE_ANGLE（Android 30+）；无传感器明确记录 unavailable，有传感器但无读数时不自动命中。布局变体分别保存，语义 selector 保留，不保存 screen_id 或旧坐标。

自动匹配先只读取显示配置和限定包的版本，不截屏、不调用模型；未知版本或旧缓存缺少环境记录时不自动执行。手动旧脚本仍使用新 observation 定位；已有版本/姿态不匹配的脚本拒绝运行。执行前与每步重新检查环境；变化时停止，在可能已有写动作后不自动 Probe。窗口布局由每次 observation 的 bounds 校验，页面变化沿用 selector 与终态校验。

记录命中/失配原因、查找和回放/Probe 时间。相同布局与版本的 Exact Hit 仍零 LLM；不兼容布局可由受控 Probe 生成独立变体。保留原本权限确认、取消和有副作用后不得重放的规则。

验证：JVM 匹配/未知/版本变化/双变体；真实 Repository 的 emulator 回归覆盖内外布局各自命中、变化后零旧动作、版本失配、原恢复/取消；原生观察返回环境并在姿态改变后拒绝旧 screen_id。CI 不等于 Fold6 真机验收。官方接口参考：https://developer.android.com/reference/android/hardware/Sensor#TYPE_HINGE_ANGLE 。

首轮 CI 39378706877 在 Kotlin 编译阶段检出新增闭包赋值使 nullable recipe 无法 smart cast；在已判定非空的分支显式捕获 requireNotNull，保持执行行为。尚未通过构建，第二轮待验。
