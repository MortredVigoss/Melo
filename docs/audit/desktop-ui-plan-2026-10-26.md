# 桌面 UI 批次实施约束

1. notify({level,text,scope})：错误在当前页面状态条持续显示，可选 toast；成功 toast 3 秒；状态条可关闭，重渲染仍保留且不串页面。事件内容使用 textContent / 统一 escape；真实运行、录音和启动的 role=status 继续保留。统一调用和反馈样式不等于删除进度无障碍语义。
2. EditSession：已有 7 种设置表单复用，创建表单在打开时直接进入编辑，不多加一次编辑点击。既有 handler 负责存储，保存失败保留草稿；取消还原功能自己的 state。任务排队和审批请求用“已提交”反馈，不假称文件已经保存。真正提交控件由 renderEditActions 生成，保持 Enter / requestSubmit；composer 和输入对话框保持原语义。
3. 标题：页 h1.page-title，卡 h2.pane-title，小节 h3.subsection-title。消息里的标题不是应用页面层级，不错误转换。
4. 按钮：primary / secondary / ghost / icon 四种视觉变体；行为 data-action、布局和测试定位类保留，统计视觉样式而非一切 CSS hook。神经节点、可选卡片、菜单行和开关属于交互内容，保留组件命中区与选中态，不能套普通操作按钮边框。
5. 固定样式进入类，有限尺寸/身份使用 data 属性，连续布局值（树深度、3D 投影）通过有界 CSS 自定义属性绑定。禁止仅把 style 字符串改写来骗扫描。
6. 单一 HTML 转义实现移到 i18n，旧 html.js 只兼容 re-export；去掉包装副本，空值安全仍保留。场景色来自 tokens 的 scene 语义 token，供 Canvas / Three.js / SVG 同源读取。
7. !important 仅保留 hidden 和 reduced-motion 这类有意覆盖，其他逐个核对层叠和 JS 写入来源。最终浏览器检查浮层、详情、设置、导航、取消和提交。
8. 已尝试使用 CUA 读取当前 Codex 原生界面，工具明确禁止访问 com.openai.codex；没有绕过。沿用 Melo 已确认 13px 正文、紧凑控件与黑金 token，不能声称目检了当前 Codex。


## 双端映射与验收顺序

当前主线审计基线 / 设计线程执行记录 / UI 现行 13px 黑金工作面已从 MELO_OVERVIEW 与源码核对；没有额外未归属 WIP。批次基准 `58158dd`。

| 顺序 | 桌面变更 | 手机映射 | 验收 |
| --- | --- | --- | --- |
| 1 | 转义、场景颜色、执行标签 CSS | 共享 executionPanel / scene bundle 和 tokens 原样打包，不改 v1 数据协议 | 转义反例、Canvas/SVG/WebGL fallback、manifest、SceneBridge |
| 2 | 通知、表单、标题、按钮与术语 | 原生已有 SwiftUI 表单，语义词表在批次 5 对齐；保留动态文本和无障碍状态 | 浏览器编辑/保存/取消/错误、紧凑布局、英文面板 |
| 3 | 样式清理与运动覆盖 | 手机场景保留投影、降级与 reduced-motion，原生字号走 MeloTheme 生成器 | 共享契约、Swift、完整 iOS 编译；真机未安装 |

本机 CUA 拒绝读取 Codex 原生界面，不绕过。以已确认的 Melo 设计基础执行上述规则，不能宣称已目检当前 Codex。

## 已验证修正
浏览器实际交互覆盖创建表单取消/重开、503 失败保留草稿、Enter 提交及重试成功；错误条不覆盖标题；窄屏语言菜单可点击；展开执行详情时输入区宽度仍大于 300px。动态项目筛选标题加入 t()，双端知识/对话文案同步；个人资料、会话令牌和数据文件保留各自含义。

手机词条随 U6 提前同步，补齐 24 条插值格式。H18 同时校准：SwiftUI 的 Text("…\(value)") 原生支持本地化，Text(verbatim: userContent) 应保留用户原文，不能一律当缺陷。新目录门禁不再跳过插值，逐个检查五语格式；固定 verbatim 文案和原始字号/色仍受 H18 检测。此项是双端词条改名的前置依赖，原生动态状态和字体另在批次 5 修复。
