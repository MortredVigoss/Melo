# iOS 语义修复与双端术语 · 2026-10-26

批次 4 已把词条改名、26 条缺失插值格式和目录门禁提前交付；SwiftUI 的插值不是绕过本地化，用户/模型原文继续 verbatim。批次 5 处理剩余 6 处真实字号命中（一个命中行包含多个控件），以及动态枚举/回退文案未翻译的问题。

| 桌面来源 | iOS 对应 | 验证 |
| --- | --- | --- |
| tokens.css 的语义字号和状态色 | sync-theme.py → MeloType / MeloTheme，验证码、头像比例、图像图标、页脚与成功提示 | 生成器一致、H18=0、完整 App 编译 |
| shared/protocol/interface-terms.json | InterfaceTerm 与两端 catalog 相同四个 concept ID；device 使用电脑/手机各自标签 | JS 词表守卫 + Foundation Swift 枚举/五语 Bundle 读取 |
| 桌面记忆范围、分类、状态及执行状态 | 本地化动态枚举值和来源占位；保留事实正文、Agent 名与未知原始值 | 词条覆盖/格式占位符守卫，旧内容不重写 |
| 已有五语界面偏好 | InterfaceCopy 从当前偏好/系统选择 Bundle；CapabilityCopy 复用该入口 | 五语言本地 fixture + 未知原文透传 |

实施顺序：共享词表与生成器 → iOS 语义 token / 动态文案 → 目录和场景重建 → 专项检查 → 快速档 → iPhoneOS 未签名编译 → 合并前集成档。实体设备视觉、真实权限弹窗和发布安装不在模拟测试证据范围。
