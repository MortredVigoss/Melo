import Foundation

// AgentLoop with a scripted transport (2026-10-19 手机 agent loop 对齐桌面):
// iteration and per-response limits, run budget on a virtual clock, repeat
// guard, envelopes, supplements, condensation, tool trace, finalize
// verification and the narrowed team budget. No network, no device data.

final class ScriptedTransport: AgentModelTransport, @unchecked Sendable {
    var offersTools = true
    var timeoutCap: TimeInterval = 120
    var requests: [AgentLoopRequest] = []
    var completions: [(system: String, messages: [ChatMessage])] = []
    var script: (AgentLoopRequest) throws -> AgentRound
    var completeReply: (String, [ChatMessage]) -> String = { _, _ in "" }
    init(_ script: @escaping (AgentLoopRequest) throws -> AgentRound) { self.script = script }
    func round(_ input: AgentLoopRequest) async throws -> AgentRound { requests.append(input); return try script(input) }
    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String { completions.append((system, messages)); return completeReply(system, messages) }
}
final class Log: @unchecked Sendable {
    var performed: [ResponsesFunctionCall] = []
    var stages: [(id: String, status: String, output: String)] = []
    var records: [ExecutionToolCall] = []
    var statuses: [String] = []
}
func fc(_ id: String, _ name: String = "open_url", _ args: String = #"{"url":"https://a.example"}"#) -> ResponsesFunctionCall { ResponsesFunctionCall(callID: id, name: name, arguments: args) }
func calls(_ list: [ResponsesFunctionCall]) -> AgentRound { AgentRound(text: "", calls: list, echo: .none, estimatedInputTokens: 100) }
func answer(_ text: String) -> AgentRound { AgentRound(text: text, estimatedInputTokens: 100) }
func object(_ text: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:] }

