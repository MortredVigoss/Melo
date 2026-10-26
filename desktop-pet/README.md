# Melo 桌宠（desktop-pet）

以 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) v0.3.7（commit `90ddd827fd9661958752855e899da452063ceaa5`，MIT）的原始蓝发女仆实现为基础，默认皮肤「大肥鱼」，另有重绘的「金冬天」皮肤，并把对话直通 Melo 主助手。它随 `Melo.app` 一起分发，由 Melo 管理启停。

- 系统设置 → 通用与外观 → 「桌面宠物」：开启后立即启动，并在以后 Melo 启动时自动带起；关闭则通过桌宠控制服务 `/quit` 正常退出。Melo 退出时桌宠一起退出；桌宠自己右键「退出」后，设置里的开关同步变为关闭。
- 右键人物 → **切换皮肤** → **大肥鱼 / 金冬天**；双击或右键 → **与 Melo 对话**。关闭按钮或 Esc 收起窗口。
- 对话使用 Melo 的主助手、当前账号和工具；用户原话一字不改地透传，不加人设。Melo 启动桌宠时通过 `MELO_BASE_URL` 传入自己的实际端口。
- 本机数据位于 `~/Library/Application Support/melo-desktop-pet-dsh`（皮肤选择、位置、尺寸、对话记录），升级 Melo 不会重置。`runtime.json`（0600）记录控制进程号、控制地址与口令，Melo 用它判断运行状态并发退出指令；桌宠退出时删除。

## 目录

| 位置 | 内容 |
| --- | --- |
| `main.cjs` | 控制进程：单实例、聊天窗口、本机控制服务（随机口令，`/open-chat`、`/chat`、`/quit`、`/health`）、派生原版 DSH host。 |
| `melo-client.cjs` / `dialog/` | Melo 主助手流式对话、工具与审批显示。 |
| `control-server.cjs` / `runtime-info.cjs` | 控制服务与运行记录文件。 |
| `adapters/` | `host-entry.ts` 调用原版 host；`skin-store.ts` 皮肤选择与金冬天包自动升级（只保留最近一份备份）。`skin-store.cjs` 为构建产物。 |
| `upstream/` | 原项目全部源码与说明；`LICENSE`、`UPSTREAM-README.md` 必须保留。`lib/melo-host.mjs`、`runtime/electron-helper/shared-core.js` 由 `npm run build` 生成并提交。 |
| `skins/winter/` | 金冬天包契约：`manifest.json`（版本与每段 sha256）、`winter-config.json`。动画文件不入 Git。 |
| `assets.lock.json` | 仓库外媒体的校验记录（关键帧审计、大肥鱼原版动画）。 |
| `tests/` | 桥接、控制服务、运行记录、皮肤存储与金冬天包回归；由 Melo 的 `npm test` 选组和 `npm run test:full` 自动发现。 |

## 大文件与运行时（不入 Git）

- 金冬天 WebM（约 364MB）、关键帧审计（约 320MB）与大肥鱼原版 WebM（约 52MB）放在仓库旁的固定目录 `../desktop-pet-assets`（可用 `MELO_PET_ASSETS_DIR` 覆盖）。在 Melo 仓库根目录运行 `npm run import:pet-skin`（必须先设置 `MELO_PET_SOURCE_DIR`，或加 `-- --from <目录>`；不再猜测个人电脑上的素材目录）：校验源包与其 manifest 一致后复制进该目录，更新 `skins/winter/manifest.json`、`winter-config.json` 和 `assets.lock.json`，并把 `skins/winter/winter-animation`、`upstream/assets/webm` 链接到该目录。皮肤包重建后再跑一次即可；`npm run verify:pet-skin` 校验当前状态。
- Electron 由 `package.json` 钉版本：`npm run install:desktop-pet` 安装到 `desktop-pet/node_modules`。
- `npm run build:desktop` 调用 `scripts/bundle-desktop-pet.js`：校验媒体、重建 host 产物，把代码、生产依赖、两套皮肤和带桌宠身份的 `runtime/DSHPet.app`（ad-hoc 签名）装进 `Melo.app/Contents/Resources/desktop-pet/`，再由 Melo 的外层签名覆盖。
- 素材生产线（`animation-work-v3/`、超分与插帧工具、证据）留在原项目，不在本仓库。

## 开发

在本目录 `npm run build` 重新生成 host、shared core 与皮肤存储适配层；`npm test` 运行本目录测试。金冬天包与关键帧审计缺失时 `winter-pack` 测试在本机直接失败（需先导入）；只有 CI 环境（没有这些媒体）记为显式跳过。
