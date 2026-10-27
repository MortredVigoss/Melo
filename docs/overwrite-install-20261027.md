# 本机原位覆盖安装 · 2026-10-27

## 结果

用户要求"把电脑版安装好，然后测试一个需要多次调用工具的长问题"。安装源码为主检出 `554ce96`（Codex 的轮数 / 上限交付五步 + Claude 的收尾），壳的 Swift 源自 10-26 安装的 `752a086` 起没有改动，因此只是重编译同一份壳并覆盖。

- 桌面：`~/Applications/Melo.app`（Launchpad 主目标）与 `~/Desktop/melo/Melo.app`（指向前者的符号链接）于 16:39 覆盖，壳从源码目录运行 `src/server.js`，桌面运行的代码就是 `554ce96`。
- 真实长任务测试（主 Agent、问题原话"查一下10月31号bigbang演唱会的时候当地天气怎么样，有什么活动，以及第二天有什么活动，再顺便安排一整天的路线规划"）**尚未跑**：新壳首次正常启动卡在 macOS「"Melo.app" 想访问"桌面"文件夹中的文件」弹窗（壳读 `~/Desktop/melo/Melo Desktop Project` 才能拉起服务），系统弹窗只能由用户点；用户决定晚上再点，测试顺延到晚上（提醒已设）。

## 验证层级

1. 第一次 `npm run release:verify`（16:32–16:41，含 Homebrew openjdk@21 / android-commandlinetools 环境变量）：安装前 15 项全部 GREEN——JS 4777 / 4777、容器隔离、桌面旅程、设置浏览器、iPhone 协议与共享渲染（259 s）、**Android JVM / Lint / Debug / Release（14.8 s，本机实际执行）**、语法、桌宠素材、壳构建、壳生命周期、本地 UI 服务、桌面冒烟、浏览器端到端、启动 Agent 人设契约；`Install desktop app bundle` GREEN。
2. 最后两项"Desktop folder Melo.app launch / Launchpad Melo.app launch" RED（各 60 s 后 SIGTERM）。根因不是壳：发布脚本用 `open --env MELO_HOME=… --env MELO_MOCK_RESPONSE=Native smoke reply.` 传环境变量，macOS 26.6.2 的 `open` 只把每个值第一个空格之前的部分交给 LaunchServices，被拉起的壳实际拿到 `MELO_HOME=/Users/mortred/Desktop/melo/Melo`、`MELO_MOCK_RESPONSE=Native`（`ps eww` 证实），服务没起来，也就没有 page-loaded。留下的测试模式实例已用 `tell application "Melo" to quit` 退出，没有产生那个错误目录。
3. 补做启动断言（16:45）：用与发布脚本完全相同的 13 项断言（page-loaded、bundle 路径、项目目录、非持久 WebData、输入区、首页、顶栏不重叠、5 个主导航及顺序、导航可见、内容滚动条），改为直接拉起 `Contents/MacOS/MeloDesktop` 并传入同样的环境，两个安装路径各 13 / 13 通过，均在 2.6 s 内自动关闭（`native-launch-desktop-folder.txt`、`native-launch-launchpad.txt`）。
4. 修复发布脚本：`scripts/verify-red-green.js` 的 `assertNativeLaunch` 改为直接拉起可执行文件并由 `runCommand` 传环境与 60 s 超时，不再依赖 `open --env`。快速档 `npm test -- --files scripts/verify-red-green.js` 按规则扩大到全部：`run-StBxI4`，567 / 567 个 JS 测试文件、JS 4771 / 4771、设置浏览器、Swift 全部，157 s，无跳过 / 隔离复测。
5. 第二次 `npm run release:verify`（修复后的完整发布流程，含安装与两个安装路径的原生启动）：见下节。

## 第二次 release:verify

修复后的完整发布流程（17:04–17:07，`release-verify-2.log`）：17 项全部 GREEN，`Overall status: GREEN`——JS 4777 / 4777、容器隔离、桌面旅程、设置浏览器（36 s）、iPhone 协议与共享渲染（10 s，增量构建）、Android 四项（14 s）、语法、桌宠素材、壳构建、壳生命周期、本地 UI 服务、桌面冒烟、浏览器端到端、人设契约、安装、**Desktop folder Melo.app launch（4.7 s）与 Launchpad Melo.app launch（2.6 s）均 page-loaded**。安装步骤把 17:07:17 重编译的壳覆盖到 `~/Applications/Melo.app`，随后 `open -a` 正常拉起一次，停在"桌面"文件夹权限弹窗等用户今晚点允许；之后不再重编译。

## 桌面壳

- 安装路径与 10-26 相同；壳重编译导致 ad-hoc 签名变化，macOS 把它当作新应用重新询问"桌面"文件夹访问权限，所以每次重编译并覆盖后，用户第一次正常启动都会再见到这个弹窗；从终端直接拉起可执行文件做验证时继承了终端的权限，不会弹。
- 未做：真实模型长任务测试（等用户点允许后由本线程自动发题并录制到 `.tmp/desktop-install-20261027/live-test/`）；iPhone 覆盖安装（今晚，先完整备份；个人签名 2026-10-28 20:52 Melbourne 到期）。

## 本机证据

`.tmp/desktop-install-20261027/`：`release-verify.log`（第一次）、`native-launch-desktop-folder.txt`、`native-launch-launchpad.txt`、`desktop-app-debug-desktop-folder.txt`、`desktop-app-debug-last.txt`、`gate-quick.log`、`gate-chain.log`、`release-verify-2.log`（第二次）、`live-test/`（今晚）。快速档摘要 `.tmp/test-runs/run-StBxI4/summary.json`。
