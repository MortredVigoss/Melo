# Brave Search 与任务重试修复 — Android 0.7.1

产品代码 `4b88385`，分支 `codex/mobile-use-features`。[脱敏回执](evidence/brave-search-config-20261019.json)。只做本地提交，未 push。

## 两个独立原因

第一轮原生执行卡在 10-19 00:21:22 显示 blocked / SEARCH_UNAVAILABLE、0 Tool / 0 source。设置虽已选择 Brave，HTTP Search 开关仍关闭，请求没有发到 Search API。之前填写说明遗漏开关，已向用户更正；开关后来由用户自行开启并保存。

用户另开对话后，最新 00:25:31 的“再试一次”却为 none / conversation / tools=[]，正常回复被记 completed，但完全没有工具。此时已复核保存的 HTTP 开关为 true、Brave/default Endpoint 正确。根因是 Router 只分类最新短句，丢失此前“检索 brunch 并导航”的任务；旧 assistant 声称没有工具的内容又进入普通回答上下文。这轮没有发 HTTP，不能归因于 Brave Key 或网络。

## 修复范围

显式 retry/resume 从最近具体 user task 续接，并带上中间重试追加的限制，再按本轮真实权限/配置选择工具。保留较早 App 上下文；新话题或取消形成边界，assistant 文本不授予能力；最多回看 8 条 user 消息、拼接范围 12,000 字符。当前轮明确“不导航/不操作手机”会收窄工具，不能继承旧请求去启动 Maps。“不联网/不上网”也进入共享网络限制。

共同逻辑在 shared/agent，Node 与 Android 共用；给模型明确说明过去的能力缺失声明不是当前能力状态。Android 的不可用提示补上开启 HTTP Search 并保存的步骤。仍是有界关键词 Router，不将本次修复称为完整语义任务规划或三端全部统一。

## 验证

- 初始 12 项续接回归有 8 项失败；补充 App 上下文断言又暴露第一版修复丢失前置上下文，最终 13 项续接测试全过。153 Node 定向 tests、117 JVM、Lint 零 Error、Debug / R8 / test APK 构建通过。
- 49 同源 Conformance Fixtures。Android 16 Emulator 外屏 968×2376 18 项、展开 1856×2160 10 项，最终共 28 次执行通过，包含实际 JavaScriptEngine、三协议 HTTP Fixture、Brave GET/Header、旧失败后更换有效配置再重试、执行卡与 Markdown。首轮命令测试类名写错，已更正；初始化失败日志保留，没有跳过行为断言。
- 同证书 R8 Preview 0.7.1 (16) 已覆盖 Fold6 / Android 16 / One UI property 80500；实际 APK hash 与交付相同。原 16 Chat / 1 角色、UID / 首次安装历史及两项 Accessibility 设置保留，无当前进程 Fatal；未卸载或清数据，ADB 5037 全程直接复用。自有 Emulator / 5048 已关闭。
- 在用户原 brunch Chat 做一次受限 live retry：只检索一次、列来源、明确不导航/不操作手机。记录为 http-search / completed，实际 web_search 1 次（Tool 1317ms）、fetch_url 1 次（204ms），5 个来源、已读 1 页、3 次模型请求（9408 / 6580 / 13932ms），0 次 phone_use。未新增 QA Chat；App 使用现有设备凭证，调试工具没有读取 Key。单次结果不作为 Provider benchmark 或餐厅排名准确性证明。

## 交付与边界

本会话 outputs/Melo-Android-0.7.1-preview.apk，4,077,127 bytes；APK SHA-256 `95439d3f60e8a06e50f3625548220fa0633a5e966c4c036e544b0a72291298b3`。证书与旧 Preview 相同，签名及四 ABI ZIP / ELF 16 KiB alignment 通过。Core 83,946 bytes，SHA-256 `1f443dd5f0522d806b29068aa3a76e225ab3bcea99c38608b794dbf9acd53823`。

最终手机停在原 Chat 的新执行记录。历史失败卡保留，不回填或重写成成功。真实推荐比较/评分、Maps 导航、外屏与姿态切换未在本次复验；静态抓取不保证动态页面和营业状态。iOS 仅相同 bundle，原生 Swift/生产入口未验。整个 repo release gate / 远端 CI / git pp / push 未运行。
