# 本机与 iPhone 原位覆盖安装 · 2026-10-27

## 结果

用户要求"把电脑版安装好，然后测试一个需要多次调用工具的长问题"。安装源码为主检出 `554ce96`（Codex 的轮数 / 上限交付五步 + Claude 的收尾），壳的 Swift 源自 10-26 安装的 `752a086` 起没有改动，因此只是重编译同一份壳并覆盖。

- 桌面：`~/Applications/Melo.app`（Launchpad 主目标）与 `~/Desktop/melo/Melo.app`（指向前者的符号链接）于 16:39 覆盖，壳从源码目录运行 `src/server.js`，桌面运行的代码就是 `554ce96`。
- 真实长任务测试已于 18:58–19:09 跑完（主 Agent，两段），结论与根因见 [live-test-bigbang-20261027.md](live-test-bigbang-20261027.md)：场馆 / 交通 / 两天路线准确，天气始终缺，万圣节与次日活动要发"继续"才补到一部分；缺项都是桌面版里的工具链问题（壳 PATH 没有 node 使 Playwright 搜索腿永远不可用、Jina 匿名访问 DuckDuckGo 被限流、浏览器授权无人点 120 s 超时、回合 40 万输入 token 预算、页面 6 000 字截断）。
- iPhone（同机、同 bundle `com.melo.iphone.mfpiao`、同 Personal Team）19:14–19:20 从 **0.7.12 (44)** 原位覆盖到 **0.7.13 (45)**，首次启动成功；数据全部保留（见下表）。个人签名自本次构建起重新计 7 天。

## 手机数据保留

解锁状态下整份备份一次成功：55 文件、188.0 MB，逐文件 SHA-256（`before-manifest.json`）。

| 核对对象 | 安装前 | 安装后、首次启动前 | 启动后 |
| --- | --- | --- | --- |
| 对话 / 消息 | 17 / 174 | 17 / 174，文件一致 | 17 / 174，文件一致 |
| Agent 定义 | 6 | 6，文件一致 | 6，文件一致 |
| 图片文件 | 26 | SHA-256 全部一致 | SHA-256 全部一致 |
| 其他变化 | — | 仅 2 个系统启动快照缓存被替换，0 个文件内容变化 | 另有运行日志（execution-records / runtime-events）与 dyld 缓存按预期更新；`conversations.json`、`preferences.json`、`composer-drafts.json` 字节不变 |

## 验证层级

1. 第一次 `npm run release:verify`（16:32–16:41，含 Homebrew openjdk@21 / android-commandlinetools 环境变量）：安装前 15 项全部 GREEN——JS 4777 / 4777、容器隔离、桌面旅程、设置浏览器、iPhone 协议与共享渲染（259 s）、**Android JVM / Lint / Debug / Release（14.8 s，本机实际执行）**、语法、桌宠素材、壳构建、壳生命周期、本地 UI 服务、桌面冒烟、浏览器端到端、启动 Agent 人设契约；`Install desktop app bundle` GREEN。
2. 最后两项"Desktop folder Melo.app launch / Launchpad Melo.app launch" RED（各 60 s 后 SIGTERM）。根因不是壳：发布脚本用 `open --env MELO_HOME=… --env MELO_MOCK_RESPONSE=Native smoke reply.` 传环境变量，macOS 26.6.2 的 `open` 只把每个值第一个空格之前的部分交给 LaunchServices，被拉起的壳实际拿到 `MELO_HOME=/Users/mortred/Desktop/melo/Melo`、`MELO_MOCK_RESPONSE=Native`（`ps eww` 证实），服务没起来，也就没有 page-loaded。留下的测试模式实例已用 `tell application "Melo" to quit` 退出，没有产生那个错误目录。
3. 补做启动断言（16:45）：用与发布脚本完全相同的 13 项断言（page-loaded、bundle 路径、项目目录、非持久 WebData、输入区、首页、顶栏不重叠、5 个主导航及顺序、导航可见、内容滚动条），改为直接拉起 `Contents/MacOS/MeloDesktop` 并传入同样的环境，两个安装路径各 13 / 13 通过，均在 2.6 s 内自动关闭（`native-launch-desktop-folder.txt`、`native-launch-launchpad.txt`）。
4. 修复发布脚本：`scripts/verify-red-green.js` 的 `assertNativeLaunch` 改为直接拉起可执行文件并由 `runCommand` 传环境与 60 s 超时，不再依赖 `open --env`。快速档 `npm test -- --files scripts/verify-red-green.js` 按规则扩大到全部：`run-StBxI4`，567 / 567 个 JS 测试文件、JS 4771 / 4771、设置浏览器、Swift 全部，157 s，无跳过 / 隔离复测。
5. 第二次 `npm run release:verify`（修复后的完整发布流程，含安装与两个安装路径的原生启动）：见下节。
6. 手机：`ios/scripts/build-personal.sh`（`/usr/bin/python3` 优先）Release 自动签名通过（Team `XL7DA6573A`），`devicectl` 覆盖安装后回读 0.7.13 / 45，`device process launch` 首启成功（pid 16436）；版本号改在 `ios/Melo.xcodeproj/project.pbxproj` 两处，门禁快速档结果见「本机证据」。

