# 实时语音对话系统：方案与评分

日期：2026-11-16（Australia/Melbourne）。**用户已选定：方案 A（级联全双工），桌面与 iPhone 一起交付。** 依据：master `f75f139a` 的源码与功能地图 `architecture/modules.json` 的 `voice` 功能，以及当天核对的外部接口文档（第 8 节）。第 9 节是动工前写下的执行链路、审计边界与停止条件（规范 §3）。

## 1. 需求理解

"实时语音对话"指：点一下进入通话，之后不用再按键。Melo 听你说完自动回答并读出来；它读的时候你可以直接开口打断，它停下来听你；一直到你挂断。每一轮照常落在当前聊天里。

## 2. 现状（按代码核对）

| 已有 | 位置 | 与通话的关系 |
| --- | --- | --- |
| 听写：点一下开始 / 停止，转写进输入框，**不自动发送**，最长 60 秒 | `desktop-ui/voiceInput.js` + 壳 `desktop-app/main.swift` 的 `meloVoice` 桥 → `ios/Melo/VoiceInput.swift`、`SystemSpeechInput.swift`（Mac 与 iPhone 共用，SFSpeechRecognizer） | 识别引擎可复用；它是单次听写，没有连续收音、"说完了"判断和回声消除 |
| 朗读：MiniMax / Edge / OpenAI 兼容 / 本机声音包 / macOS say / 浏览器；回复流式按句排队；每个 Agent 有自己的音色与"语音回复模式（概要 / 全文 / 关闭）" | `src/tts.js`、`src/http/ttsRoutes.js`、`src/services/media/agentVoice.js`、`voiceRewrite.js`；`desktop-ui/app.js` 的 `_streamTts*`、`speakAgentVoice` | 合成与按句流式可复用；但多数引擎在 Node 里用 `afplay` 播放，原生壳拿不到这段声音做回声参考，开口打断时麦克风会听到 Melo 自己 |
| 用语音发的消息，回复自动读一次 | `app.js` 的 `_oneTimeAutoSpeak` | 一次性，不循环 |
| 级联语音管线：能量 VAD、插话即停、短回复提示 | `src/services/remote/discordVoiceSession.js`、`src/services/media/discordVoiceAudio.js`（Discord 已归档，不运行） | 可参考：句级合成、插话即停、`VOICE_MODE_SYSTEM_SUFFIX` |
| 补充到正在进行的回复 | `POST /api/chat/supplement`（`src/http/chatRoutes.js`） | 回复还在生成时的插话可作为补充，不必另起一轮 |
| GPT-Live 设计稿（10-08，未实现） | `docs/voice-and-multi-model-plan.md` §7 | 方案 B 按今天的官方文档复核了它 |
| 手机：iPhone 听写 + 系统朗读；Android 桌宠双击语音 → 专用对话 → 朗读 | `ios/Melo/ContentView.swift`、`SpeechText.swift`；`android/.../pet/PetSpeechInput.kt` | 都是单次交互 |

缺的部分：连续收音与端点判断、回声消除与开口打断、通话状态机与界面、语音轮的口语化回答约束、工具执行与审批时的语音反馈、资源释放。

## 3. 方案总览与评分

0–10 分。权重：实时感 30%、保留 Melo 能力 25%、账号与费用 15%、实现风险与工作量 15%、跨端扩展 10%、隐私 5%。延迟都是估算，未实测。

| 维度 | A 级联全双工（推荐） | B GPT-Live + Melo 委派 | C 双引擎（A 默认，B 可选） |
| --- | --- | --- | --- |
| 实时感 | 6.5：简单问题约 2–5 秒开口，可开口打断 | 9.5：闲聊亚秒级，边听边说 | 9（有 GPT-Live Key）/ 6.5（没有） |
| 保留 Melo 能力 | 10：每一轮都走所选模型与完整 Agent（工具、记忆、审批、团队、人设、音色） | 6：闲聊由 gpt-live-1 自己答，不经 Melo 记忆和工具；Agent 音色用不上；委派结果每次最多 500 token | 9 |
| 账号与费用 | 10：现有 ChatGPT 登录可用，无新增费用 | 4：要另有开通 gpt-live-1 的 OpenAI 项目 API Key；$0.05 / 分钟 + 委派模型费用；ChatGPT 登录不能用 | 8 |
| 风险与工作量 | 7：中等；难点是 Mac 外放时的回声消除和端点判断 | 5：中等；新接口，委派事件不带用户原话要从转写重建，中文支持官方未列明 | 4：最大，两套引擎都要做、测、长期维护 |
| 跨端扩展 | 8：iPhone / Android 都有原生识别、朗读与回声消除 | 5：手机要 WebRTC 库或可信会话服务器保管 Key | 6 |
| 隐私 | 8：识别优先端上；文字只发给你已选的模型 | 6：全部通话音频发给 OpenAI | 7 |
| **加权总分** | **8.2** | **6.5** | **7.7** |