@MainActor func loopTools(_ log: Log, output: @escaping (ResponsesFunctionCall) -> PhoneToolResult = { _ in PhoneToolResult(output: PhoneToolEnvelope.success(#"{"title":"page"}"#)) }) -> AgentLoopTools {
    AgentLoopTools(definitions: WebPageToolSpec.all.map(\.definition) + [PhoneReadHistory.definition], instructions: "tools", perform: { call in log.performed.append(call); return output(call) })
}
@MainActor func hooks(_ log: Log) -> AgentLoopHooks {
    AgentLoopHooks(onStatus: { log.statuses.append($0) }, onStage: { id, _, status, output in log.stages.append((id, status, output)) }, onToolCall: { log.records.append($0) })
}

@main struct AgentLoopTests {
    @MainActor static func main() async throws {
        let c = AgentLoopContract.shared
        assert(c.maxIterations == 10 && c.maxCallsPerResponse == 32)

        // The shared receipt reads actual page text, never a successful tool flag.
        for body in ["Sydney brunch menu with breakfast dishes and observed opening hours for this fixture.", "Distant stars and galaxies have different spectra and their light is redshifted.", ""] {
            let log = Log()
            let transport = ScriptedTransport { input in
                if input.goalReview != nil {
                    let good = body.hasPrefix("Sydney")
                    let report: [String: Any] = ["decision": good ? "complete" : "partial", "reasonType": good ? "fulfilled" : "unavailable", "requirements": [["text": "Research Sydney brunch", "status": good ? "met" : "missing", "evidenceIds": good ? ["read:source:0"] : []]]]
                    return answer(String(decoding: try JSONSerialization.data(withJSONObject: report), as: UTF8.self))
                }
                return input.iteration == 0 ? calls([fc("read", "open_url", #"{"url":"https://fixture.invalid/menu"}"#)]) : answer("Sydney brunch: https://fixture.invalid/menu")
            }
            let tools = loopTools(log) { _ in
                let page: [String: Any] = ["ok": true, "url": "https://fixture.invalid/menu", "text": body]
                return PhoneToolResult(output: PhoneToolEnvelope.success(String(data: try! JSONSerialization.data(withJSONObject: page), encoding: .utf8)!))
            }
            let result = try await AgentLoop(transport: transport, tools: tools, budget: PhoneRunBudget(), latestUserMessage: "Research Sydney brunch").run()
            assert(log.performed.count == 1 && transport.requests.count == 3 && transport.requests.last?.goalReview != nil && transport.completions.isEmpty)
            assert(result.completion?.outcome == (body.hasPrefix("Sydney") ? "completed" : "partial"))
            assert(result.completion?.goalState == (body.hasPrefix("Sydney") ? "supported" : "unverified"))
        }
        let plain = try await AgentLoop(transport: ScriptedTransport { _ in answer("Hello") }, tools: nil, budget: PhoneRunBudget(), latestUserMessage: "Hello").run()
        assert(plain.completion?.outcome == "completed" && plain.completion?.goalState == "not_applicable")

        // Calendar discovery must not terminate a weather request: one bounded
        // check resumes the same turn, with the original goal and tool evidence.
        do {
            let log = Log(), budget = PhoneRunBudget()
            let transport = ScriptedTransport { input in
                switch input.iteration {
                case 0: return calls([fc("calendar", "calendar_list_events", #"{"start":"2026-10-23T00:00:00+11:00","end":"2026-11-01T00:00:00+11:00"}"#)])
                case 1: return answer("演唱会已找到，请告诉我场馆地址。")
                case 2:
                    assert(input.goalReview != nil)
                    return answer(#"{"decision":"continue","reasonType":"lookup_missing","reason":"还缺公开场馆和天气","nextStep":"查场馆后查当天预报","requirements":[{"text":"演唱会当天天气","status":"missing","evidenceIds":[]}]}"#)
                case 3: assert(input.repairing); return calls([fc("venue", "open_url", #"{"url":"https://fixture.invalid/venue"}"#)])
                case 4: return calls([fc("weather", "open_url", #"{"url":"https://fixture.invalid/weather"}"#)])
                case 5: return answer("31 日演出在 Example Arena，当天约 18 度，降雨概率 20%。")
                default:
                    assert(input.goalReview != nil)
                    return answer(#"{"decision":"complete","reasonType":"fulfilled","requirements":[{"text":"演唱会当天天气","status":"met","evidenceIds":["weather:source:0"]}]}"#)
                }
            }
            let tools = AgentLoopTools(definitions: DeviceToolSpec.all.map(\.definition) + WebPageToolSpec.all.map(\.definition), instructions: "", perform: { call in
                log.performed.append(call)
                let value = call.name == "calendar_list_events" ? #"{"events":[{"title":"BigBang","date":"2026-10-31"}]}"# : call.callID == "venue" ? #"{"url":"https://fixture.invalid/venue","text":"BigBang at Example Arena on 31 October 2026."}"# : #"{"url":"https://fixture.invalid/weather","text":"Example Arena on 31 October 2026: 18 C, rain probability 20%."}"#
                return PhoneToolResult(output: PhoneToolEnvelope.success(value))
            })
            let result = try await AgentLoop(transport: transport, tools: tools, budget: budget, latestUserMessage: "下周演唱会当天的天气如何？").run()
            assert(log.performed.map(\.callID) == ["calendar", "venue", "weather"])
            assert(transport.requests.count == 7 && budget.used.providerCalls == 7 && budget.used.toolCalls == 3)
            assert(result.text.contains("18 度") && result.completion?.outcome == "completed")
            assert(result.completion?.task?.original == "下周演唱会当天的天气如何？" && result.completion?.task?.corrections == 1)
        }
        for mode in ["ambiguity", "invalid", "tool-attempt", "failure", "limit"] {
            let log = Log(), budget = PhoneRunBudget()
            var checks = 0
            let transport = ScriptedTransport { input in
                if input.goalReview != nil {
                    checks += 1
                    if mode == "failure" { throw URLError(.cannotConnectToHost) }
                    if mode == "tool-attempt" { return calls([fc("forbidden")]) }
                    if mode == "invalid" { return answer("invalid JSON") }
                    return answer(mode == "ambiguity" ? #"{"decision":"needs_user","reasonType":"ambiguity","reason":"同日有两场，请选择","requirements":[{"text":"场次天气","status":"missing","evidenceIds":[]}]}"# : #"{"decision":"continue","reasonType":"lookup_missing","nextStep":"核对剩余事实","requirements":[{"text":"完整回答","status":"missing","evidenceIds":[]}]}"#)
                }
                return input.iteration == 0 ? calls([fc("initial")]) : answer("已有结果保留。")
            }
            let result = try await AgentLoop(transport: transport, tools: loopTools(log), budget: budget, latestUserMessage: "读这个页面").run()
            assert(log.performed.count == 1 && result.text == "已有结果保留。")
            assert(checks == (mode == "limit" ? 3 : 1))
            assert(result.completion?.outcome == (mode == "ambiguity" ? "needs_user" : "partial"))
            assert(budget.used.providerCalls == transport.requests.count)
        }

        // Audit A1: hostile finite numbers never trap, neighbours and offsets clamp before conversion.
        let extremeMessages = (0..<4).map { ChatMessage(id: "m\($0)", role: "user", content: "original") }
        for number in [1e100, -1e100, Double.greatestFiniteMagnitude, Double.infinity, -Double.infinity, Double.nan] {
            let range = PhoneReadHistory.slice(extremeMessages, aroundMessageId: "m2", before: number, after: number, limit: number)
            assert(range.messages.count <= 4)
        }
        let hugeOffset = PhoneReadHistory.run(arguments: #"{"fromMessageId":"m0","fromChar":1e100,"limit":1e100}"#, chatID: "c", title: "test", messages: extremeMessages)
        assert(PhoneToolEnvelope.parse(hugeOffset).ok)

        // Audit A2: deadline returns promptly and cancels work before a delayed side effect.
        do {
            var performed = 0
            let slowTools = AgentLoopTools(definitions: [PhoneReadHistory.definition], instructions: "", perform: { _ in
                do { try await Task.sleep(nanoseconds: 300_000_000); try PhoneExecutionScope.check(); performed += 1 }
                catch { return PhoneToolResult(output: PhoneToolEnvelope.failure("ABORTED", "cancelled")) }
                return PhoneToolResult(output: PhoneToolEnvelope.success("late"))
            })
            let start = Date()
            let result = try await AgentLoop(transport: ScriptedTransport { _ in calls([fc("slow", "read_history")]) }, tools: slowTools, budget: PhoneRunBudget(deadlineMs: 30), latestUserMessage: "q").run()
            assert(result.stop == .budget && Date().timeIntervalSince(start) < 0.2)
            try await Task.sleep(nanoseconds: 320_000_000)
            assert(performed == 0 && result.calls.first?.code == "BUDGET_EXHAUSTED")
            // A deliberately non-cooperative adapter must not keep the loop waiting.
            let start2 = Date()
            do {
                _ = try await PhoneDeadline.run(seconds: 0.02) {
                    await withCheckedContinuation { continuation in
                        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { continuation.resume(returning: "late") }
                    }
                }
                assertionFailure("deadline missing")
            } catch is PhoneDeadline.Reached { assert(Date().timeIntervalSince(start2) < 0.2) }
            let next = try await AgentLoop(transport: ScriptedTransport { _ in answer("next") }, tools: nil, budget: PhoneRunBudget(), latestUserMessage: "q").run()
            assert(next.text == "next")
        }

        // Atomic admission shares the last tool slot across concurrent members.
        do {
            let parent = PhoneRunBudget(maxToolCalls: 1)
            let children = (0..<32).map { _ in parent.narrowed(maxToolCalls: 8) }
            let admitted = await withTaskGroup(of: Bool.self) { group in
                for child in children { group.addTask { child.admitTool() == nil } }
                var total = 0
                for await value in group { if value { total += 1 } }
                return total
            }
            assert(admitted == 1 && parent.used.toolCalls == 1)
            assert(children.allSatisfy { $0.exhausted()?.reason == "tool-calls" })
        }

        // 1. Ten model calls at most; the limit reply is the shared text, in the question's language.
        do {
            let log = Log()
            var n = 0
            let transport = ScriptedTransport { _ in n += 1; return calls([fc("c\(n)", "open_url", #"{"url":"https://a.example/\#(n)"}"#)]) }
            let outcome = try await AgentLoop(transport: transport, tools: loopTools(log), budget: PhoneRunBudget(), latestUserMessage: "一直查", hooks: hooks(log)).run()
            assert(outcome.stop == .toolLimit && outcome.text == c.toolLimitReplyZH && transport.requests.count == 10 && log.performed.count == 10 && log.records.count == 10)
            let english = try await AgentLoop(transport: ScriptedTransport { _ in n += 1; return calls([fc("e\(n)", "open_url", #"{"url":"https://a.example/\#(n)"}"#)]) }, tools: loopTools(Log()), budget: PhoneRunBudget(), latestUserMessage: "keep going").run()
            assert(english.text == c.toolLimitReplyEN)
            // Every round after the first carries the earlier tool rounds; results are envelopes.
            if case .toolRound(_, let results)? = transport.requests[1].transcript.last { assert(object(results[0].modelOutput)["status"] as? String == "ok" && object(results[0].modelOutput)["output"] as? String == #"{"title":"page"}"#) } else { assertionFailure("tool round missing") }
            assert(log.statuses.contains("正在打开网页…") && log.statuses.last == "正在思考…")
        }

        do {
            let log = Log()
            var n = 0
            let transport = ScriptedTransport { _ in n += 1; return calls([fc("same\(n)")]) }
            let outcome = try await AgentLoop(transport: transport, tools: loopTools(log), budget: PhoneRunBudget(), latestUserMessage: "keep reading", hooks: hooks(log)).run()
            assert(outcome.stop == .toolLimit && outcome.text.contains("NO_PROGRESS"))
            assert(transport.requests.count == 6 && log.performed.count == 6 && log.records.count == 6)
        }

        // 2. 32 calls per response run; 33 are refused before any side effect; a reused call id is refused.
        do {
            let log = Log()
            var first = true
            let ok = ScriptedTransport { _ in if first { first = false; return calls((0..<32).map { fc("k\($0)", "read_history", #"{"limit":\#($0 + 1)}"#) }) }; return answer("好了") }
            let outcome = try await AgentLoop(transport: ok, tools: loopTools(log), budget: PhoneRunBudget(), latestUserMessage: "q").run()
            assert(outcome.text == "好了" && log.performed.count == 32)
            let tooMany = ScriptedTransport { _ in calls((0..<33).map { fc("m\($0)") }) }
            let log2 = Log()
            do { _ = try await AgentLoop(transport: tooMany, tools: loopTools(log2), budget: PhoneRunBudget(), latestUserMessage: "q").run(); assertionFailure("33 calls admitted") } catch { assert(log2.performed.isEmpty) }
            var round = 0
            let reused = ScriptedTransport { _ in round += 1; return calls([fc("same", "open_url", #"{"url":"https://\#(round).example"}"#)]) }
            let log3 = Log()
            do { _ = try await AgentLoop(transport: reused, tools: loopTools(log3), budget: PhoneRunBudget(), latestUserMessage: "q").run(); assertionFailure("reused id admitted") } catch { assert(log3.performed.count == 1) }
        }

        // 3. Run budget on a virtual clock: deadline, input tokens and tool calls end the turn with the shared reply.
        do {
            var now = 0.0
            let log = Log()
            var n = 0
            let slow = ScriptedTransport { _ in now += 11 * 60_000; n += 1; return calls([fc("d\(n)")]) }
            let outcome = try await AgentLoop(transport: slow, tools: loopTools(log), budget: PhoneRunBudget(now: { now }), latestUserMessage: "q", hooks: hooks(log)).run()
            assert(outcome.stop == .budget && slow.requests.count == 2 && outcome.text == "这轮对话已达到运行预算（运行时间 20 分钟），已停止。你可以发送“继续”接着做。")
            assert(log.stages.contains { $0.id == "budget:exhausted" && $0.status == "failed" && $0.output.contains("模型请求 2 次") })

            let tokens = ScriptedTransport { _ in var r = calls([fc("t\(Int.random(in: 0..<1_000_000))")]); r.inputTokens = 400_000; return r }
            let tokenOutcome = try await AgentLoop(transport: tokens, tools: loopTools(Log()), budget: PhoneRunBudget(), latestUserMessage: "q").run()
            assert(tokenOutcome.stop == .budget && tokens.requests.count == 1 && tokenOutcome.text.contains("输入 token 400000"))

            let toolLog = Log()
            var k = 0
            let many = ScriptedTransport { _ in k += 1; return calls([fc("a\(k)"), fc("b\(k)", "read_history", "{}"), fc("c\(k)", "read_history", #"{"limit":2}"#)]) }
            let toolOutcome = try await AgentLoop(transport: many, tools: loopTools(toolLog), budget: PhoneRunBudget(maxToolCalls: 2), latestUserMessage: "q", hooks: hooks(toolLog)).run()
            assert(toolOutcome.stop == .budget && toolLog.performed.count == 2 && many.requests.count == 1 && toolOutcome.text.contains("工具调用次数 2 次"))
            assert(toolLog.records.last?.code == "BUDGET_EXHAUSTED" && toolLog.records.last?.executed == false)

            // A request cut off by the deadline takes the budget path, not a provider failure.
            var clock = 0.0
            let hang = ScriptedTransport { _ in clock = 20 * 60_000; throw URLError(.timedOut) }
            let hung = try await AgentLoop(transport: hang, tools: nil, budget: PhoneRunBudget(now: { clock }), latestUserMessage: "q").run()
            assert(hung.stop == .budget && hung.text.contains("运行时间"))
        }

        // 4. Repeat guard: the same failing call runs twice, the third is answered locally.
        do {
            let log = Log()
            var n = 0
            let transport = ScriptedTransport { _ in n += 1; return n <= 3 ? calls([fc("r\(n)")]) : answer("换个方法") }
            let outcome = try await AgentLoop(transport: transport, tools: loopTools(log) { _ in PhoneToolResult(output: PhoneToolEnvelope.failure("TIMEOUT", "slow")) }, budget: PhoneRunBudget(), latestUserMessage: "q", hooks: hooks(log)).run()
            assert(outcome.stop == .toolLimit && outcome.text.contains("REPEATED_TOOL_FAILURE") && log.performed.count == 2 && log.records.map(\.code) == ["TIMEOUT", "TIMEOUT", "REPEATED_FAILURE"])
            assert(transport.requests.count == 3, "failure termination must not spend another model request")
        }

        // 5. Envelopes for legacy and refused calls; unknown tools and the screenshot cap never reach a tool.
        do {
            let log = Log()
            var n = 0
            let jpeg = Data([0xFF, 0xD8, 0xFF])
            let transport = ScriptedTransport { _ in n += 1; return n == 1 ? calls([fc("s1", "web_screenshot"), fc("s2", "web_screenshot"), fc("s3", "web_screenshot"), fc("x", "shell_exec", "{}"), fc("l", "read_history", "{}")]) : answer("ok") }
            let tools = loopTools(log) { call in
                if call.name == "read_history" { return PhoneToolResult(output: #"{"ok":false,"error":"USER_DECLINED","message":"no"}"#) }
                return PhoneToolResult(output: #"{"ok":true,"screenshot":"attached"}"#, imageJPEG: jpeg, imageURL: "https://a.example")
            }
            _ = try await AgentLoop(transport: transport, tools: tools, budget: PhoneRunBudget(), latestUserMessage: "q", hooks: hooks(log)).run()
            assert(log.performed.map(\.callID) == ["s1", "s2", "l"], "\(log.performed.map(\.callID))")
            guard case .toolRound(_, let results)? = transport.requests[1].transcript.last else { fatalError("round missing") }
            let shapes = results.map { object($0.modelOutput) }
            assert(shapes[0]["status"] as? String == "ok" && results[0].imageJPEG == jpeg && shapes[2]["code"] as? String == "TOO_MANY_SCREENSHOTS")
            assert(shapes[3]["code"] as? String == "UNKNOWN_TOOL" && shapes[3]["output"] as? String == c.unknownToolOutput)
            assert(shapes[4]["code"] as? String == "PERMISSION_DENIED" && shapes[4]["detail"] as? String == "USER_DECLINED" && shapes[4]["hint"] as? String == c.hints["PERMISSION_DENIED"])
            assert(log.records.map(\.executed) == [true, true, false, false, true])
            // Tool-free connections ignore calls entirely.
            let plain = ScriptedTransport { _ in calls([fc("z")]) }; plain.offersTools = false
            let plainLog = Log()
            let plainOutcome = try await AgentLoop(transport: plain, tools: loopTools(plainLog), budget: PhoneRunBudget(), latestUserMessage: "q").run()
            assert(plainOutcome.stop == .answered && plainLog.performed.isEmpty)
        }

        // 6. Supplements join before the second model call (no restart); unused ones are handed back.
        do {
            let queue = PhoneSupplements()
            var n = 0
            let transport = ScriptedTransport { _ in n += 1; return n == 1 ? calls([fc("p1")]) : answer("按补充写好了") }
            var joined: [String] = []
            var hookSet = AgentLoopHooks()
            hookSet.takeSupplements = { queue.take() }
            hookSet.onSupplementsJoined = { joined += $0 }
            assert(queue.add("改成五言") && !queue.add("   "))
            let outcome = try await AgentLoop(transport: transport, tools: loopTools(Log()), budget: PhoneRunBudget(), latestUserMessage: "写诗", hooks: hookSet).run()
            assert(outcome.text == "按补充写好了" && joined == ["改成五言"] && queue.end().isEmpty && queue.used == ["改成五言"])
            guard case .userText(let text)? = transport.requests[1].transcript.last else { fatalError("supplement not joined") }
            assert(text == c.supplementMessage(["改成五言"]) && text.hasPrefix("【用户在执行过程中补充"))
            if case .userText? = transport.requests[0].transcript.last { assertionFailure("the first call never takes supplements") }

            let unusedQueue = PhoneSupplements()
            var unusedHooks = AgentLoopHooks(); unusedHooks.takeSupplements = { unusedQueue.take() }
            _ = unusedQueue.add("再加一段")
            _ = try await AgentLoop(transport: ScriptedTransport { _ in answer("一次答完") }, tools: loopTools(Log()), budget: PhoneRunBudget(), latestUserMessage: "q", hooks: unusedHooks).run()
            assert(unusedQueue.end() == ["再加一段"], "an answer in one call leaves the supplement for the next message")
        }

        // 7. Request too large: older tool outputs are condensed once and the call retried; never on the first call.
        do {
            let log = Log()
            var n = 0, rejected = false
            let big = String(repeating: "长", count: 2000)
            let transport = ScriptedTransport { request in
                n += 1
                if request.iteration == 3 && !rejected { rejected = true; throw RequestTooLarge(message: "too large") }
                return request.iteration < 3 ? calls([fc("big\(n)")]) : answer("压缩后完成")
            }
            let outcome = try await AgentLoop(transport: transport, tools: loopTools(log) { _ in PhoneToolResult(output: PhoneToolEnvelope.success(big)) }, budget: PhoneRunBudget(), latestUserMessage: "q", hooks: hooks(log)).run()
            assert(outcome.text == "压缩后完成" && rejected && log.stages.contains { $0.id == "tool-chain:condense:3" })
            let retried = transport.requests.last!
            guard case .toolRound(_, let oldest) = retried.transcript[0], case .toolRound(_, let newest) = retried.transcript[2] else { fatalError("rounds missing") }
            let condensed = object(oldest[0].modelOutput)["output"] as? String ?? ""
            assert(condensed.hasSuffix(c.condensedMarker) && JSText.length(condensed) == 600 + 1 + JSText.length(c.condensedMarker))
            assert(object(newest[0].modelOutput)["output"] as? String == big, "the newest two rounds stay intact")
            let first = ScriptedTransport { _ in throw RequestTooLarge(message: "too large") }
            do { _ = try await AgentLoop(transport: first, tools: loopTools(Log()), budget: PhoneRunBudget(), latestUserMessage: "q").run(); assertionFailure("first-call overflow hidden") } catch { assert(error is RequestTooLarge) }
        }

        // 8. Cancellation after tools ran: records are reported and the trace text follows the shared format.
        do {
            let log = Log()
            let transport = ScriptedTransport { _ in calls([fc("t1", "open_url", #"{"url":"https://example.com/a","page":2}"#), fc("t2", "read_history", #"{"fromMessageId":"m1"}"#)]) }
            let tools = loopTools(log) { call in
                if call.name == "read_history" { withUnsafeCurrentTask { $0?.cancel() }; return PhoneToolResult(output: PhoneToolEnvelope.success("No messages in that range.", empty: true)) }
                return PhoneToolResult(output: PhoneToolEnvelope.success("{}"))
            }
            let task = Task { @MainActor in try await AgentLoop(transport: transport, tools: tools, budget: PhoneRunBudget(), latestUserMessage: "q", hooks: hooks(log)).run() }
            do { _ = try await task.value; assertionFailure("cancelled turn answered") } catch { assert(error is CancellationError) }
            assert(log.records.count == 2 && transport.requests.count == 1)
            let trace = PhoneToolTrace.text(log.records, status: "cancelled")
            assert(trace == "[工具轨迹] 本轮已取消，之前已执行 2 次工具调用（可据此继续，不必重复）：\n1. open_url(url=https://example.com/a, page=2) ✓；2. read_history(fromMessageId=m1) ✗ ABORTED", trace)
            assert(log.records.allSatisfy { $0.argsHash.count == 16 && $0.durationMs >= 0 })
            let message = ChatMessage(role: "assistant", content: trace)
            assert(PhoneToolTrace.isTrace(message) && !PhoneToolTrace.isTrace(ChatMessage(role: "user", content: trace)))
            let q = ChatMessage(role: "user", content: "问题"), prior = ChatMessage(role: "assistant", content: "旧回答")
            assert(PhoneToolTrace.retryOrder([prior, q, message]).map(\.id) == [prior.id, message.id, q.id], "a retry ends on the question")
            assert(PhoneToolTrace.retryOrder([prior, q]).map(\.id) == [prior.id, q.id])
        }

        // 9. finalize: uncertainty rules only for verification intents; CORRECTED / VERIFIED / skipped paths.
        do {
            let factual = AgentLoop.classify("东京塔有多高？", history: [])
            let creative = AgentLoop.classify("帮我写一首关于秋天的诗", history: [])
            assert(factual.taskType == "factual" && AgentLoop.prepareInstructions("base", classification: factual).hasSuffix(PhoneUncertainty.rules))
            assert(AgentLoop.prepareInstructions("base", classification: creative) == "base" && AgentLoop.prepareInstructions("base", classification: nil) == "base")

            func verify(_ verdict: [String: String], classification: PhoneIntent.Classification, reply: String) async throws -> (AgentLoopOutcome, ScriptedTransport) {
                var n = 0
                let transport = ScriptedTransport { _ in n += 1; return n == 1 ? calls([fc("v1", "open_url", #"{"url":"https://example.com/tower"}"#)]) : answer(reply) }
                transport.completeReply = { system, _ in
                    if system == c.intentFallbackSystemPrompt { return "Factual" }
                    return String(data: try! JSONSerialization.data(withJSONObject: verdict), encoding: .utf8)!
                }
                let tools = loopTools(Log()) { _ in PhoneToolResult(output: PhoneToolEnvelope.success("Tokyo Tower: 东京塔高 333 米，1958 年建成。")) }
                let outcome = try await AgentLoop(transport: transport, tools: tools, budget: PhoneRunBudget(), latestUserMessage: "东京塔有多高？",
                                                  verification: AgentVerification(question: "东京塔有多高？", classification: classification)).run()
                return (outcome, transport)
            }
            let corrected = try await verify(["verdict": "CORRECTED", "evidenceId": "tool:v1", "evidenceQuote": "333 米", "originalClaim": "东京塔高 330 米。", "correction": "东京塔高 333 米。"], classification: factual, reply: "东京塔高 330 米。\n[UNCERTAIN: 东京塔的确切高度]")
            assert(corrected.0.text == "东京塔高 333 米。" && corrected.0.verification?.verdict == "CORRECTED" && corrected.1.completions.count == 1)
            let request = corrected.1.completions[0]
            assert(request.system == c.verifierSystemPrompt && request.messages.map(\.role) == ["user", "assistant", "user"] && request.messages[2].content.contains("\"id\":\"tool:v1\""))
            let verified = try await verify(["verdict": "VERIFIED", "evidenceId": "tool:v1", "evidenceQuote": "333 米"], classification: factual, reply: "东京塔高 333 米。\n[UNCERTAIN: 高度]")
            assert(verified.0.text == "东京塔高 333 米。" && verified.0.verification?.verdict == "VERIFIED")
            let unsupported = try await verify(["verdict": "VERIFIED", "evidenceId": "tool:v1", "evidenceQuote": "999 米"], classification: factual, reply: "东京塔高 333 米。\n[UNCERTAIN: 高度]")
            assert(unsupported.0.text == "东京塔高 333 米。\n\n" + c.unverifiedNoteZH, "a quote missing from the evidence is not support")
            let notNeeded = try await verify(["verdict": "VERIFIED"], classification: creative, reply: "秋风起。\n[UNCERTAIN: 季节]")
            assert(notNeeded.0.text == "秋风起。" && notNeeded.1.completions.isEmpty, "the marker is removed, no verifier call for creative work")
            let ambiguous = try await verify(["verdict": "VERIFIED", "evidenceId": "tool:v1", "evidenceQuote": "1958 年"], classification: PhoneIntent.Classification(taskType: nil, riskLevel: "normal"), reply: "1958 年建成。\n[UNCERTAIN: 年份]")
            assert(ambiguous.1.completions.map(\.system) == [c.intentFallbackSystemPrompt, c.verifierSystemPrompt] && ambiguous.0.verification?.verdict == "VERIFIED", "ambiguous wording asks the classifier with the desktop prompt")
            // An exhausted budget skips verification.
            var clock = 0.0
            let late = ScriptedTransport { _ in clock = 21 * 60_000; return answer("答案\n[UNCERTAIN: 数字]") }
            let lateOutcome = try await AgentLoop(transport: late, tools: nil, budget: PhoneRunBudget(now: { clock }), latestUserMessage: "q", verification: AgentVerification(question: "q", classification: factual)).run()
            assert(lateOutcome.text == "答案" && late.completions.isEmpty)
        }

        // A3: the actual verifier request cannot recover disabled source text.
        do {
            var agent = AgentProfile(id: "main", name: "main", subtitle: "", symbol: "star", instructions: "persona")
            agent.contextSources = .object(["knowledge": .bool(false), "projects": .bool(false)])
            let context = ConversationContext.resolve(agent: agent, project: PersonalProject(id: "p", name: "PRIVATE_PROJECT", goal: "PRIVATE_GOAL"), notes: [KnowledgeNote(id: "secret", title: "private", content: "PRIVATE_KNOWLEDGE")], query: "东京塔多高？")
            let transport = ScriptedTransport { _ in answer("东京塔高 333 米。\n[UNCERTAIN: 高度]") }
            transport.completeReply = { _, _ in "{\"verdict\":\"UNVERIFIED\"}" }
            _ = try await AgentLoop(transport: transport, tools: nil, budget: PhoneRunBudget(), latestUserMessage: "东京塔多高？", verification: AgentVerification(question: "东京塔多高？", classification: PhoneIntent.Classification(taskType: "factual", riskLevel: "normal"), contextBlocks: context.evidence + ["Public evidence: Tokyo Tower is 333 metres high."])).run()
            assert(transport.completions.count == 1)
            assert(!transport.completions.flatMap { $0.messages }.contains { $0.content.contains("PRIVATE_") })
        }

        // A6: limits stop before another request or a side effect, including provider output usage.
        do {
            let log = Log(), transport = ScriptedTransport { _ in calls([fc(UUID().uuidString)]) }
            do {
                _ = try await PhoneMemberLimits.$current.withValue(.init(iterations: 1, tokens: 10000, timeoutMs: 1000)) {
                    try await AgentLoop(transport: transport, tools: loopTools(log), budget: PhoneRunBudget(), latestUserMessage: "q").run()
                }
                assertionFailure("unfinished member cannot report success")
            } catch {}
            assert(transport.requests.count == 1 && log.performed.count == 1)
            let denied = Log()
            let expensive = ScriptedTransport { _ in var row = calls([fc("write")]); row.inputTokens = 100; row.outputTokens = 500; return row }
            do {
                _ = try await PhoneMemberLimits.$current.withValue(.init(iterations: 8, tokens: 200, timeoutMs: 1000)) {
                    try await AgentLoop(transport: expensive, tools: loopTools(denied), budget: PhoneRunBudget(), latestUserMessage: "q").run()
                }
                assertionFailure("member budget ignored")
            } catch {}
            assert(denied.performed.isEmpty && expensive.requests[0].remainingTokens == 200)
        }

        // 10. Team members run on a narrowed child of the turn budget; their use lands on the parent.
        do {
            var now = 0.0
            let turn = PhoneRunBudget(maxToolCalls: 10, now: { now })
            turn.record(toolCalls: 4)
            let team = turn.narrowed(deadlineMs: 15 * 60_000)
            let member = team.narrowed()
            assert(team.deadlineAt == 15 * 60_000 && member.maxToolCalls == 6 && team.maxToolCalls == 6)
            var n = 0
            let transport = ScriptedTransport { _ in n += 1; return n <= 2 ? calls([fc("mm\(n)")]) : answer("成员完成") }
            let outcome = try await AgentLoop(transport: transport, tools: loopTools(Log()), budget: member, latestUserMessage: "q").run()
            assert(outcome.text == "成员完成" && turn.used.toolCalls == 6 && turn.used.providerCalls == 4 && team.used.toolCalls == 2)
            now = 16 * 60_000
            assert(member.exhausted()?.reason == "deadline" && turn.exhausted() == nil, "the team deadline stops members, not the turn")
            let stopped = try await AgentLoop(transport: ScriptedTransport { _ in answer("late") }, tools: nil, budget: team.narrowed(), latestUserMessage: "q").run()
            assert(stopped.stop == .budget)
        }

        // 11. Transcript rendering for the API protocols: supplements after tool results.
        do {
            let round = AgentRound(text: "", calls: [fc("c1")], echo: .anthropic([["type": "tool_use", "id": "c1", "name": "open_url", "input": ["url": "https://a.example"]]]))
            let results = [AgentToolResult(call: fc("c1"), modelOutput: PhoneToolEnvelope.success("{}"))]
            let claude = APIChatTransport.rendered([["role": "user", "content": "q"]], transcript: [.toolRound(round, results), .userText("补充")], anthropic: true)
            assert(claude.count == 3 && (claude[2]["content"] as? [[String: Any]])?.map { $0["type"] as? String } == ["tool_result", "text"], "Anthropic: the supplement joins the tool_result turn")
            let chatRound = AgentRound(text: "", calls: [fc("c1")], echo: .chat(["role": "assistant", "content": NSNull(), "tool_calls": [["id": "c1"]]]))
            let chat = APIChatTransport.rendered([["role": "system", "content": "s"], ["role": "user", "content": "q"]], transcript: [.toolRound(chatRound, results), .userText("补充")], anthropic: false)
            assert(chat.map { $0["role"] as? String } == ["system", "user", "assistant", "tool", "user"] && chat[4]["content"] as? String == "补充")
            assert(RequestSizeEstimate.tokens(Data(#"{"a":"data:image/jpeg;base64,\#(String(repeating: "A", count: 4000))"}"#.utf8)) < 20)
        }
        print("Agent loop tests passed: 10-call limit reply, 32-call batch and reused ids, budget (deadline/tokens/tool calls/timeout), repeat guard, envelopes and refusals, supplements without restart, condensation retry, cancellation trace, finalize verification, narrowed team budget, transcript rendering")
    }
}
