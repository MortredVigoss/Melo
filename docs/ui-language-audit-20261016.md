# Melo UI 设计语言一致性审计 · 2026-10-16

本轮按用户要求审计，不修改产品界面。依据是当前共享工作树（含已有 WIP）、`docs/ui-design-language.md` 和实际显示；不以旧截图或原始 CSS 声明直接判断最终效果。

结论：**主视觉已经统一，组件接入尚不完整。** 黑金深空、五区分色、主工作框架和常用卡片是一套语言；后加的菜单、管理弹窗和设置表单存在六类明确差异。优先修材质和文字语义，再统一控件与排版，无需重新设计神经场景。

## 范围与证据

- 原生 macOS Melo：实看当前首页并截图，服务 `http://127.0.0.1:43127/`。
- 同服务浏览器 1320 × 860：实看首页、模型菜单、项目与资料菜单、语言菜单、个人设置、Agent 管理、项目总览及新建表单、知识库及新增资料表单；读取最终 computed style，已关闭临时预览并恢复 viewport。
- 管理类对话框、图片预览/遮罩、执行面板：核对源码与样式覆盖，未触发真实删除、工具权限、模型调用或图片处理。
- iPhone：检查共享主题生成器、原生卡片、编辑器、项目资料与团队 sheet 的实现；**本轮未重装、未做模拟器或实体手机视觉验收**。不将桌面浏览器当作原生手机证明。
- 技能分支点击及项目卡片点击在本轮浏览器抽查中未呈现目标详情，因此不把它们记为已实看；导航原因未展开诊断，不据此认定功能故障。
- 未测 GPU/内存或帧时间，模糊半径差异是设计与渲染风险，不等于已经证明性能下降。本轮无产品代码修改，无需重跑完整发布 gate。

本机证据目录：`.tmp/ui-language-audit-20261016/`，含 `native-home.png`、`context-popover.png`、`model-popover.png`、`language-popover.png`、`settings.png`、`agent.png`、`projects.png`、`knowledge.png`、`knowledge-edit.png`、`computed-styles.json`、`source-snapshot.json`。证据含当前工作空间显示内容，仅保存在本机，未对外发布。

## 基准与已经一致的部分

| 维度 | 当前判断 | 依据 |
| --- | --- | --- |
| 品牌、深空、五模块身份色 | 基本统一 | 原生首页及共享 neural identity；五色是明确的产品决定 |
| 工作框架与普通业务卡片 | 基本统一 | `neuralGlass.css:38–58`；项目/知识/Agent 主卡片均实测 16px 圆角 |
| 基础文字、边缘、材料与圆角的双端来源 | 已统一来源 | `MeloTheme.swift` 由 `ios/scripts/sync-theme.py` 读取桌面 token 生成 |
| 浮层与对话框 | 接入不完整 | U1、U2 |
| 设置页排版与文字层级 | 部分分叉 | U3、U4 |
| 控件识别与文案 | 局部不统一 | U5、U6 |
| 手机 sheet 最终材质 | 待原生验证 | M1；不能只凭 token 一致判定视觉通过 |

保留既定基准：普通控件 / 卡片 / 主框架与对话框为 10 / 16 / 22px 圆角；普通按钮 36px，输入工具 40px；浮层局部模糊 4px，弹窗背景文字退暗、深空保留。密集表单和手机触控可有明确的尺寸变体，不要求两端机械地使用相同像素。

## 明确发现

这里的 P1 表示优先修复的视觉一致性问题，不表示崩溃或数据安全缺陷。

### U1 · P1 · 同级浮层出现三套材质（实见）

首页输入区的模型选择实测为暖黑渐变、alpha 0.82–0.90、4px 模糊、16px 圆角；“项目与资料”实测为 `rgba(15,18,23,.97)`、24px 模糊、16px 圆角。语言菜单另用 alpha 0.96、18px 模糊、13px 圆角。团队菜单复用项目资料菜单的样式。

结果：同级菜单有的透出深空，有的成为实心黑块；模糊和边缘厚度没有对应到明确的层级关系。

位置：`desktop-ui/styles.css:5926–5935`、`desktop-ui/language.css:6–8`，对照 `desktop-ui/neuralGlass.css:105–109`。图片选项已在 `neuralGlass.css:377–385` 接入共享浮层，不能误报为遗漏。

建议：让模型、团队、项目资料、语言、附件共用浮层材料与边缘；尺寸和锚点仍由各组件决定。以文字阅读所需的不透明度为下限，不能一律降低 alpha。

### U2 · P1 · 管理弹窗没有接入统一对话框层级（代码确认）

`managementDialog()` 使用 `.chat-file-dialog.management-dialog`，直接挂在 `document.body`。其背景引用不存在的 `--panel-bg` 后回退到不透明 `#18191b`，圆角 16px；遮罩为 `#0009`。统一弹窗则采用 `space-dialog`、22px 圆角，并只退暗背后的界面内容。

现有退暗规则仅匹配 `#app` 直接子级的 palette / permission backdrop，因此不能覆盖这类 body dialog。进入连接器、技能等管理窗口时，材料、背景处理和入场方式会切到另一套。

位置：`desktop-ui/managementActions.js:5–21`、`desktop-ui/styles.css:5949–5950`，对照 `desktop-ui/neuralGlass.css:110–115`。

建议：提供统一对话框外壳和全局弹层状态，继续保留 body 挂载以免轮询关闭草稿。普通编辑窗用共享 dialog 材料；删除/权限窗口可更实、更清晰，但沿用同一边缘、排版和按钮语义。

附带观察：图片预览与遮罩分别使用 12px / 10px 全屏背景模糊（`styles.css:1642–1644,5894–5895`）。媒体画布保持暗实底合理，不应为了透明而干扰看图；需要统一的是工具栏、窗口边缘及退出方式，并将媒体查看器记为显式例外。

