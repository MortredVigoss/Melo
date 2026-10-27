# 桌面版真实多工具测试 · BIGBANG 10-31 · 2026-10-27

用户要求在覆盖安装后的桌面版上测一道需要多次调用工具的长问题，看 Melo 能否"一个回答分段回复"，以及能给多全。测试通过本机 HTTP 接口（与界面相同的 `POST /api/chat/send/stream`）在主 Agent `main` 下新开对话发送，录下全部 SSE 事件；第二段用"继续"续写。模型为 Codex OAuth 的 `gpt-6.1-sol`，无 Tavily / SerpAPI / Jina key，Playwright MCP 已启用。

**题目**：查一下10月31号bigbang演唱会的时候当地天气怎么样，有什么活动，以及第二天有什么活动，再顺便安排一整天的路线规划

## 结论

- **能回答，但分两段才到"大部分"，天气始终缺**：第一段（313 s）只确认了场馆、开演时间和交通限制并给出两天路线；用户发"继续"后第二段（192 s）补上了 10-31 / 11-1 的岩石区万圣节市集（Ghost in The Rocks）。两段都因回合预算耗尽而以 `LIMIT_DELIVERED` 交付，末尾都写"发送'继续'我接着补"。
- **"分段"的形态**：每一轮都是一条消息；界面上先流式出现一段追问文字（第一段 13 s 时："你说的是哪个城市……搜索服务暂时不可用"），工具跑完后被最终回复取代（`desktop-ui/app.js` 把工具调用前的文字当作 narration）。不是多条消息拼成一个回答。
- **缺的东西都不是模型不会，而是工具链在装好的桌面版里缺腿**：`web_search` 三次全败、Playwright 浏览器授权超时、页面内容截断、回合预算 40 万输入 token。详见「根因」。

## 两段回复对照用户要的完整答案

真值来源：Transport for NSW 活动页、BOM 官方 App 接口（`api.weather.bom.gov.au`，10-27 07:41 UTC 发布）、The Rocks 官网、Sculpture by the Sea 官网、公开搜索结果（Luna Park Halloscream、Sydney Open）。

| 用户要的 | 真值 | 第一段 | 第二段（继续） |
| --- | --- | --- | --- |
| 在悉尼 | Accor Stadium，Sydney Olympic Park，10-31 周六，17:00 开门 | ✅ 全对，附来源 | ✅ |
| 当天天气 | 18–26 °C，70 % 降雨（2–9 mm），可能雷暴，西北风转南/东南风 | ❌ "暂时没有取得可核实的预报" | ❌ 仍缺（BOM 页面是 JS 渲染，只抓到导航） |
| 万圣节活动 | Luna Park Halloscream、Ghost in The Rocks（岩石区万圣节市集）、游船派对、鬼屋导览 | ❌ 只提"是万圣节，未核实" | ◐ Ghost in The Rocks 市集 10-31 / 11-1 10:00–22:00、Poliakov Haunted Woods；缺 Halloscream |
| 第二天活动 | Sydney Open（10:00–15:30）、海边雕塑展（官网：至 11-2） | ❌ 两项都"未核实展期" | ◐ 岩石区市集 ✅；雕塑展仍"未取得展期"；缺 Sydney Open |
| 天气穿搭 | 需按 70 % 降雨 + 雷暴给出雨具/分层 | △ 泛泛的"分层穿搭、舒适鞋、雨衣看预报" | △ 同上（"轻便外套、舒适鞋及雨衣"），没有天气依据，碰巧合适 |
| 交通选择 | 6.5 万人、无活动专线巴士、铁路施工市区列车只到 Lidcombe | ✅ 全对，还给了行程规划器链接 | ✅ |
| 一整天路线 | — | ✅ 10-31、11-1 两天逐小时 | ✅ 两天逐小时，11-1 改为 Bondi → 海岸步道 → 岩石区市集 |
| 完成度自评 | — | partial，5 项需求 2 项 met | partial，5 项需求 4 项 met，天气 unavailable |

## 两段运行数据

| | 第一段 | 第二段（继续） |
| --- | --- | --- |
| 时间 | 18:58:22–19:03:34（313 s） | 19:05:55–19:09:07（192 s） |
| 模型调用 | 14 次 | 8 次 |
| 工具轮次 / 调用 | 8 轮 / 18 次 | 6 轮 / 19 次 |
| 工具明细 | web_search 1（403 败）、fetch_url 15（13 成功、1 无正文、1 404）、search_history 1、playwright browser_navigate 1（授权 120 s 超时） | web_search 2（都 403 败）、fetch_url 16、bash 1（python heredoc 被安全门硬拒，正确） |
| 结束原因 | `budget:exhausted` 输入 token 307 882 / 400 000（239 s）→ `limit:delivery` | 同上 327 813 / 400 000（139 s）→ `limit:delivery` |
| 回复 | 2 572 字，1 个文本块 | 3 233 字，1 个文本块 |
| 中途流式文字 | 13.4–21.0 s 流出 252 字追问（"你说的是哪个城市……"），`goal-check` 判定未完成后继续跑工具 | 无 |