## 4. 各方案

### 方案 A：级联全双工（推荐）

桌面链路：麦克风 → 原生壳新 `VoiceCall`（AVAudioEngine 开启 voice processing：回声消除与降噪）→ 识别（macOS 26 用 SpeechAnalyzer 端上低延迟识别；旧系统或不支持的语言回退 SFSpeechRecognizer，能端上就端上）→ 端点判断（转写稳定且静音约 0.8 秒，可调）→ `melo-voice-call` 事件 → `desktop-ui/features/voiceCall/` 状态机 → 现有发送管线 `handleSendMessage` → `/api/chat/send/stream`（新增可选 `voiceTurn: true`）→ 服务端给这一轮加口语化约束（先说结论、三句以内、不读 Markdown 和链接，长内容说"详细放在聊天里"）→ 回复流式按句 → 现有合成（用该 Agent 的音色）→ 音频交回原生壳，在同一个音频引擎里播放（回声消除才有参考信号）→ 播放中检测到你开口 → 立即停播、中止在途合成 → 继续听。

要点：

- 打断：开口即停播。回复还在生成时，你说的话作为补充进入当前回复（复用 `/api/chat/supplement`）；说"停 / 算了"或点停止才取消这次回复。（默认值，可改）
- 工具与审批：进入工具执行时先说一句"我查一下"之类的占位；需要审批时语音提示"请在屏幕上确认"，**不接受语音批准**。
- macOS 系统声音在通话中改用 AVSpeechSynthesizer 渲染进同一音频引擎（`say` 子进程的声音无法做回声参考）。
- 通话中不走"先完整回复再生成概要"（要多一次模型调用，明显变慢），改为本轮直接要求口语化回答；平时的朗读设置不变。
- 现有听写按钮和平时的自动朗读行为不变（功能隔离）。
- 规则同源：语音轮约束文字、断句与朗读过滤规则、打断策略常量放进 `shared/`，iPhone、Android 直接用同一份。

分阶段：A1 桌面通话闭环（连续收音、端点、自动发送、按句朗读、挂断与资源释放）→ A2 回声消除与开口打断、工具 / 审批语音反馈 → A3 iPhone（AVAudioSession `.voiceChat` 自带回声消除）→ A4 Android。A1 与 A2 一次交付，不在 A1 停下。

主要风险：Mac 外放时回声消除的实际效果（不够时退为"播放时关麦、点按打断"的半双工，要真机判断）；SpeechAnalyzer 的中文模型首次要下载，必须运行时检查可用语言并回退；端点太短会截断你的话（"说完后等待"可调）；需要工具的问题仍受模型首字时间和工具耗时限制。

### 方案 B：GPT-Live 语音前端 + Melo 客户端委派

按今天的官方文档：`gpt-live-1` 是全双工语音模型。服务端用项目 API Key 调 `POST /v1/live/sessions`（WebRTC，交换 SDP），会话设 `delegation: {type: "client"}`。需要干活时它发 `session.delegation.created`，**这个事件不带用户原话**，要用 `session.input_transcript.delta` 的转写和聊天上下文自己重建任务，跑 Melo 正常一轮，再用 `session.thinking.append` / `session.commentary.append`（每次最多 500 token）把进度和结果交回去由它说出。打断它说话不会停后台任务，取消由 Melo 自己决定。按秒计费 $0.05 / 分钟，委派模型另计。

桌面链路：页面 WebRTC（RTCPeerConnection + `oai-events` 数据通道；壳要新增 WKWebView 麦克风授权回调）→ Node 新路由用独立的"实时语音连接" Key 建会话 → 委派事件 → 重建任务文本 → `/api/chat/send/stream` → 结果摘要 → commentary 交回播报；全部转写写入当前聊天。

优点：真正实时、边听边说、打断自然。代价：要另开 OpenAI API Key（现有 ChatGPT 登录不行）；闲聊不经 Melo 记忆和工具，人设只能靠会话开始时的指令；Agent 的 MiniMax / 声音包音色用不上；官方没有公布语言清单，只说部分语言可能口音不地道或不够流利，中文需实测；手机端要 WebRTC 库或可信会话服务器保管 Key。

### 方案 C：双引擎

先按 A 做出带"引擎接口"的通话系统（默认级联），再加 GPT-Live 引擎；配置了可用 Key 时在设置里切换。覆盖最全，工作量约为 A 的 1.6–1.8 倍，两套引擎的回归要长期维护；没有 GPT-Live Key 时等于 A 加维护成本。