### U3 · P2 · 个人设置与其他工作页不是同一套卡片/页头（实见）

系统个人设置实测：卡片 20px 圆角、24px 内距、自定义偏冷渐变；页标题 28px、页面内距 28 / 24 / 48px。知识和项目页使用共享 16px 卡片、26px 页标题；Agent 主卡片也使用共享材料。

这不是仅仅“差了几个像素”：设置页的大卡片更厚、更实，页头另加一层 eyebrow，视线起点与其他管理页不同。图见 `settings.png`、`agent.png`、`knowledge.png`。

位置：`desktop-ui/localSettings.css:1–7`，对照 `desktop-ui/neuralGlass.css:49–59`。

建议：统一管理页的标题、描述、工具栏及卡片骨架；个人资料需要大头像可保留布局差异。内嵌分组使用明确的 inset 变体，不再各页另写主卡片颜色和圆角。

### U4 · P2 · 未定义的颜色变量使辅助文字失去层级（实见）

实际根节点有 `--text`、`--text-muted`、`--text-soft`，没有 `--text-primary`、`--text-secondary`、`--panel-bg`。部分组件仍引用后面这组命名。

“项目与资料”中的说明段落和强调标题实测同为 `rgb(237,232,223)`：`var(--text-secondary)` 失效后继承正文色。个人设置则因 fallback 变成另一组 `#ded7c9 / #a6a49f`；保存状态又用 `#aaa69e`。因此相同语义的说明在不同页面忽明忽暗。

位置：`desktop-ui/neuralGlass.css:3–28`、`desktop-ui/styles.css:5926–5931`、`desktop-ui/localSettings.css:1–2`、`desktop-ui/settingsEdit.css:2,18`。证据见 `computed-styles.json` 的 `text-tokens`。

建议：收敛到一套 primary / muted / soft 语义，迁移时提供旧命名兼容别名；优先修无 fallback 的引用。成功、警告、失败单独设语义色，不强制涂成金色。

### U5 · P2 · Agent 切换控件缺少与其他选择器一致的识别线索（实见）

Agent 管理页右上角的选择器实测背景透明、圆角 0、无边框；源码还设置 `appearance:none`，没有补下拉箭头。画面中的 Agent 名称看起来像静态文字。首页模型与 Agent 选择均有边界或下拉提示，同样的“选择”动作使用了不同的交互语言。

位置：`desktop-ui/styles.css:1157–1166`、`desktop-ui/agentSettings.css:5,19`；证据 `agent.png`、`computed-styles.json`。

建议：统一 Select 的箭头、可点击边界、焦点和禁用态。紧凑输入 44px 与普通输入 54px 是源码已注明的密度变体，本轮不把高度差本身列为缺陷；应把它们正式记录为变体，圆角和文字语义仍共用 token。

### U6 · P3 · 同类操作文案混用中英文（实见）

中文界面中，新增知识资料底部是“保存资料 / Cancel”，新建项目则是“创建项目 / 取消”。这是操作文案漏接，和用户自己的英文内容、五区英文副标题不是同一回事。

位置：`desktop-ui/app.js:9929–9933`；证据 `knowledge-edit.png`。项目列表时间还显示 `2 days ago`，属于同类本地化残留。

建议：固定取消、关闭、完成、保存的使用场景并走同一翻译入口；用户内容、模型 ID 和品牌词保持原样。

## M1 · 手机端的材质覆盖风险（代码确认，视觉待验）

原生 `.meloPanel()` 已使用共享 card / edge / 16px radius，方向正确。但 `EditableDocument`、`ConversationContextPicker`、`TeamSheet` 内部使用 `Form`，目前仅给外层 sheet 设置 `presentationBackground(MeloTheme.dialog)`，没有显式隐藏 Form 的滚动底色或设定行材料。

位置：`ios/Melo/ContentView.swift:7–14`、`ios/Melo/EditableDocument.swift:20–50`、`ios/Melo/ConversationControls.swift:123–143`、`ios/Melo/TeamSheet.swift:20–68`。

风险：外层玻璃可能被系统 Form 的分组背景覆盖，导致同一 App 的卡片页与编辑 sheet 出现两种质感。**这项不能仅凭源码宣布手机实测失败**；需在目标 iOS 版本上打开资料、项目、团队三个 sheet 对比截图。保留原生键盘、Dynamic Type、触控尺寸、Picker、权限弹窗行为，只统一应用拥有的表面。

## 根因与修正顺序

文档仍说 `neuralGlass.css` 最后加载，但 `index.html:17–21` 后面还有 localSettings、language、settingsEdit、agentSettings；且很多新组件不在原有统一选择器列表里。新增页面各写一组数值，靠末尾覆盖很容易漏接。不能仅把样式表挪到最后：高优先级选择器、body dialog 和原生 Form 仍需显式接入。

1. **材料与文字**：修 U1、U2、U4，建立共享 Popover / Dialog 外壳与文字别名，让深空、阅读面、悬浮面层级一致。
2. **管理页与控件**：修 U3、U5、U6，复用页头、卡片、Select 和操作文案；不改功能层级，不重做神经网络。
3. **双端验收**：原生手机复核 M1；桌面在正常和窄窗口检查长内容、键盘焦点、空态、错误态与减少动态效果。媒体/权限窗口列明合理例外。
4. **防止回退**：更新设计规范为真实加载关系，扫描未定义 token，并对几类真实代表组件留样式检查与截图基线。不要用检查所有 CSS 数字都相等的测试取代设计判断。

本轮只记录审计报告及交接；没有更改产品代码、用户设置、模型连接、Agent、聊天或权限，没有运行 git pp 或推送。