授权：第一段 97 s 时 `mcp:playwright:browser_navigate`（BOM 逐小时预报页）弹出授权，无人点击 120 s 后超时。之后我挂了只放行只读浏览器工具、每次"仅本次"的自动批准器以模拟在场用户，但两段里没有再出现授权请求，没有任何批准发生（`permission-approvals.log` 不存在）。

## 根因（都在平台，不在模型）

1. **桌面壳给服务的 PATH 没有 node**：`desktop-app/main.swift` 写死 `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`，node 来自 nvm，这些目录里没有 `node` / `npx`（`env -i PATH=… command -v npx` → not found）。`web_search` 的 Playwright/Google 腿靠 `npx -y @playwright/cli@0.1.11 --version` 探活（`src/web/playwrightFetcher.js:184`），在装好的桌面版里永远不可用，SERP 只剩 Jina→DuckDuckGo 一条腿（`raceSerpProviders` 的 degenerate 分支）。修法：把解析出的 node 所在目录加进 PATH；需要重编译壳、用户再点一次"桌面"文件夹权限。
2. **Jina 匿名访问 DuckDuckGo 被限流**：三次 `web_search` 都是 `Jina/DDG returned 403`，原文 `AbuseAlleviationError: Anonymous access to domain lite.duckduckgo.com blocked until 09:02 UTC`。没有 Jina / Tavily / SerpAPI key 时这条腿随时会断。
3. **MCP 工具授权在无人值守时直接吃掉 120 s 并丢掉工具**（`src/tools/permissions.js` `PERMISSION_TIMEOUT_MS`）。界面里用户点一下就过；接口/自动化场景没有人点。
4. **回合预算 40 万输入 token**（`src/runtime/runBudget.js` `DEFAULT_RUN_MAX_INPUT_TOKENS`）：抓 15 个页面后每次模型调用都带着全部上下文，第 9 轮就耗尽；续写轮带着上一轮历史，第 8 次调用就耗尽。这是两段都 `LIMIT_DELIVERED` 的直接原因。
5. **页面内容上限 6 000 字**（`src/services/search/searchLimits.js` `contentMaxChars`）：海边雕塑展官网的"NOW ON until 2 November 2026"在页面 markdown 第 6 844 字，auto 模式读不到；第二段用 direct 模式（上限 20 000）也没把展期写出来，模型实际收到的正文没有留档（`toolResults` 只存摘要），无法进一步定位。
6. **BOM 页面是 JS 渲染**：`fetch_url` 三种模式都只拿到导航。`web_search` 里有 wttr.in 天气快路（`fetchWeatherFastPath`），但只在带天气词的 `web_search` 里触发，而模型在第一次搜索失败后再没用过 `web_search` 查天气。BOM 的公开 App 接口（`api.weather.bom.gov.au/v1/locations/r3gx2f/forecasts/daily`，9 天）一次就拿到真值，是天气能力的候选来源。

后续（当晚）：根因 1 已修——node 目录置于服务 PATH 首位，第三次 `release:verify` 17 项全绿覆盖安装（[安装回执](overwrite-install-20261027.md)）。装后实测 Playwright 腿真的跑了，但 Google 给无头浏览器返回"异常流量"验证页，Jina 匿名 DuckDuckGo 仍 403：无 key 时 `web_search` 仍无结果，下一步是配 Tavily / SerpAPI / Jina key 或换搜索引擎。

## 证据

- `.tmp/desktop-install-20261027/live-test/`：`events.jsonl`、`console.log`、`run.out`、`reply.md`、`done.json`、`chat.json`、`exit.txt`；续写轮在 `continue-1/` 同名文件；`reference/`（BOM 接口原始 JSON、Transport NSW 与雕塑展页面 markdown）；测试脚本 `melo-live-test.mjs`、`analyze-live-test.mjs`、`approve-readonly-browser.sh`。
- 执行场景：`.tmp/melo-home-user/desktop/execution-scenes/5b537c7c5b1e2d75629548baafadfc07.json`（第一段）、`69600597255bcc2e734897fdc94c50c9.json`（第二段）。
- 搜索链路日志：`.tmp/melo-home-user/desktop/web-search-debug.log`、`search-trail-log/2026-10-27.jsonl`。
- 对话本身留在桌面版里（对话 `c9379adc-3aa9-4644-83db-791431ccd3bd`），可直接在界面查看。
