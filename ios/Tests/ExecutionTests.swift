import Foundation
@main struct ExecutionTests {
    static func main() throws {
        var phone = ExecutionRecord(chatId: "phone", query: "concert", requestedModel: "m")
        let page: [String: Any] = ["finalUrl": "https://example.org/show", "title": "Show", "text": "receipt body stays private", "pageCount": 2]
        phone.recordPhoneOperation(id: "web:1", module: "search", name: "网页 · 打开", status: "completed", summary: "page 1/2", page: page, textRead: true)
        phone.recordPhoneOperation(id: "web:1", module: "search", name: "网页 · 打开", status: "completed", summary: "page 1/2", page: page, textRead: true)
        phone.recordPhoneOperation(id: "web:2", module: "search", name: "网页 · 截图", status: "completed", summary: "screenshot", page: ["url":"https://example.org/photo"])
        phone.recordPhoneOperation(id: "web:3", module: "search", name: "网页 · 打开", status: "failed", summary: "HTTP 403", page: ["url":"https://example.org/private"])
        var native = ExecutionObservation()
        native.tool(["type":"web_search_call","id":"provider-1","status":"completed","action":["type":"search","sources":[["url":"https://example.org/show?utm_source=provider"],["url":"https://example.org/venue"]]]])
        phone.observe(native); phone.observe(native)
        assert(phone.operations.count == 4 && phone.displayedToolCount == 4 && phone.sources.count == 3)
        let read = phone.sources.first { $0.url == "https://example.org/show" }!
        assert(read.appeared && read.accessed && read.opened && read.reading == "partial" && !read.cited)
        assert(phone.sources.contains { $0.url.hasSuffix("/photo") && $0.opened && !$0.accessed })
        let encodedPhone = try JSONEncoder().encode(phone)
        assert(!String(decoding: encodedPhone, as: UTF8.self).contains("receipt body stays private"))
        phone.recordStage("model:1", name: "模型请求", status: "completed")
        phone.recordStage("web:legacy", name: "网页 · 打开", status: "completed")
        phone.recordStage("tool:denied", name: "工具 · open_url", status: "failed")
        assert(phone.displayedToolCount == 5)
        phone.finish("completed")
        phone.recordPhoneOperation(id: "web:late", module: "search", name: "网页 · 打开", status: "completed", summary: "")
        assert(phone.displayedToolCount == 5)
        // Layout A: the war room opens by itself once per live run at its first
        // observable step, never for a plain reply, not again after the user
        // closed it, and hands back at the end unless the user touched it.
        do {
            var rules = WarRoomPresentation()
            var plain = ExecutionRecord(chatId: "w", query: "hi", requestedModel: "m")
            plain.recordStage("model:1", name: "模型请求", status: "running")
            assert(!plain.hasObservableExecution && !rules.shouldOpen(plain, presented: false))
            var run = ExecutionRecord(chatId: "w", query: "find", requestedModel: "m")
            run.recordPhoneOperation(id: "web:1", module: "search", name: "网页 · 打开", status: "running", summary: "")
            assert(rules.shouldOpen(run, presented: false))
            assert(!rules.shouldOpen(run, presented: false), "once per run")
            assert(!rules.shouldClose(run), "still running")
            run.finish("completed")
            assert(rules.shouldClose(run))
            var assigned = ExecutionRecord(chatId: "w", query: "team", requestedModel: "m")
            assigned.recordStage("internal:1", name: "检索成员", status: "running")
            assert(rules.shouldOpen(assigned, presented: false))
            rules.userClosed(assigned)
            assigned.recordPhoneOperation(id: "job-1:web", module: "search", name: "网页 · 打开", status: "running", summary: "")
            assert(!rules.shouldOpen(assigned, presented: false), "closed while running stays closed")
            var touched = ExecutionRecord(chatId: "w", query: "eval", requestedModel: "m")
            touched.recordStage("task-evaluation:1", name: "评估", status: "completed")
            assert(rules.shouldOpen(touched, presented: false))
            rules.touched = true; touched.finish("completed")
            assert(!rules.shouldClose(touched), "a touched war room stays until the user leaves")
            assert(!rules.shouldOpen(run, presented: true))
            // A prompt that needs the user is never covered; stepping aside is not a dismissal.
            var held = ExecutionRecord(chatId: "w", query: "write", requestedModel: "m")
            held.recordPhoneOperation(id: "file:1", module: "files", name: "文件 · 写入", status: "waiting", summary: "")
            assert(held.needsUser && !rules.shouldOpen(held, presented: false), "never opens over a permission prompt")
            var device = ExecutionRecord(chatId: "w", query: "device", requestedModel: "m")
            device.recordPhoneOperation(id: "web:2", module: "search", name: "网页 · 打开", status: "running", summary: "")
            assert(!rules.shouldOpen(device, presented: false, blocked: true), "never opens over a system prompt")
            assert(rules.shouldOpen(device, presented: false))
            rules.stepAside(device); rules.userClosed(device)
            assert(!rules.shouldReturn(device, blocked: true))
            assert(rules.shouldReturn(device), "comes back once the prompt is answered")
        }
        // Plan C: member role, round limit and evaluation snapshot stay on the
        // local stage, survive merges and Codable, and stay out of v1 sync.
        do {
            var space = ExecutionRecord(chatId: "space", query: "q", requestedModel: "m")
            let snapshot = try SyncValue.from(["v": 1, "summary": ["verified": 2, "stop": "continue"], "candidates": [["key": "a", "tier": "primary", "total": 82]]])
            space.recordStage("internal:1", name: "检索成员", status: "running", input: "read the official pages", role: "research", rounds: 4)
            space.recordStage("internal:1", name: "检索成员", status: "completed", output: "done")
            space.recordStage("internal:2", name: "x", status: "running", role: "admin", rounds: 900)
            space.recordStage("task-evaluation:3", name: "任务评估", status: "completed", output: "发现 1", evaluation: snapshot)
            let member = space.pipeline?.first { $0.id == "internal:1" }
            assert(member?.status == "completed" && member?.role == "research" && member?.limits == ["rounds": 4])
            // The task is input, as desktop and Android record it; the report does not erase it.
            assert(member?.input == "read the official pages" && member?.output == "done")
            let odd = space.pipeline?.first { $0.id == "internal:2" }
            assert(odd?.role == nil && odd?.limits == ["rounds": 100])
            assert(space.pipeline?.first { $0.id == "task-evaluation:3" }?.evaluation == snapshot)
            let decoded = try JSONDecoder().decode(ExecutionRecord.self, from: try JSONEncoder().encode(space))
            assert(decoded.pipeline == space.pipeline)
        }
        var bounds = ExecutionRecord(chatId: "bounds", query: "q", requestedModel: "m")
        let prefix = String(repeating: "x", count: 280)
        for tail in ["a", "b", "b"] {
            bounds.recordPhoneOperation(id: prefix + tail, module: "search", name: "open_url", status: "completed", summary: "ok",
                                        page: ["url":"https://example.org/" + String(repeating: "x", count: 2300)])
        }
        assert(bounds.operations.count == 2 && bounds.operations.allSatisfy { $0.id.utf16.count <= 200 && $0.input.isEmpty })
        assert(bounds.sources.count == 1 && bounds.sources[0].url.count > 2200)
        let clockStart = "2026-10-16T00:00:00.000Z"
        let clockEnd = "2026-10-16T00:00:19.000Z"
        var timed = ExecutionRecord(chatId: "timed", query: "q", requestedModel: "m")
        timed.startedAt = clockStart
        assert(timed.elapsedMilliseconds(now: ExecutionClock.date(clockEnd)!) == 19000)
        timed.pipeline = [
            ExecutionStage(id: "model:1", name: "m", status: "completed", startedAt: "2026-10-16T00:00:01Z", finishedAt: "2026-10-16T00:00:09Z"),
            ExecutionStage(id: "model:2", name: "m", status: "completed", startedAt: "2026-10-16T00:00:05Z", finishedAt: "2026-10-16T00:00:12Z"),
            ExecutionStage(id: "model:3", name: "m", status: "running", startedAt: "2026-10-16T00:00:16Z"),
            ExecutionStage(id: "model:1:summary", channel: "reasoning-summary", name: "summary", status: "running", startedAt: clockStart)
        ]
        assert(timed.modelMilliseconds(now: ExecutionClock.date("2026-10-16T00:00:20Z")!) == 15000)
        for state in ["completed", "failed", "cancelled", "interrupted"] {
            timed.status = state; timed.finishedAt = clockEnd
            assert(timed.elapsedMilliseconds(now: Date.distantFuture) == 19000)
            let restored = try JSONDecoder().decode(ExecutionRecord.self, from: JSONEncoder().encode(timed))
            assert(restored.elapsedMilliseconds(now: Date.distantFuture) == 19000)
        }
        timed.finishedAt = nil
        assert(timed.elapsedMilliseconds(now: Date.distantFuture) == nil)
        timed.startedAt = "invalid"
        assert(timed.elapsedMilliseconds() == nil)
        var imageProgress = ExecutionImageProgress(requested: 2, startedAt: clockStart)
        assert(imageProgress.percent == 0)
        imageProgress.saved = 1
        assert(imageProgress.percent == 50)
        imageProgress.saved = 2; imageProgress.finishedAt = clockEnd
        timed.imageProgress = imageProgress
        let restoredImage = try JSONDecoder().decode(ExecutionRecord.self, from: JSONEncoder().encode(timed))
        assert(restoredImage.imageProgress?.percent == 100 && restoredImage.imageProgress?.finishedAt == clockEnd)
        var receipt = ExecutionObservation(requestStarted: ProcessInfo.processInfo.systemUptime - 1)
        receipt.accept(["type":"response.created", "response":["id":"resp_safe", "model":"real-model", "status":"in_progress", "headers":["authorization":"secret"], "input":"private prompt"]])
        receipt.accept(["type":"response.completed", "response":["status":"completed", "usage":["input_tokens":42,"output_tokens":9,"total_tokens":51,"input_tokens_details":["cached_tokens":20],"output_tokens_details":["reasoning_tokens":3]], "output":[]]])
        let api = receipt.pipeline.first?.api
        assert(api?["responseId"] == .string("resp_safe") && api?["usage"]?["cached"] == .number(20))
        assert(api?["usage"]?["input"] == .number(42) && api?["usage"]?["reasoning"] == .number(3))
        let encodedReceipt = try JSONEncoder().encode(receipt.pipeline)
        assert(!String(decoding:encodedReceipt,as:UTF8.self).contains("secret") && !String(decoding:encodedReceipt,as:UTF8.self).contains("private prompt"))
        let decodedReceipt = try JSONDecoder().decode([ExecutionStage].self,from:encodedReceipt)
        assert(decodedReceipt == receipt.pipeline)
        var invalidReceipt = ExecutionObservation()
        invalidReceipt.stage("model:response",name:"request",status:"running")
        invalidReceipt.apiReceipt(["id":"bad id", "usage":["input_tokens":true,"output_tokens":-1,"total_tokens":1.5]],transport:"chat-completions")
        assert(invalidReceipt.pipeline[0].api?["usage"] == nil && invalidReceipt.pipeline[0].api?["responseId"] == nil)
        invalidReceipt.apiReceipt(["usage":["input_tokens":5,"cache_read_input_tokens":10,"cache_creation_input_tokens":3]],transport:"anthropic",finishReason:"end_turn")
        assert(invalidReceipt.pipeline[0].api?["usage"]?["input"] == .number(18))
        assert(invalidReceipt.pipeline[0].api?["finishReason"] == .string("end_turn"))
        var summary = ExecutionObservation()
        func delta(_ text: String, part: Int = 0, sequence: Int) -> [String: Any] {
            ["type": "response.reasoning_summary_text.delta", "item_id": "rs-1", "summary_index": part, "sequence_number": sequence, "delta": text]
        }
        summary.accept(["type": "response.created"])
        summary.accept(delta("查找", sequence: 1)); summary.accept(delta("查找", sequence: 1))
        summary.accept(delta("气象台", sequence: 2)); summary.accept(delta("第二段", part: 1, sequence: 3))
        assert(summary.pipeline.last?.output == "查找气象台\n\n第二段", "Parts stay ordered and duplicate deltas are ignored")
        assert(summary.operations.isEmpty && summary.pipeline.last?.channel == "reasoning-summary")
        var summaryRecord = ExecutionRecord(chatId:"summary", query:"天气", requestedModel:"m")
        summaryRecord.observe(summary)
        assert(summaryRecord.lastModule == "compute")
        summary.accept(["type": "response.reasoning_summary_text.done", "item_id": "rs-1", "summary_index": 0, "sequence_number": 4, "text": "已核对气象台"])
        assert(summary.pipeline.last?.status == "running", "One part finishing does not finish the whole item")
        summary.accept(["type": "response.output_item.done", "item": ["type":"reasoning", "id":"rs-1", "summary":[["type":"summary_text", "text":"官方最终摘要"]]]])
        assert(summary.pipeline.last?.output == "官方最终摘要" && summary.pipeline.last?.status == "completed")
        summary.accept(delta("过时事件", sequence: 5))
        assert(summary.pipeline.last?.output == "官方最终摘要")
        summaryRecord.observe(summary); summaryRecord.finish("completed")
        let summaryReplay = try JSONDecoder().decode(ExecutionRecord.self, from: JSONEncoder().encode(summaryRecord))
        assert(summaryReplay == summaryRecord && summaryReplay.operations.isEmpty)
        var cancelledSummary = ExecutionRecord(chatId:"cancel",query:"q",requestedModel:"m")
        var partial = ExecutionObservation(); partial.accept(delta("未完成概述", sequence:1))
        cancelledSummary.observe(partial); cancelledSummary.finish("cancelled"); cancelledSummary.observe(summary)
        assert(cancelledSummary.pipeline?.last?.status == "cancelled" && cancelledSummary.pipeline?.last?.output == "未完成概述")
        partial.accept(["type":"response.incomplete"])
        assert(partial.pipeline.first?.status == "interrupted")
        var privateReasoning = ExecutionObservation()
        privateReasoning.accept(["type":"response.reasoning_text.delta", "item_id":"private", "summary_index":0,"delta":"not public"])
        privateReasoning.accept(["type":"response.output_item.done", "item":["type":"reasoning","id":"private","encrypted_content":"secret","content":[["text":"private"]]]])
        assert(privateReasoning.pipeline.isEmpty, "Only explicit public summaries enter the inspector")
        var stream = ChatGPTStream()
        func json(_ value: [String:Any]) throws -> String { String(data: try JSONSerialization.data(withJSONObject:value), encoding:.utf8)! }
        try stream.accept(json(["type":"response.created","response":["model":"returned-model"]]))
        try stream.accept(json(["type":"response.output_item.added","item":["type":"web_search_call","id":"search-1","status":"in_progress"]]))
        assert(stream.observation.operations.count == 1 && stream.observation.operations[0].status == "running")
        let candidates = (0..<14).map { ["type":"url","url":"https://example.com/\($0)"] }
        try stream.accept(json(["type":"response.output_item.done","item":["type":"web_search_call","id":"search-1","status":"completed","action":["type":"search","queries":["forecast"],"sources":candidates]]]))
        try stream.accept(json(["type":"response.output_item.done","item":["type":"web_search_call","id":"search-2","status":"completed","action":["type":"open_page","url":"https://example.com/0"]]]))
        let citation: [String:Any] = ["type":"url_citation","url":"https://example.com/0","title":"Forecast","start_index":0,"end_index":2]
        try stream.accept(json(["type":"response.completed","response":["status":"completed","model":"returned-model","output":[["type":"web_search_call","id":"search-1","status":"completed","action":["type":"search","sources":candidates]],["type":"message","content":[["type":"output_text","text":"晴天","annotations":[citation]]]]]]]))
        assert(stream.observation.sources.count == 14)
        assert(stream.observation.sources[0].cited && stream.observation.sources[0].opened)
        assert(!stream.observation.sources[0].accessed, "Opening a page is not proof of reading its body")
        assert(stream.observation.operations.count == 2)
        assert(stream.observation.operations.allSatisfy { $0.module == "search" })
        assert(stream.observation.operations[0].query == "forecast", "Partial final summaries must preserve earlier queries")
        assert(stream.observation.pipeline.count == 2)
        assert(stream.observation.pipeline.allSatisfy { $0.module == "create" && $0.status == "completed" })
        assert(stream.observation.pipeline[0].returnedModel == "returned-model")
        assert(stream.observation.pipeline[1].id == "reply:format")
        try stream.accept(json(["type":"response.web_search_call.searching","item_id":"search-1"]))
        assert(stream.observation.operations[0].status == "completed", "Late events must not restart a completed call")
        var linked = ChatGPTStream()
        try linked.accept(json(["type":"response.output_item.done","item":["type":"web_search_call","id":"lookup","status":"completed","action":["type":"search","sources":[["url":"https://example.com/weather?city=melbourne&utm_source=search"]]]]]))
        try linked.accept(json(["type":"response.completed","response":["status":"completed","output":[["type":"message","content":[["type":"output_text","text":"🌤 [气象台](https://example.com/weather?city=melbourne&utm_source=answer)查看。补充：https://example.org/forecast。","annotations":[]]]]]]]))
        assert(linked.sources.count == 2, "Answer links must reach source storage even without URL annotations")
        assert(linked.observation.sources.count == 2, "Tracking variants must merge into the recorded candidate")
        assert(linked.observation.sources[0].cited && linked.observation.sources[0].appeared)
        assert(!linked.observation.sources[0].accessed && linked.observation.sources[0].reading == "unknown")
        var record = ExecutionRecord(chatId:"chat",query:"forecast",requestedModel:"requested-model")
        record.observe(stream.observation); record.finish("completed",messageID:"reply")
        let stored = try JSONEncoder().encode(record)
        let replay = try JSONDecoder().decode(ExecutionRecord.self,from:stored)
        assert(replay == record && replay.returnedModel == "returned-model")
        let revision = record.sequence; record.observe(ExecutionObservation()); assert(record.sequence == revision)
        record.markRendered(messageID: "wrong-message"); assert(record.sequence == revision)
        record.markRendered(messageID: "reply")
        assert(record.pipeline?.last?.id == "reply:render" && record.pipeline?.last?.status == "completed")
        assert(record.operations.count == 2, "Rendering must not be counted as a tool")
        let renderedRevision = record.sequence; record.markRendered(messageID: "reply"); assert(record.sequence == renderedRevision)
        var interrupted = ExecutionRecord(chatId:"chat",query:"q",requestedModel:"m")
        var ongoing = ExecutionObservation(); ongoing.accept(["type":"response.web_search_call.searching","item_id":"s"])
        interrupted.observe(ongoing); interrupted.finish("interrupted")
        assert(interrupted.operations[0].status == "interrupted")
        var cancelled = ExecutionRecord(chatId:"cancelled",query:"q",requestedModel:"m")
        cancelled.recordStage("model:response", name:"模型请求", status:"running", model:"m")
        cancelled.finish("cancelled")
        assert(cancelled.pipeline?.first?.status == "cancelled")
        let cancelledRevision = cancelled.sequence
        cancelled.recordStage("model:response", name:"模型请求", status:"completed")
        assert(cancelled.sequence == cancelledRevision && cancelled.pipeline?.first?.status == "cancelled")
        var unsafe = ExecutionObservation(); unsafe.source(url:"file:///tmp/private"); unsafe.source(url:"https://secret:token@example.com")
        assert(unsafe.sources.isEmpty)
        let legacy = ExecutionRecord.legacy(chatID:"old", message:ChatMessage(id:"reply",role:"assistant",content:"old response"), query:"old question", sources:[WebSource(title:"Old reference",url:"https://example.com/old")])
        assert(legacy.terminal && legacy.operations.isEmpty && legacy.sources[0].cited && !legacy.sources[0].appeared)
        let answer = ChatMessage(id: "historical-answer", role: "assistant", content: "[引用页](https://example.com/weather?city=melbourne&utm_source=reply)；https://example.org/extra")
        var old = ExecutionRecord(chatId: "history", query: "weather", requestedModel: "m")
        var candidate = ExecutionSource(id: "first-node", url: "https://example.com/weather?city=melbourne&utm_source=search", title: "Search title", order: 0, rank: 9)
        candidate.appeared = true; candidate.opened = true
        var duplicate = candidate; duplicate.id = "duplicate-node"; duplicate.url = "https://example.com/weather?city=melbourne&fbclid=tracking"; duplicate.reading = "partial"; duplicate.accessed = true
        old.sources = [candidate, duplicate]; old.operations = [ExecutionOperation(id: "real-tool", status: "completed")]
        old.finish("completed", messageID: answer.id)
        let beforeRepair = old
        let chat = Conversation(id: "history", messages: [ChatMessage(role: "user", content: "weather"), answer])
        let repaired = ExecutionRecord.reconcilingHistory([old], chats: [chat], messageSources: [:])
        assert(repaired.count == 1 && repaired[0].sources.count == 2)
        assert(repaired[0].sources[0].id == "first-node" && repaired[0].sources[0].rank == 9)
        assert(repaired[0].sources[0].cited && repaired[0].sources[0].opened && repaired[0].sources[0].accessed && repaired[0].sources[0].reading == "partial")
        assert(repaired[0].sources[0].citationLabel == "引用页")
        assert(repaired[0].sources[0].citationUrl == "https://example.com/weather?city=melbourne&utm_source=reply")
        assert(repaired[0].sources[1].cited && !repaired[0].sources[1].appeared && !repaired[0].sources[1].accessed)
        assert(repaired[0].operations == beforeRepair.operations && repaired[0].finishedAt == beforeRepair.finishedAt && repaired[0].restSeed == beforeRepair.restSeed)
        assert(ExecutionRecord.reconcilingHistory(repaired, chats: [chat], messageSources: [:]) == repaired, "Reopening history must be idempotent")
        let chatWithoutRecord = Conversation(id: "no-record", messages: [ChatMessage(role: "assistant", content: "[旧网页](https://example.net/old)")])
        let recovered = ExecutionRecord.reconcilingHistory([], chats: [chatWithoutRecord], messageSources: [:])
        assert(recovered.count == 1 && recovered[0].operations.isEmpty && recovered[0].sources[0].cited)
        assert(recovered[0].observationNote.contains("不补造"))
        let encodedOld = try JSONSerialization.jsonObject(with: JSONEncoder().encode(beforeRepair)) as! [String: Any]
        var oldJSON = encodedOld
        oldJSON.removeValue(forKey: "pipeline")
        oldJSON["sources"] = (oldJSON["sources"] as! [[String: Any]]).map { item -> [String: Any] in var value = item; value.removeValue(forKey: "citationUrl"); value.removeValue(forKey: "citationLabel"); return value }
        let decodedOld = try JSONDecoder().decode(ExecutionRecord.self, from: JSONSerialization.data(withJSONObject: oldJSON))
        assert(decodedOld == beforeRepair, "Existing installs must decode without the new optional metadata")
        let eventHistory = ExecutionRecord.executionHistory([cancelled, interrupted], chatID: "cancelled")
        assert(eventHistory.contains(cancelled.runId + "/model/model%3Aresponse/started"))
        assert(eventHistory.contains(cancelled.runId + "/terminal/turn/finished"))
        assert(!eventHistory.contains(interrupted.runId))
        assert(ExecutionRecord.executionHistory([cancelled], chatID: "cancelled", enabled: false).isEmpty)
        let restoredCancelled = try JSONDecoder().decode(ExecutionRecord.self, from: JSONEncoder().encode(cancelled))
        assert(ExecutionRecord.executionHistory([restoredCancelled], chatID: "cancelled") == eventHistory)
        let history = [ChatMessage(role:"user",content:"查一下墨尔本到悉尼的机票"),ChatMessage(role:"assistant",content:"哪一天？"),ChatMessage(role:"user",content:"10月31号")]
        assert(ChatGPTRequest.requiresSearch(history))
        assert(!ChatGPTRequest.requiresSearch(history + [ChatMessage(role:"user",content:"不用查了，帮我写首诗")]))
        let prohibited = ChatGPTRequest.body(messages:[ChatMessage(role:"user",content:"不要联网，帮我整理航班记录")],model:"test",instructions:"",webSearch:true)
        assert(prohibited["tools"] == nil && prohibited["include"] == nil, "Explicitly prohibited search must be unavailable, not merely optional")
        print("Execution persistence, real search evidence, citation/read separation, terminal state and follow-up routing passed")
    }
}
