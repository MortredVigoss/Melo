# B 黑冰星窗：双端落地

用户于 2026-10-15 明确选择“第 3 张 B：圆润厚玻璃 M”。标识使用同一张静态黑金星空母版；不再采用神经网络 Logo。

## 实施顺序

| 顺序 | 用户要求 / 旧行为 | 本轮改动 | 平台差异 | 验收 |
| --- | --- | --- | --- | --- |
| 1 | B 已获确认 | 从选定概念提取无文字方形母版 | 内置 image_gen 编辑原图 | 视觉核对形状、玻璃、星云 |
| 2 | Mac 青绿 M / iPhone 金色散点不一致 | 两端共用 assets/brand/melo-black-ice-master.png | iOS 不透明正方形；macOS 圆角透明外边距 | 尺寸、alpha、同源导出与小尺寸预览 |
| 3 | 两个旧 Swift 脚本会重建旧 Logo | 共用导出脚本，保留旧入口转发 | 使用现有 sharp 与 macOS iconutil | 分别调用两入口，核对散列稳定 |
| 4 | 打包实际引用不同文件 | 更新 ICNS/PNG 以及现有预览资产 | 不改 bundle、签名或用户数据 | 桌面包和 iOS 模拟器包资源检查 |

当前为图标替换范围；应用内神经场景、功能、同步协议与共享 WIP 保留。构建与实际安装/真机验收分开记录。上一轮未安装；用户反馈电脑未变化后，已按下文执行电脑补安装。

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
- 上述为上一轮资源/构建层验证；电脑已按下文补安装，实体手机仍未覆盖安装。

## 维护命令

```sh
node scripts/render-app-icons.mjs
swift scripts/render-icon.swift
swift ios/scripts/draw-icon.swift ios/Melo
```

主命令同时导出两端；旧 Swift 入口分别转发到同一脚本。SVG 兼容文件嵌入同一 PNG，不是可编辑矢量母版。图标为静态资源，不增加运行中的粒子动画。

## 电脑补安装（2026-10-15）

- 原因：正在运行的 `/Users/mortred/Applications/Melo.app` 仍含旧 ICNS；`/Users/mortred/Desktop/melo/Melo.app` 是指向它的符号链接。上一轮构建不等于安装。
- 操作：复制当前已安装包，仅替换 `Contents/Resources/melo.icns`，保留签名元数据并重新 ad hoc 签名；正常退出后换入，再注册该包的 LaunchServices 并重新打开。去签名后的可执行文件 SHA-256 前后一致，其他资源逐字节保留。
- 安装验证：严格签名检查通过；安装后 ICNS SHA-256 为 `a35eb6aa542bac69f18d4cab39e4dc7de786a02928b0818bbfcc81dd603893af`，与批准资源相同。Finder 列表与简介均已实际显示黑金 B 图标；Dock 工具读取超时，不宣称单独 Dock 实看通过。
- 数据边界：43 项保护文件中 42 项（含账号配置、聊天与 Agent 文件）散列未变；`desktop/state.json` 在正常退出后改变，现仍 14 对话/1 项目/6 Agent，不宣称此文件逐字节一致。未恢复、覆盖或清理用户资料。
- 启动与授权：macOS 在重新签名后发起 `kTCCServiceSystemPolicyDesktopFolder` 授权，Node 曾等待打开桌面目录中的 package.json。电脑工具拒绝操作 UserNotificationCenter 系统窗口；用户已亲自点击允许。随后 `/api/health` 返回正常，实际 home 与此前一致；点击原生“重新打开”后成功进入工作空间，UI 显示 14 段对话、1 项目、6 Agent。安装图标散列、严格签名和 42 项保护文件散列再次核对通过。
- 证据与恢复：`.tmp/logo-desktop-install-20261015/installation-verification.json`、`server-sample.txt`；旧安装包保留为同目录 `previous.bundle`，不进入 LaunchServices 应用索引。未推送，未更新手机，不重跑全库 gate。
