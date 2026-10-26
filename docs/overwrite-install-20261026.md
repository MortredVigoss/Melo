# 本机与 iPhone 原位覆盖安装 · 2026-10-26

## 结果

用户要求"合并 master，本机和手机覆盖安装"，随后要求把回执一并推送。master 当时已包含全部已完成线程（`codex/self-development-20261026` 等分支的实现早已合入；仍未合入的旧分支只剩被后续提交取代的 10-15 ~ 10-22 草稿与 PROGRESS 条目），没有新的合并动作。安装源码 `752a086`：三处收紧 `16ad6dd` + 文档 `35fe978` + 手机版本号 `752a086`，与完整日常 `run-bZBKkK` 校验过的 `16ad6dd` 之间只有文档和版本号差异，没有运行时改动。

- iPhone（同机、同 bundle `com.melo.iphone.mfpiao`、同 Personal Team）从 **0.7.11 (43)** 原位覆盖到 **0.7.12 (44)**，首次启动成功；数据全部保留（见下表）。
- 桌面：壳已重建并覆盖安装，运行代码为主检出 `752a086`；两个安装路径的原生启动断言全过（见「桌面壳」）。

## 手机数据保留

解锁状态下整份备份一次成功：55 文件、187.8 MB，逐文件 SHA-256（`before-manifest.json`）。

| 核对对象 | 安装前 | 安装后、首次启动前 | 启动后 |
| --- | --- | --- | --- |
| 对话 / 消息 | 16 / 169 | 16 / 169，文件一致 | 16 / 169，文件一致 |
| Agent 定义 | 6 | 6，文件一致 | 6，文件一致 |
| 图片文件 | 26 | SHA-256 全部一致 | SHA-256 全部一致 |
| 其他变化 | — | 仅 2 个系统启动快照缓存被替换 | 另有运行日志（execution-records / runtime-events）、dyld 缓存按预期更新；`composer-drafts.json` 仅键序重写，8 条草稿（含用户未发送的文字）逐条相同 |

## 验证层级

- 代码回归：三处收紧按门禁规则扩大为完整日常 `run-bZBKkK`（JS 4709 / 4709、设置浏览器验收、Swift 37 组，无跳过 / 隔离复测）；Docker 隔离与旅程验收通过。
- 推送：`16ad6dd`、`35fe978`、`752a086` 已在 origin/master；本回执随后提交并推送。未运行 `git pp`。
- 手机构建与签名：`ios/scripts/build-personal.sh` Release 自动签名通过（Team `XL7DA6573A`）。注意：Codex 10-26 新增的 `ios/scripts/sync-theme.py` 用到 `str.removeprefix`（Python ≥ 3.9），本机 shell 默认的 anaconda Python 3.8 会让 `build-scene.py` 直接失败；用 `/usr/bin/python3`（3.9.6）置前 PATH 后通过。
- 手机安装：`devicectl` 覆盖安装成功，安装列表回读 0.7.12 / 44；`devicectl device process launch` 首次启动成功。
- 真机功能：本轮未验，由用户在实体屏幕确认。

## 桌面壳

- 安装路径：`~/Applications/Melo.app`（Launchpad 主目标）与 `~/Desktop/melo/Melo.app`（指向前者的符号链接）；壳从源码目录运行 `src/server.js`，因此桌面运行的代码就是主检出 `752a086`。壳本身自 10-24 安装以来只有 4 个 Swift 文件 6 行改动。
- 验证：`npm run test:full`（不安装）14 步里 13 步 GREEN：JS 回归、隔离开发容器与旅程、设置浏览器、iPhone 协议与共享渲染（Swift）、语法构建、桌宠素材、桌面壳构建、壳生命周期、本地 UI 服务、桌面冒烟、浏览器端到端、启动 Agent 人设契约；唯一 RED 是 Android（266 ms，`Unable to locate a Java Runtime`，本机无 JDK / SDK，属环境而非代码；Codex 当日 Android 四项通过的环境本线程无法复现）。
- `release:verify` 要求全部 GREEN 才放行安装，所以本轮按 10-24 先例改为完整验证后手动 `npm run install:desktop`，再用与发布脚本 `assertNativeLaunch` 相同的流程（自动关闭哨兵 + 独立验证 home + 测试模式）分别启动两个安装路径：13 项断言（page-loaded、bundle 路径、项目目录、非持久 WebData、输入区、首页、顶栏不重叠、5 个主导航及顺序、内容滚动条）全部通过。
- 证据：`.tmp/desktop-install-20261026/`（`test-full.log`、`install.log`、`native-launch-desktop-folder.txt`、`native-launch-launchpad.txt`、`desktop-app-debug-last.txt`）。
- 未做：Android 四项未在本机验证（交 CI）；没有替用户启动真实 Melo 窗口，用户自行打开即运行新代码。

## 本机证据

- 手机：`.tmp/phone-install-20261026/`（`backup-before.log`、`before-manifest.json`、`before-summary.json`、`install.json`、`installed-after.json`、`copy-after-install.log`、`phone-after-install-preservation.json`、`launch.json`、`copy-after-launch.log`、`phone-after-launch-preservation.json`）。
- 备份副本：`~/Library/Application Support/MeloDeviceBackups/update-20261026-233343/`（`phone-before`、`phone-after-install`、`phone-after-launch`，均为完整容器副本）。
