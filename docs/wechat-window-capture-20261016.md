# WeChat / Samsung 窗口截取诊断 — 2026-10-16

## 用户报告与历史记录

用户报告 Fold6 最新微信任务看不到截图内容。0.4.0 最新用户任务为微信消息操作，记录状态 cancelled（20 个工具步骤、21 次模型请求），没有 finish；第 12、19 次 tap 因旧窗口已不再属于当前前台 App 被 stale_screen 拦截。多次 open_app / observe / wait 写“已截图”，但这个摘要不记录截取的 package，不能据此证明是微信截图。没有重跑用户的消息发送任务。

历史只存精简 DeviceStep，不保存原始截图、完整 tree 或模型每轮文字，无法恢复当时全部像素。以下原因以独立只读复现确认，不能声称逐帧还原历史。

## 只读复现与证据边界

- 当前手机为 cover / folded，Physical size 968×2376。ADB screenshot 能看到正常微信首页；本地只检查画面，没有将联系人 / 消息或截图拷入仓库。
- UIAutomator 对微信仅返回 1 个空节点、0 个文字 / description；这只是独立 tree 检查，不能代表画面不存在。窗口 metadata 显示微信 TYPE_APPLICATION focused=true、active=true，侧边手势层位于更高 layer。
- 既有 Modal Proxy / gpt-6.1-sol 用合成 JPEG 的随机 8 字符 OCR 验证 HTTP 200 且读取正确；没有发送真实微信图片做这次独立 API 检查，没有读取手机 Keystore 或迁移 Key。
- 第一次只读 Probe 只观察了初始 Melo 页面就结束，未启动微信，不计作微信复现。
- 第二次明确先 open_app(com.tencent.mm)，模型收到全黑、无标签的窗口，并报告观察到的 package 为 `com.samsung.android.sidegesturepad`。因此已直接复现：窗口选择落到 Samsung 手势层，不能归结为模型不会读图或微信一律禁止截图。
- 只读任务禁止 tap / type / send / 打开对话 / 改设置；只用了 observe、open_app 与 finish。原有发送任务没有恢复。

## 修复

旧筛选条件要求 root.isVisibleToUser=true，然后优先 isActive。UI tree 不可读的前台窗口可能被排除，触摸活跃的装饰层也可能优先于实际输入焦点窗口。

新策略保留 focused / active 窗口，即使 root 不可见；按 focused、active、layer 排序。输入法和自身 Accessibility overlay 仍排除；系统前台 dialog 即使 tree 不可读也保留为屏障，不能跨过去点击底层 App。原 same-App modal / pane / stale screen 检查保持。

新的 DeviceStep observation 摘要记录 package、截图尺寸、节点数与截图错误；不记录节点文字 / 原始图像，便于从记录判断捕获了哪个窗口。

## 验证

2026-10-17：0.4.1（versionCode 10）通过 95 JVM / 34 Android runtime tests、Lint、Debug / R8 Release 与 signature / 四 ABI 16 KiB alignment。同证书覆盖 Fold6，6 Chat / 1 角色及其他 Accessibility Services 保留。

- unfolded 1856×2160：3 步 / 3 次模型请求，窗口 com.tencent.mm，549×1280 JPEG、0 节点；模型能读到微信画面，终态 package 重查通过。
- folded 968×2376：强制 Probe 排除 Cache，2 步 / 2 次模型请求，仍截到 com.samsung.android.sidegesturepad（56×1280 / 0 节点），模型明确 finish blocked。此结果说明 focused 排序修复不足，不能宣布 Fold6 已完全修复。
- Native fixture 最初 NO_HIDE_DESCENDANTS 仍被 includeNotImportantViews 读取，未真实模拟问题；改为 AccessibilityDelegate 明确返回 root visible=false，保留“零节点 + 正确窗口 JPEG”强断言，最终全部通过。
- 脱敏回执：[0.4.1 Fold6 evidence](evidence/wechat-window-041-20261017.json)。未重跑原微信消息发送，未声称输入 / 发送可用；微信是否主动限制仍无充分证据。

当前外屏失败需进一步检查启动后窗口转移与服务能见范围。Task Cache 仍仅按 Display 绑定 scope，尚未完成折叠 / 展开布局分区；两项均不可当成已验收。0.4.1 只是验证中的中间版本，后续包与回执须单独记录。
