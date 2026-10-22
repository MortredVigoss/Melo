# 桌宠并入 Melo 安装包 · 2026-10-22

用户在三个方案中选定 C：桌宠随 `Melo.app` 分发，由 Melo 管理启停，系统设置里加「桌面宠物」开关。本文记录实现边界、仓库外大文件的处理、真机验收与未验证层级。桌宠本体说明见 [`desktop-pet/README.md`](../desktop-pet/README.md)；素材生产线（`animation-work-v3/`、超分与插帧工具、证据）仍留在 `/Users/mortred/Documents/New project/desktop-pet`，本轮只读取、不修改。

## 落地位置

| 内容 | 位置 |
| --- | --- |
| 桌宠代码（控制进程、Melo 桥接、对话窗口、原版 host 适配、测试、上游全部源码与 MIT 许可） | `desktop-pet/`（独立 CommonJS 包，自己的 `package.json` 钉 Electron 37.10.3 与 esbuild） |
| 金冬天 WebM（约 354MB）、关键帧审计（约 290MB）、大肥鱼原版 WebM（约 52MB） | 仓库旁固定目录 `../desktop-pet-assets`（`MELO_PET_ASSETS_DIR` 可覆盖），不入 Git；`npm run import:pet-skin` 从素材生产线校验后导入并链接进 `desktop-pet/`，`npm run verify:pet-skin` 校验 |
| 版本钉住 | `desktop-pet/skins/winter/manifest.json`（版本号与每段 sha256，入 Git）、`desktop-pet/assets.lock.json`（审计帧与大肥鱼动画的 sha256，入 Git） |
| 安装包内 | `Melo.app/Contents/Resources/desktop-pet/`：代码、生产依赖、两套皮肤、`runtime/DSHPet.app`（钉版本 Electron，桌宠自己的 bundle 身份，ad-hoc 签名），`bundle.json` 记录版本 |
| Melo 侧 | `desktop-app/DesktopPet.swift`（启停、状态、看门狗）、`main.swift`（设置桥接、启动后带起、退出时关停）、`desktop-ui/localSettings.js`（设置行）、五语词条 |

Git LFS 未安装；按任务给出的替代方案采用仓库外固定目录 + 哈希校验，没有向 GitHub 推送任何大文件。原项目的 `upstream/assets/preview`（64MB，仅 README 的 GIF）没有并入。

## 构建与签名

`npm run build:desktop` 在原流水线的启动页生成之后、外层 `codesign` 之前调用 `scripts/bundle-desktop-pet.js`：校验媒体与钉住的哈希、用 `desktop-pet/build.cjs` 重建 host 产物、复制运行所需文件与 `npm ls --omit=dev` 得到的生产依赖、从 `desktop-pet/node_modules/electron` 复制 Electron 并改成桌宠身份后 `codesign --deep --sign -`。外层仍是原来的 `codesign --force --sign - Melo.app` + `--verify --deep --strict`，Melo 自己的签名与启动方式不变。安装包从约 130MB 增至 808MB（桌宠 676MB，其中 Electron 250MB）。

发布 gate（`npm run test:full`）新增「Desktop pet media store (verify:pet-skin)」一步；桌宠测试由 `scripts/test-discovery.js` 自动发现（`desktop-pet/tests`），日常选组对 `desktop-pet/**` 选整个 `test:desktop-pet` 组与原生桥接测试。

## 启停与状态

- 偏好 `UserDefaults melo.desktopPet`。开：立即 `start`，并在以后每次 Melo 服务就绪后带起；关：POST 桌宠控制服务 `/quit`，等进程结束（不响应时 SIGTERM，Melo 自己的子进程再 SIGKILL）。
- Melo 启动桌宠时用包内 `runtime/DSHPet.app/Contents/MacOS/Electron main.cjs`，环境变量 `MELO_BASE_URL` 传实际端口，不再依赖 `~/Documents/New project/node_modules/electron`。
- 桌宠控制服务起来后写 `~/Library/Application Support/melo-desktop-pet-dsh/runtime.json`（0600：进程号、host 进程号、控制地址、口令、Melo 地址），退出时删除。Melo 以「记录存在且进程存活」判断运行状态；设置行的状态文字来自这里，不是偏好。
- 桌宠自己退出（右键 / 应用菜单「退出桌宠」或崩溃）：子进程结束回调或 2 秒看门狗把偏好改为关，并向页面派发 `melo-local-settings-changed`，设置行无需刷新即改为「未运行 / 关闭」。
- Melo 退出（Cmd+Q、关闭窗口退出、SIGTERM）：先 `/quit` 桌宠再停服务，沿用原有有界停子进程路径；`MELO_DESKTOP_PET_DISABLED=1` 让真包冒烟的替身壳永不启动用户的桌宠。
- profile 目录、皮肤选择、位置、尺寸、对话记录原样保留；本轮安装后 profile 仍是 winter 皮肤、原对话 id 与 9 条历史。

