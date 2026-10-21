# Android device agent

用户认可原生 AccessibilityService + Tool Calling 方案并要求立即实现；沿用 App 内已有模型连接，不引入 AutoInput、Root 或常驻 ADB。

## 交付范围

独立「手机助手」页面输入自然语言目标，运行前明确当前模型会接收屏幕内容。手机端执行 observe、list_apps、open_app、tap、type_text、swipe、back、home、wait，逐步把实际结果交回模型；兼容 Chat Completions、Responses、Anthropic 的 function/tool 调用格式。普通聊天路径保留。

AccessibilityService 由用户在系统设置启用；只在用户开始的 session 内观察与操作。窗口节点优先，截图辅助定位；密码节点不导出，受保护窗口截图失败如实返回。窗口截图优先使用 API 34，旧系统使用 API 30 display screenshot；API 28/29 保留节点观察并明确截图不可用。

每个 session 绑定 Display，节点和坐标动作绑定最近一次 observation token；窗口、尺寸或节点状态变化后拒绝旧动作，要求重新观察。Fold6 cover / 展开以及 Samsung 虚拟 Display 不使用固定屏幕尺寸。浮层提供停止，断开服务、锁屏、超时或达到步骤上限停止；不自动恢复操作。

## 数据与接口

模型收到明确 JSON Schema 的 android_device function；每次只允许一个调用。截图缩放到最长边 1280，坐标基于返回的 screenshot 尺寸并映射回窗口。UI tree 最多 160 节点，文本有界；截图仅存在 session 内存中。执行记录保存目标、状态、工具名和简短结果，不保存截图、API Key 或输入字段内容，不加入 portable sync/export。

首版上限 30 次调用 / 10 分钟；连续三次工具失败停止。每个动作后重新观察供模型验证，最终回复不等同于设备任务已验证；保存实际工具执行记录供用户核对。

## 验证

MockWebServer 检查真实请求的 tools、tool_call_id / call_id、图片回传、终态、取消及错误；Emulator 实际启用 AccessibilityService，在隔离测试 Activity 中截图、节点点击、坐标点击、中文输入与旧 observation 拒绝；用 Fixture HTTP 驱动完整多步循环，不能以按钮存在或编译成功代替执行证据。构建优化 APK 并保持已有签名供覆盖安装。手机当前未连接 ADB，One UI 8.5 实际交互不以 Emulator 结果替代。

依据：https://developer.android.com/reference/android/accessibilityservice/AccessibilityService 和 https://developers.openai.com/api/docs/guides/function-calling 。
