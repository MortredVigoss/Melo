# B 黑冰星窗：双端落地

用户于 2026-10-15 明确选择“第 3 张 B：圆润厚玻璃 M”。标识使用同一张静态黑金星空母版；不再采用神经网络 Logo。

## 实施顺序

| 顺序 | 用户要求 / 旧行为 | 本轮改动 | 平台差异 | 验收 |
| --- | --- | --- | --- | --- |
| 1 | B 已获确认 | 从选定概念提取无文字方形母版 | 内置 image_gen 编辑原图 | 视觉核对形状、玻璃、星云 |
| 2 | Mac 青绿 M / iPhone 金色散点不一致 | 两端共用 assets/brand/melo-black-ice-master.png | iOS 不透明正方形；macOS 圆角透明外边距 | 尺寸、alpha、同源导出与小尺寸预览 |
| 3 | 两个旧 Swift 脚本会重建旧 Logo | 共用导出脚本，保留旧入口转发 | 使用现有 sharp 与 macOS iconutil | 分别调用两入口，核对散列稳定 |
| 4 | 打包实际引用不同文件 | 更新 ICNS/PNG 以及现有预览资产 | 不改 bundle、签名或用户数据 | 桌面包和 iOS 模拟器包资源检查 |

当前为图标替换范围；应用内神经场景、功能、同步协议与共享 WIP 保留。构建与实际安装/真机验收分开记录，不因图标变更重启正在使用的应用。

## 母版来源

- 工具：内置 image_gen。
- 参考：B-black-ice-window.png，用户选择的 B 方案。
- 原始输出：/Users/mortred/.codex/generated_images/01a10bf3-d7b9-7832-a351-8b0f78e9c552/exec-819ead58-8d9d-4775-8eff-6beef8973b53.png
- 生成指令：selected-master-prompt.txt。
- 视觉母版只由生图工具编辑；导出器只做尺寸、平台遮罩和文件封装，不生成新图形或推理特效。


## 完成与验证

- 已生成共用母版及双端静态图标；源图 SHA-256：36b2e4be11ee949d7403e52051b711ed74cf6440ea241095ced37a7bebe41ffe。
- 17 个资源散列、13 个 PNG 尺寸/alpha 检查通过；两个旧 Swift 入口均成功生成相同资源；64px 图标人工查看通过。
- 桌面构建/签名通过，实际包 ICNS 与源资源逐字节一致；iOS 模拟器构建通过，三个优化后 PNG 经 pngcrush 解码后像素完全一致。首次直接比较 PNG 字节失败源于 Apple CgBI 优化，保留失败边界并改用正确的解码核对。
- 证据：.tmp/logo-icons-20261015/ 中 export-verification.json、bundle-verification.json、desktop-build.log、ios-build.log。当前共享源码构建包含他线程 WIP，不能把图标检查当作整库功能回归。
- 未覆盖安装/重启桌面或实体手机，未更改 bundle、签名团队、账号或用户数据；真机图标与安装后缓存刷新待下一次正常安装。

## 维护命令

```sh
node scripts/render-app-icons.mjs
swift scripts/render-icon.swift
swift ios/scripts/draw-icon.swift ios/Melo
```

主命令同时导出两端；旧 Swift 入口分别转发到同一脚本。SVG 兼容文件嵌入同一 PNG，不是可编辑矢量母版。图标为静态资源，不增加运行中的粒子动画。