## 验收（2026-10-22，本机）

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 日常回归（`npm test -- --files` 列出全部任务文件，公共边界扩大为完整日常） | JS 阶段 4484 项：满负载下 8 失败 + 5 取消，全部是超时 / 启动超时类且不在本任务文件；12 个文件隔离复测 46/49，仅剩 3 个 Playwright 旅程，空载再测 3/3 通过。设置 + 加速设置浏览器旅程通过；Swift 37/37 通过（25 分钟）。把 `translations.js` 的手机场景生成物一并列入时，Android 阶段因本机无 Java 为环境红灯（CI 覆盖），其余阶段按上面逐段跑完 | `.tmp/desktop-pet-20261022/daily.log`、`daily-with-scene-android-red.log`、`rerun-failed*.log`、`swift-stage.log`、`browser-stages.log` |
| 桌宠测试新位置 | 35/35（原 33 项 + 运行记录 2 项）；`npm run test:desktop-pet` | 终端 |
| 媒体导入 / 校验脚本 | 3/3（`scripts/desktop-pet-assets.test.js`）；真实导入 106+106 段与 1590 个审计文件，钉住 `winter-106-12keys-sr-flow-fe6cf9b45399` | `desktop-pet/assets.lock.json` |
| 设置行与五语 | `desktop-ui/localSettings.desktopPet.test.js` 3/3，i18n 覆盖与设置测试通过 | 终端 |
| 构建与签名 | `npm run build:desktop` 成功，`codesign --verify --deep --strict` 通过，安装到 `~/Applications/Melo.app` | `.tmp/desktop-pet-build.log` |
| 冷启动（LaunchServices `open`）、偏好关 | Melo 正常启动，桌宠不启动，设置行「未运行 / 关闭」 | `.tmp/desktop-pet-20261022/settings-row-initial-off.jpg` |
| 偏好开后冷启动 | 服务就绪 3 秒内桌宠作为 Melo 子进程出现，`runtime.json` 0600、`/health` 带口令 200 / 不带 401、`MELO_BASE_URL=http://127.0.0.1:43127` | 终端、`screen-pet-running.png` |
| 打开对话并真实回复 | 应用菜单「与 Melo 对话」打开原对话窗口，发送一句测试，Melo 主助手回复「收到。」，写入桌宠 `conversation.json`（source melo）并出现在 Melo 自己的对话列表 | `pet-chat-melo-replied.jpg` |
| 设置页下拉 → 保存（真机 UI） | 「开启 → 关闭」保存后桌宠经 `/quit` 退出、记录删除、偏好 0，行变「未运行 / 关闭」；「关闭 → 开启」保存后桌宠作为 Melo 子进程重新出现、记录回来、偏好 1，行变「运行中 / 开启」 | `ui-dropdown-open.jpg`、`ui-saved-off-not-running.jpg`、`ui-saved-on-running.jpg` |
| 桌宠自行退出 → 开关 | 应用菜单「退出桌宠」后记录删除、无桌宠进程、`melo.desktopPet` 变 0，设置行实时变「未运行 / 关闭」 | `settings-row-after-pet-menu-quit.jpg` |
| Melo 退出 → 桌宠退出 | `tell application "Melo" to quit` 后 1 秒内 Melo 与桌宠都结束，记录删除，偏好保持开 | 终端 |
| 重开 Melo → 恢复 | 偏好开时重开，3 秒内桌宠回来 | 终端 |

### 未验证与边界

- 设置页的下拉在后台自动化下改不了值，最终由用户批准屏幕控制后在前台完成了两个方向的真机操作；此前的冷启动用 `defaults write` 置偏好作为等价入口。
- 桌宠右键菜单「退出」与应用菜单「退出桌宠」走同一个 `shutdown()`；真机点的是应用菜单。双击打开对话的路径沿用前轮验收，本轮用应用菜单打开。
- 第一次重开 Melo 时 `StaleServer.lockHolder` 的 `open()` 在主目录锁文件上阻塞约 2 分钟后才继续（采样见终端），与本轮改动无关（发生在桌宠逻辑之前），后续两次重开 3 秒内就绪；未深究，留作观察。
- 旧入口 `~/Desktop/melo桌宠.app` 仍指向原项目与外部 Electron，本轮只在验收前把它启动的桌宠正常停止（SIGTERM），没有删除；同一 profile 单实例，两边不能同时运行。
- CI 没有仓库外媒体：`winter-pack` 两项在 CI 记为显式跳过，本机与发布 gate 照常执行。