## 第二次 release:verify

修复后的完整发布流程（17:04–17:07，`release-verify-2.log`）：17 项全部 GREEN，`Overall status: GREEN`——JS 4777 / 4777、容器隔离、桌面旅程、设置浏览器（36 s）、iPhone 协议与共享渲染（10 s，增量构建）、Android 四项（14 s）、语法、桌宠素材、壳构建、壳生命周期、本地 UI 服务、桌面冒烟、浏览器端到端、人设契约、安装、**Desktop folder Melo.app launch（4.7 s）与 Launchpad Melo.app launch（2.6 s）均 page-loaded**。安装步骤把 17:07:17 重编译的壳覆盖到 `~/Applications/Melo.app`，随后 `open -a` 正常拉起一次，停在"桌面"文件夹权限弹窗等用户今晚点允许；之后不再重编译。

## 桌面壳

- 安装路径与 10-26 相同；壳重编译导致 ad-hoc 签名变化，macOS 把它当作新应用重新询问"桌面"文件夹访问权限，所以每次重编译并覆盖后，用户第一次正常启动都会再见到这个弹窗；从终端直接拉起可执行文件做验证时继承了终端的权限，不会弹。
- 已补做：真实模型长任务测试（见「结果」与测试回执）；iPhone 覆盖安装（见「手机数据保留」）。未做：壳 PATH 修复（`desktop-app/main.swift` 把解析出的 node 所在目录加进服务 PATH，需再次重编译并让用户再点一次"桌面"文件夹权限，待用户决定）。

## 本机证据

`.tmp/desktop-install-20261027/`：`release-verify.log`（第一次）、`native-launch-desktop-folder.txt`、`native-launch-launchpad.txt`、`desktop-app-debug-desktop-folder.txt`、`desktop-app-debug-last.txt`、`gate-quick.log`、`gate-chain.log`、`release-verify-2.log`（第二次）、`live-test/`（真实测试两段的事件流、回复、执行场景引用与真值参考，见测试回执）。快速档摘要 `.tmp/test-runs/run-StBxI4/summary.json`。

手机：`.tmp/phone-install-20261027/`（`backup-before.log`、`before-manifest.json`、`before-summary.json`、`build.log`、`install.json`、`installed-after.json`、`copy-after-install.log`、`phone-after-install-preservation.json`、`launch.json`、`copy-after-launch.log`、`phone-after-launch-preservation.json`、`compare.cjs`、`gate-quick.log`）；版本号改动的快速档 `run-vBDgCI`（JS 4771/4771、设置浏览器、Swift 全部，171.9 s）全绿，摘要 `.tmp/test-runs/run-vBDgCI/summary.json`；备份副本 `~/Library/Application Support/MeloDeviceBackups/update-20261027-191430/`（`phone-before`、`phone-after-install`、`phone-after-launch`，均为完整容器副本）。