## 5. 不论选哪个都遵守的设计承诺

- 每一轮都落在当前聊天，作为普通用户 / 助手消息（记忆、历史、手机同步照常）；不新增同步字段（v1 线协议冻结）。
- 审批只在屏幕上点，不接受语音批准；有待确认卡片时暂停播报并提示。
- 资源：挂断、切换对话或 Agent、离开聊天页、窗口隐藏或退出时，麦克风、音频引擎、在途合成请求、WebRTC 轨道与会话全部释放；测试用计数器证明底层操作真的停了。
- 隐私：界面写明识别可能用到 Apple 服务器（端上可用时不用），方案 B 的音频发给 OpenAI；默认不保存录音。
- 设置保留：不改已有的朗读、听写和 Agent 音色配置；新增项都有默认值。
- 设计语言沿用现有暗色神经界面的 token 与组件。

## 6. 验证计划与边界

- 自动化：通话状态机（端点、打断、补充 / 取消、切换上下文即挂断、旧回调不串话）、合成中止计数器、语音轮约束注入、资源释放；新测试接入 `test:tts` / `test:ui` 组，先 `npm run generate:module-map`，再按两档门禁跑。
- 原生：Swift 编译与现有 `VoiceInputTests` 回归；真实麦克风、回声消除、中文识别准确率必须真机实测，需要你在场（系统会弹麦克风 / 语音识别权限）。
- 现状约束：桌面真实数据目录仍是 11-10 受损状态（总览第 2 节），恢复前不启动正式安装版，验收用隔离数据目录；iPhone 个人签名 11-14 已到期，A3 阶段需重新安装。
- 方案 B / C：没有真实 GPT-Live Key 和真实会话之前，界面不显示"已接通"。

## 7. 需要你决定

1. 选哪个方案（A / B / C）。
2. 平台范围：先桌面（推荐，iPhone、Android 按 A3 / A4 跟进），或桌面和 iPhone 一起。
3. （可在动工后再定）打断规则是否用第 4 节 A 的默认。

## 8. 外部依据（2026-11-16 核对）

