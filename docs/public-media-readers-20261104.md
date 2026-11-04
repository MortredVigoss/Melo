# 公开社交与视频作品读取

基准 `5399cce`。本轮授权沿用免登录、只读和默认可用的方式，按 `src/media/urlDetector.js` 的平台范围补齐 Instagram、YouTube、Vimeo、哔哩哔哩、TikTok、X、Facebook、微博、腾讯视频、快手/Kwai。小红书、抖音沿用已有实现。

检索从聊天目标和能力范围进入 shared/agent/search 的 planRequest，再经 prepareNode、申请 Agent 已获准的 MCP 工具或 web_search/fetch_url，按站点找作品、读取原链接并把来源和阅读程度交还目标检查。默认增加的是本地服务授权。既有联网限制、委派交集、关闭后的设置均需保留。仅将作者文字、描述或返回的字幕作为对应类型的证据。登录页、失效链接、只有标题及查无字幕需独立处理。桌面高级设置显示实际登记目录。手机同步共享计划和 Agent 默认设置，平台执行验收以桌面为界。

验证覆盖 URL 与平台身份、来源绑定、网页与 MCP 两条生产入口、搜索和联网限制、一次性迁移、取消、错误和真实公开作品。跟踪到平台公开响应、工具回执、数据保存与远端推送，不进入私密内容、账号授权或视频发布流程。

## 桌面验收

在空白浏览器或本机无账号 HTTP 客户端读取公开作品，按目标作品 ID 验证。以下是本次样本的实际范围。

| 平台 | 实际读到的内容 |
| --- | --- |
| Instagram | 作者文字，986 字符。[公开样本](https://www.instagram.com/p/DayIkFmDwlb/) |
| YouTube | 公开字幕，2003 字符。[公开样本](https://www.youtube.com/watch?v=6o3m9Bw67Os) |
| TikTok | 作者文字，112 字符。[公开样本](https://www.tiktok.com/@patroxofficial/video/6742501081818877190) |
| X | 作者文字，24 字符。[公开样本](https://x.com/jack/status/20) |
| Vimeo | 作品简介，322 字符。[公开样本](https://vimeo.com/729728070) |
| 哔哩哔哩 | 作品简介，250 字符。[公开样本](https://www.bilibili.com/video/BV1e6JwzaEkq/) |
| 微博 | 微博正文，51 字符。[公开样本](https://weibo.com/2/detail/5340436731265687) |
| 快手 | 作者文字，49 字符。[公开样本](https://v.kuaishou.com/EmQYEu) |
| 腾讯视频 | 作品标题，35 字符。[公开样本](https://v.qq.com/x/page/n35636p6ba6.html) |
| Facebook | 两条样本均未取得正文，官方嵌入页提示作品不可用或没有访问权限。[公开样本](https://www.facebook.com/FacebookDevelopers/videos/10152454700553561/) |

YouTube 字幕轨道返回 200 空正文时，尝试官方播放页的字幕面板。Instagram 使用空白浏览器的官方嵌入页。快手短链核对移动页 `share_info.photoId`，腾讯标题始终为 snippet。Facebook 的匹配视频/相邻推荐/访客壳由回归区分；本次没有取得真人账号或授权帖子。来源区分工具实测、模型调用与上游访问限制。

桌面运行实例真实登记两个 MCP 工具。6 个现有 Agent 均通过服务器白名单和联网权限检查；升级仅增补新增服务，不恢复旧服务的撤销。启用前保留 APFS 备份，启用后 24 段聊天、734 条消息及其附件引用、资料和配置与备份一致。隔离真实模型用 fetch_url 读取 NASA 的 Instagram 原帖，正确回答 Nancy Grace Roman Space Telescope，执行场景 completed；MCP 握手、目录和实际读页单独验证。手机独立 MCP 执行、实体设备安装与受限内容不在本次验收内。

执行入口为 shared/agent/search.js → src/mcp/manager.js → publicMediaServer.js → publicPlatformIndex.js / publicMediaReader.js；网页工具复用同一读取器。浏览器截图不作为正文。工具与状态回执见本地 `.tmp/platform-readers/`。

站外索引在同一网络曾返回限流页，不能保证任意关键词都有候选。最终版实测 YouTube 原站搜索「NASA Roman telescope」返回 6 条并成功读到作品简介；Instagram 明确指定 `@nasa` 时，从访客主页取得 6 条并成功打开作者文字。指定账号的结果只取该账号展示的作品。两条均经真实 MCP 协议调用，见 `.tmp/platform-readers/search-to-post.json`。桌面实际高级页也已核对两个已连接工具。
