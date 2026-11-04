# 动态广告导致 stale_screen 的修复（2026-10-26）

## 用户证据与代码定位

用户截图中：打开汽水音乐后 wait，三次 tap 均被 stale_screen 拒绝，其间 observe 成功，最终 REPEATED_DEVICE_FAILURE。单凭截图不能确定广告内容或模型选择是否正确。代码中同窗口 content/scroll/text 事件均推进 generation，而坐标点击在原生确认前要求 generation 完全相等；动态广告即使关闭按钮不动，也会反复使观察失效。整次任务约 40 秒，不能直接归因于 90 秒过期。

## 修复边界

```text
observe -> 保留 session 内截图与窗口身份 -> 模型选择目标
  -> 身份/显示尺寸/90 秒检查
  -> generation 未变：原路径
  -> generation 改变：截取目标附近区域，检查稳定且有辨识度的像素
  -> 原生确认 -> 隐藏确认层 -> 再次核对 -> dispatchGesture
```

- 同一窗口背景变化时，允许有局部视觉依据的稳定坐标进入原生确认；低对比/空白区域拒绝。32×32 像素样本容忍少量 JPEG 误差，替换或移动目标仍拒绝。
- 保留 session、screen ID、窗口、display、折叠/尺寸和过期保护，不全局忽略 generation；Accessibility node 目标仍检查实际节点身份，swipe 仍保持严格检查。
- 原图只留 session 内存，结束/失效即清除；没有将私密截图写入缓存。Screenshot 采集间隔控制避免触发系统速率限制。

## 验证与局限

- JVM 正反例检查 JPEG 噪声容忍、目标替换/移动/无特征拒绝。
- Debug-only Android Fixture 每 100ms 发送 content 变化并改变背景：稳定关闭按钮可确认并只点一次；确认期间替换成 BUY 的目标被拒绝，零点击。
- 模型是本地脚本 Fixture。旧 guard 的同一测试无法到达确认；保留 red 日志和修复后结果。
- 不包含真实汽水音乐或真实广告验证，也没有证明模型一定选中正确的关闭入口。原有手机探测、终止判断和未合并 Workflow 问题不能因此宣称全部解决。

日志：`.tmp/dynamic-ad-red.log`、`.tmp/dynamic-ad-diag.log`；最终 Native 组合验收见 [Organizer 回执](android-organizer-implementation-20261026.md)。