- [GPT-Live 概览](https://developers.openai.com/api/docs/guides/live)、[委派与工具](https://developers.openai.com/api/docs/guides/live-delegation)、[WebRTC 接入](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=live)、[价格](https://developers.openai.com/api/docs/pricing)
- GPT-Live 语言支持：[mindstudio 说明](https://www.mindstudio.ai/blog/what-is-gpt-live-1-openai-voice-model)、[1.1 更新的语言](https://runtimewire.com/article/openai-gpt-live-1-1-six-languages)（二手来源，中文以实测为准）
- [SpeechAnalyzer 文档](https://developer.apple.com/documentation/speech/speechanalyzer)、[SpeechTranscriber 文档](https://developer.apple.com/documentation/speech/speechtranscriber)、[上线语言（二手来源）](https://blog.addpipe.com/apple-speechanalyzer-api/)

## 9. 执行链路与审计边界（动工前，2026-11-16）

### 9.1 共享规则（三端同源）

`shared/protocol/agent-loop.json` 新增 `voiceTurn` 节（语音轮提示词中英两版、端点 / 打断 / 单句上限时长、占位短句、停止词、朗读字数上限）和 `fixtures.voiceTurn`。桌面读 `shared/agent/loopContract.js`（生成）与新模块 `shared/agent/voiceTurn.js`；iPhone 读 `ios/Melo/AgentLoopContract.swift` 内嵌副本，规则在 `ios/Melo/VoiceTurnRules.swift` 用同一份夹具核对。只增不改已有字段；Android 只多一段数据，不消费。

### 9.2 桌面链路

1. 入口：输入区新增通话按钮（`desktop-ui/features/chat/viewComposer.js`）→ `app.js` 动作分发 → `desktop-ui/features/voiceCall/` 控制器 `start()`：停掉朗读与听写，经 `webkit.messageHandlers.meloVoice` 发 `callStart`（带会话 ID、识别语言、来自契约的时长）。
2. 原生：`desktop-app/main.swift` 的消息处理（只接受本机主框架来源）→ 新 `desktop-app/VoiceCallBridge.swift` → 共用状态机 `ios/Melo/VoiceCall.swift` + 音频实现 `ios/Melo/SystemVoiceCallAudio.swift`（AVAudioEngine 开 voice processing、SFSpeechRecognizer 能端上就端上、能量检测、播放节点）。事件经 `melo-voice-call` 回到页面。共享状态：麦克风与音频引擎、识别任务、解码临时文件（读完即删）。
3. 一句说完 → 页面 `onUtterance`：本对话没有进行中的回复 → `handleSendMessage({ content, chatId, voiceTurn: true, observer })`；有进行中的回复 → 停止词则 `handleStopSending()`，否则 `sendSupplement()`。语音轮不清空输入框草稿、不走 `_streamTts*`（避免和通话朗读重复）。
4. 服务端：`src/http/chatRoutes.js` → `validateChatRequest`（新增 `voiceTurn` 必须为布尔；指纹只在为真时纳入，旧请求指纹不变）→ `sendChatMessage` → `executeChatTurn` → `runChatAgentExecutionGraph`（`turn.voiceTurn`）→ `prepareNode` 追加 `voice-turn` 本轮段（placement `turn`，随本轮用户消息，不破坏系统提示缓存）。其余执行、工具、审批、落盘不变。
5. 回复事件：`tool_calls_start` → 本轮第一次说占位短句；`tool_permission` / `capability_request` → 说"请在屏幕上确认"；`reply_text`（final）→ `POST /api/voice-call/speech-plan`（服务端按 `voiceCallSpeech` 得到要读的句子与引擎）→ 逐句 `POST /api/voice-call/speech` 合成（该 Agent 的音色；请求断开即中止合成）→ `callPlay` 交原生播放；系统声音走 `callSpeak`，由原生 AVSpeechSynthesizer 渲染进同一引擎。
6. 打断：原生在播放中检测到用户开口（回声消除后能量持续超阈值，或非回声的识别文字）→ 立即停播 → `bargeIn` → 页面中止在途合成请求、丢弃待播句子。
7. 结束：挂断、切换对话或 Agent、离开聊天页、页面隐藏、页面卸载、原生错误 → `callEnd`，原生停引擎、移除 tap、取消识别、停合成；页面中止全部请求。

### 9.3 iPhone 链路

`ContentView` 通话按钮 → 新 `ios/Melo/VoiceCallController.swift`（`ObservableObject`）→ 同一个 `VoiceCall` + `SystemVoiceCallAudio`（AVAudioSession `.playAndRecord` / `.voiceChat`）→ 一句说完 → `ChatStore.send(…, voiceTurn: true)`（`startReply` 把语音轮提示放进 `turnParts`，与桌面同一段文字）或 `supplement` / `cancel` → 回复保存后（`sendingChats` 变化 + 最后一条助手消息）→ `VoiceTurnRules.speech` → AVSpeechSynthesizer 渲染进引擎播放。`pendingDeviceAction` / `pendingCapabilityRequest` 出现时说确认短句。通话期间 `LocalDeviceServices` 的自动朗读对该对话不再触发；听写与通话互斥。切换对话、打开历史 / 设置 / 任务空间、进入后台或离开页面即挂断。

### 9.4 审计边界与停止条件

- (a) 共享状态：`chatState`（sending、composer、supplements）、`_streamTts`、服务端 TTS 中止表 `_ttsActiveControllers`、原生音频引擎；iPhone `ChatStore` 的 `sendingChats` / `replyDrafts` / 补充队列、`LocalDeviceServices`、AVAudioSession。
- (b) 异常：新路由只返回 4xx/5xx JSON，不改 `streamApi` 错误形态；语音轮失败时页面不改输入框，由通话面板提示；原生错误只经事件上报，不抛到 WebKit。
- (c) 契约：`agent-loop.json` 只新增 `voiceTurn` 与夹具；`/api/chat/send/stream` 只新增可选字段；不改同步 v1 线协议、不新增消息字段。
- 停止条件：服务端追到 `prepareNode` 产出提示段为止（之后的模型调用、工具、落盘逻辑未改，由既有回归覆盖）；TTS 追到 `synthesizeSpeech` / `_synthesizeWithRecovery` 调用为止（提供方内部未改）；原生追到 AVFoundation / Speech 接口为止（系统框架，只能真机验收）；iPhone 追到 `ChatStore.startReply` 的 `turnParts` 与完成钩子为止（`AgentLoop` 未改）。

### 9.5 覆盖 / 未覆盖（动工前计划，完成后按实际更新）

- 覆盖：上述所有新增与改动文件；`requestContract` 校验与指纹、`prepareNode` 段注入、两个新路由（含断开即中止的计数器测试）、页面会话编排（发送 / 补充 / 停止词 / 占位 / 打断 / 挂断与资源释放）、Swift 状态机（端点、打断、回声过滤、旧回调、限时）与规则夹具。
- 未覆盖及原因：真实麦克风、回声消除效果、识别准确率、iPhone 实机音频会话（需真机与用户在场）；真实模型回复的口语化程度（需真实模型）；SpeechAnalyzer 路径（视编译与时间情况决定是否本次落地，见最终记录）。

## 10. 实施记录（2026-11-16）

### 10.1 做了什么

- 共享规则：`shared/protocol/agent-loop.json` 新增 `voiceTurn` 节和 30 条夹具；桌面 `shared/agent/voiceTurn.js`，iPhone `ios/Melo/VoiceTurnRules.swift`，两端跑同一份夹具，输出逐字一致。
- 通话引擎（Mac 与 iPhone 共用一份 Swift）：`ios/Melo/VoiceCall.swift` 管轮流说话（端点判断、开口打断、回声文字过滤、半双工、静音、自动恢复、挂断）；`ios/Melo/SystemVoiceCallAudio.swift` 管音频：同一个 AVAudioEngine，输入开 voice processing，播放也走这个引擎；SFSpeechRecognizer 在支持端上识别的语言里只用端上；系统声音用 AVSpeechSynthesizer 渲染进引擎；解码用的临时文件读完即删；音频设备变化时重建一次，10 秒内超过 3 次就挂断。
- 桌面：`desktop-app/VoiceCallBridge.swift` 接 `main.swift`（只接受 Melo 自己页面的主框架；开始通话先停掉听写和朗读；页面重载、网页进程崩溃、应用退出都会挂断）。页面编排在 `desktop-ui/voiceCall.js`，接入聊天控制器：语音轮带 `voiceTurn`，不动输入框里已打的草稿，不走平时的朗读；通话中打字发的消息、补充和补充续发也由通话读出。输入区加了通话按钮和面板；已安装的旧桌面壳 5 秒内没有回应时，面板提示更新 Melo。
- 服务端：请求字段 `voiceTurn`（只接受布尔；只有为真时进请求指纹，已有请求的指纹不变）→ 执行图 → prepare 节点追加本轮段，Agent 卡片的说话风格一起带上。新路由 `/api/voice-call/speech-plan`、`/api/voice-call/speech`：页面放弃某句时，那句的合成随请求一起中止。
- 顺带修正（同一函数）：被中止的合成以前会被当成声音包故障，触发本机声音包重启，平时朗读的停止和清队列也会碰到；现在不会。
- iPhone：`ios/Melo/VoiceCallController.swift` 接 `ChatStore.send(…, voiceTurn:)`、`supplement`、`cancel`；回复一保存就在通话引擎里读出；工具执行和等待确认时各说一次占位短句。`ContentView` 加通话按钮和面板；通话期间平时的自动朗读不触发；切换对话、打开历史或设置、进入后台、离开页面都会挂断。
- 五语界面词条 26 条；Mac 与 iPhone 的麦克风、语音识别权限说明写明用于通话。

### 10.2 与方案的差异

- 没有接 SpeechAnalyzer。识别用 SFSpeechRecognizer，支持端上识别的语言强制端上。原因：SpeechAnalyzer 的语言模型首次要下载，运行时行为在本机无法验证；先用听写里已经验证过的引擎，需要时再单独接。
- 桌面窗口被遮挡或最小化时通话不挂断，用户可以边做别的事边说；只在页面卸载时挂断。iPhone 任务空间在回复用到工具时会自动弹出，通话在它下面继续，不挂断。
- iPhone 的 Agent 资料没有"说话风格"字段，所以手机的语音轮提示不带风格行；手机只用系统声音朗读，和平时一样。
- 桌面的占位短句（"我查一下。"）用系统声音说，正式回答才用该 Agent 的服务端音色。
- 通话读的是核对后的最终回答，和平时朗读同一规则，不边生成边读。

### 10.3 覆盖 / 未覆盖

- 覆盖（读过并纳入审计）：`src/http/chatRoutes.js` 发送路由；`requestContract.js`、`sendChatMessage.js`（`sendChatMessage`、`executeChatTurn`）、`chatExecutionRunner.js`、`execution/prepareNode.js`（段落与 `speech_policy`）、`shared/agent/contextBudget.js`（本轮段放置规则）；`src/http/ttsRoutes.js` 全部路由与中止表、`src/tts.js`、`src/services/tts/edgeTts.js`（中止即杀子进程）、`src/services/media/agentVoice.js`、`voiceRewrite.js`、`src/shared/localServices.js`；`src/server.js` 共享模块映射；`desktop-ui/app.js` 的朗读、`applyBootstrap`、事件监听；聊天功能的 `controller.js`、`viewComposer.js`、`state.js`、`context.js`、`api.js`、`index.js`；`replyDelivery.js`、`voiceInput.js`、`i18n.js` 与两端翻译门禁；`desktop-app/main.swift`、`scripts/build-desktop-app.sh`；iPhone 的 `VoiceInput.swift`、`SystemSpeechInput.swift`、`SpeechText.swift`、`ChatStore.swift`（发送、本轮材料、补充、取消、补充续发、完成）、`LocalSettingsView.swift`、`ContentView.swift`、`AgentLoopContract.swift`；`ios/scripts/test.py`、`generate-project.py`、`scripts/build-agent-core.mjs`、`generate-agent-loop-contract.js`、`test-discovery.js`、功能地图注解。
- 未覆盖及原因：模型提供方内部（`src/openai.js`、`src/providers/*`）、`invokeModelNode` / `finalizeNode`、iPhone `AgentLoop.swift`：没有改，语音轮只多一段本轮材料，由既有回归覆盖；Android：不在本次平台范围，只多一段契约数据（核心包已重建）；真实麦克风、回声消除效果、识别准确率、iPhone 实机音频会话与蓝牙路由：需要真机和用户在场；已安装桌面应用里的实际表现：桌面壳要重编并覆盖安装（须用户授权）；Telegram / Discord 的归档语音：没有动。

### 10.4 验证

- 门禁：快速档因改到共享契约与公共边界扩为全量，`run-AosjeK` 全绿：JS 5,201 项（0 失败、0 跳过）、Android JVM / Lint / Debug / Release、Swift 编译与全部 41 组、共享渲染预检、设置浏览器验收，用时 239 秒；之后面板提示的修正单独跑快速档 `run-pUhuXa`（347 项全过）。
- Swift：`VoiceCallTests`（端点、打断、回声过滤、半双工、静音、失败恢复、挂断、能量检测、时长，以及与桌面相同的 30 条夹具）在门禁里实际运行；iPhone 模拟器整包编译通过（`xcodebuild -target Melo -sdk iphonesimulator`）；桌面壳用 `build-desktop-app.sh` 的同一组源文件编译通过。
- 修复类测试都在去掉修复后确认会红：被中止的合成不重启声音包、prepare 节点注入语音轮段、新一轮清掉上一轮的读出失败提示。
- 未执行：真实麦克风、回声消除、识别准确率、iPhone 实机音频会话、真实模型回复（需要真机与用户在场）；桌面壳重编覆盖安装（`npm run release:verify`）与手机重装（签名 11-14 已到期），都要用户授权（当晚已完成，见第 11 节）。集成档在合并 / 推送前另跑，本次只在本地提交（`adbb6145`）。

## 11. 覆盖安装（2026-11-16 晚）

用户说"装到两端"后执行。装的是本机提交 `adbb6145`（通话功能）加版本号提交 `2fff53bd`，**都没有推送**。

**iPhone**（Mortred (3)）：0.7.19 (51) 原位覆盖为 0.7.20 (52)，22:43 装上。

- 个人签名的描述文件 11-14 已到期（Xcode 已把过期文件清掉），这次用 `-allowProvisioningUpdates` 换了一份新的：开发者证书不变，**11-23 22:30（墨尔本时间）再次到期**，到期前要再装一次。
- 安装包 `ios/dist/Melo-0.7.20-personal-test.ipa`，SHA-256 `b84b70167da628573288941f0caa3d575986719292ee63ca3bfd19879443f90a`；包里的麦克风与语音识别说明已是通话版本。
- 安装前三次整份读取数据容器（22:30、22:34、安装前 22:42），三次完全一致：594 个文件、196 016 352 字节，18 段对话、209 条消息、6 个 Agent、27 张原图。
- 安装后、首次启动前：对话、偏好、草稿、原图逐个文件不变；只有两张启动快照改了文件名（大小与校验值相同）。
- 首次启动：第一次从电脑启动被系统拒绝（新描述文件还没被信任，FBSOpenApplicationErrorDomain 3）；用户在手机 设置 → 通用 → VPN 与设备管理 点"信任"后，22:50 启动成功。首启后对话、偏好、原图逐个文件不变；草稿与执行记录被重写但内容相同，运行日志加了启动 / 前台 / 后台三条（80 条环形日志挤掉最旧三条），另有系统加载缓存。没有在手机上试通话，没有发真实模型请求。

**电脑**：`MELO_TEST_CONCURRENCY=1 npm run release:verify` 17 项全部 GREEN，没有跳过和重试，22:47 开始、23:00 重建并原位覆盖 `~/Applications/Melo.app`（`~/Desktop/melo/Melo.app` 仍是指向它的链接）。

- 17 项：全量回归 5 208 / 5 208（0 跳过）、开发容器隔离、开发桌面流程（真实 Docker）、设置页浏览器流程、iPhone 协议与共享渲染（含 `VoiceCallTests` 与 30 条通话夹具）、Android 四项、语法检查、桌宠素材、构建应用包、壳与服务的生命周期、本地界面服务、桌面冒烟、浏览器端到端、Agent 人设契约、安装应用包、两处 `Melo.app` 的原生启动。装好的壳里有通话桥（`callStart` / `callSpeak` / `melo-voice-call`）。
- 发布检查用的是独立的临时数据目录。真实数据目录 `.tmp/melo-home-user` 在检查前后逐个文件比对（大小与修改时间，状态、对话、配置、数据库、Agent 等 45 个核心文件另比 SHA-256）：7 513 个文件，没有新增、删除或改动。检查结束后没有残留的服务或壳进程。
- **安装后没有正常启动桌面 Melo。** 数据目录仍是 11-10 受损的状态（主 Agent 名为 `Fixture`、只剩 2 段对话），恢复脚本当晚空跑核对通过（备份 33 段对话、33 个文件、无问题），按 11-10 的约定由用户自己执行。用户要做的顺序：执行恢复命令 → 正常打开 Melo → 在系统弹窗里允许访问"桌面"文件夹（壳重编过，这一步不能由 AI 代点）→ 再试通话。
- 补记：数据目录 11-16 23:56 恢复（用户说"你来恢复"后由 Claude 执行，见[事故记录](incident-test-isolation-20261110.md)最后一节），23:57 正常启动，首页有新的「通话」按钮。

**中途处理的环境问题**：colima 的 Docker 虚拟机当天 08:44 左右已经停止（宿主代理日志反复报"虚拟机不再存活"），残留的宿主代理与网络进程让 `docker` / `colima` 命令全部卡住，发布检查里两项真实 Docker 验收跑不了。我第一次结束这两个进程被权限系统拦下，用户回复"你来重启"后结束并 `colima start`，镜像与容器数据都在。

**Android**：不在本次平台范围，没有安装。

证据：`.tmp/iphone-overwrite-20261116-2229/`（五次读取的清单与比对、`phone-install-receipt.json`、构建与安装日志），手机数据完整副本在 `~/Library/Application Support/MeloDeviceBackups/update-20261116-2229/`；`.tmp/desktop-install-20261116/`（发布检查日志、数据目录前后快照与比对、colima 启动日志）。

## 12. 桌面通话入口改版（2026-11-16 晚，用户选方案 A）

用户反馈："数据恢复好了，桌面已打开，但是实时对话的按钮在哪，这个ui设计还是有问题。"截图核对后有两个原因：(1) 打开 Melo 停在"新对话"页，`viewComposer.js` 只在已有对话里画通话按钮（`!isOverview() && activeChat()`），首页和新对话页没有入口；(2) 对话页里也只是麦克风左边一个 40 px 的无字图标，用的是朗读那个"音频"竖条图标，看不出是通话。给了三个入口方案（A 麦克风旁带文字的「通话」按钮 8.5 / B Agent 选择旁 7.6 / C 发送键兼作通话键 7.4），用户选 A。

### 12.1 执行链路（动工前）

1. 画入口：`desktop-ui/features/chat/viewComposer.js:renderComposerCard`。只要有桌面壳的 `meloVoice` 通道（`voiceCall.js:voiceCallSupported`）就画「通话」按钮，三个有输入区的页面都有：星图总览（`app.js:renderNeuralOverview` → `chatFeature.renderComposer`）、新对话页（`viewThread.js:renderRegularChatPage` 没有当前对话的分支）、对话页。读 `chatState.voiceCall`、`chatState.voice`。
2. 点按钮：`app.js` 动作分发 → `controller.js:chatActions['toggle-voice-call']` → `voiceCall.js:start()`：先停朗读和听写，`owner` 记下页面上下文（`controller.js:voiceCallContext`：视图 | 项目 | 对话 | Agent），`chatId = getChatId()`（总览和新对话页为空），发 `callStart` → `desktop-app/main.swift` → `VoiceCallBridge.start` → `VoiceCall.start` 立即发出 `starting` 状态（在系统权限弹窗之前，所以 5 秒"旧版本"判断不会被第一次的权限弹窗误触发）→ `melo-voice-call` 事件 → `controller.handleVoiceCallBridgeEvent` → `voiceCall.receive`。
3. 说完一句：`receive('utterance')` → `handleUtterance` → `sendTurn(text, watcher, chatId)` → `controller.handleSendMessage({ content, chatId, newChat: !chatId, voiceTurn, observer })` → `leaveOverview` → 没有对话时 `handleCreateChat` → `chatApi.createChat`（`POST /api/chats`，与打字发第一句相同，写 state.json）→ `app.js:applyBootstrap` → `checkVoiceCallContext` → `voiceCall.checkContext`（这次上下文变化是通话自己的第一句在建对话，不挂断）→ `voiceCall.adoptChat(新对话)`：通话的 `owner` 与 `chatId` 移到新对话 → `POST /api/chat/send/stream` 带 `voiceTurn` → 观察者读出回答。
4. 挂断：输入区按钮（通话中显示「挂断」）→ `voiceCall.end()` → `callEnd`；切到别的对话 / 视图 / 项目 / Agent → `checkContext` → `end()`。

共享状态：`chatState.voiceCall`（界面）、`chatState.sending` / `streamingChatId`（是否在回复）、引导数据的 `selectedChatId` / `activeView` / `selectedProjectId`、`uiState.neuralOverview`；服务端只经过已有的建对话与发送路由。异常：建对话失败 → `handleSendMessage` 的 catch → 观察者 `onSettled({ ok: false })`，通话说"出错"短句；`sendTurn` 结束后清掉"正在建对话"标记并重新核对上下文（页面已经换了就挂断）。

### 12.2 审计边界与停止条件

- 纳入：`voiceCall.js` 状态机（`start` / `end` / `checkContext` / `receive` / `handleUtterance` / 新增 `adoptChat`）；`controller.js` 的通话接线、`handleSendMessage`、`handleCreateChat`、动作表；`app.js` 的 `applyBootstrap` / `applyBootstrapPreservingDrafts`（`checkVoiceCallContext` 的两个调用点）、`isOverview` / `leaveOverview`、图标表；`viewComposer.js`、`viewThread.js` 新对话页；输入区相关样式；`translations.js`。
- 停止：服务端路由（`/api/chats`、`/api/chat/send/stream`）没有改，由既有路由与控制器测试覆盖；原生桥与通话引擎没有改，由 Swift `VoiceCallTests` 覆盖；共享契约不变。
- 未覆盖：iPhone（用户这次只选了桌面入口，iPhone 仍是输入区的波形圆按钮）；真实麦克风与系统权限弹窗（要用户在场）。

### 12.3 做了什么

- `desktop-ui/voiceCall.js`：新增 `renderVoiceCallToggle`。输入区按钮写着「通话」，配波形图标（新图标 `callWave`，不再借用朗读的竖条图标）；通话中变成「挂断」，提示色描边加呼吸点，带 `aria-pressed`。面板标题前加呼吸点，面板里不再重复放「挂断」。状态机新增"正在建对话"标记和 `adoptChat`：没有对话时开始的通话，第一句话建好对话后，通话移到这个新对话；建对话期间的页面变化和原生事件都不会挂断；建对话期间又说了一句、被拒发送时，这一句不会抢走标记；建对话失败或发送被拒后重新核对页面，页面已经换了就挂断。
- `desktop-ui/features/chat/controller.js`：`sendTurn` 带上通话自己的对话；还没有对话时标 `newChat`，像打字发第一句一样新建，不会发进总览底下仍选着的旧对话；建好后 `adoptChat`。
- `desktop-ui/features/chat/viewComposer.js`：只要在桌面壳里，总览、新对话页、对话页的输入区都有这个按钮。`desktop-ui/buttonStyles.js` 把它登记为自带外观的控件，形状与输入区"多 Agent 协作 / 项目与知识"一致，统一按钮样式不再把它改成方角灰按钮。`styles.css` 只用已有 token，减弱动态时呼吸点不动。`translations.js` 新增"通话"（五种语言），重新生成 iPhone 词条和场景包（iPhone 界面没有变化）。

### 12.4 验证

- 门禁快速档 `run-SmJAlo` 全绿：语法、文档链接、生成器与依赖预检、共享渲染资源预检、Android JVM / Lint / Debug / Release、JS 回归 851 项（0 失败、0 跳过）、设置页浏览器验收。
- 新增测试：`voiceCall.test.js` 新增 4 项，共 20 项（没有对话时通话移进新建的对话、建对话失败、建对话期间又说一句、输入区按钮的两种状态）；`controller.test.js` 新增从总览开始通话的整条路径，共 27 项；测试桩的 `applyBootstrap` 现在和 `app.js` 一样核对通话。`buttonStyles.test.js` 覆盖通话按钮保留自己的外观。分别去掉五处新逻辑后，对应测试都会红：建对话期间不挂断、只有建对话的那一句持有标记、建对话期间原生事件不挂断、控制器的 `newChat`、控制器的 `adoptChat`。
- 隔离预览：临时数据目录、模拟回复，在页面里模拟原生通话通道。核对了三处：总览、新对话页、对话页都显示「通话」。在新对话页开始通话并说一句，会新建对话，通话不断，回答被读出。在总览开始通话时，底下还选着旧对话，说一句后新建了"今天几号"，旧对话的消息数不变；切到别的对话自动挂断。1080 px 最小窗口下工具栏不溢出。预览结束后已停掉服务、删掉临时数据目录。
- 没有验证：真机麦克风与系统权限弹窗，要用户在场。界面文件由桌面壳直接从源码目录读取，**不需要重新编译安装**，重开 Melo 即可看到。
