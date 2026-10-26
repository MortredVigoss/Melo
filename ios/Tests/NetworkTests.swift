import Foundation
final class MockProtocol: URLProtocol {
    static var status = 200
    static var failure: URLError.Code?
    static var anthropic = false
    static var requestBody: [String: Any] = [:]
    static var payload = "{\"choices\":[{\"message\":{\"content\":\"Hello iPhone\"}}]}"
    /// Consumed first when set: one response per round of a tool loop.
    static var payloads: [String] = []
    static var requestBodies: [[String: Any]] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        assert(request.httpMethod == "POST")
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = stream.read(&bytes, maxLength: bytes.count)
                precondition(count >= 0, "Could not read fixture request")
                if count == 0 { break }
                body.append(contentsOf: bytes.prefix(count))
            }
        }
        Self.requestBody = (try! JSONSerialization.jsonObject(with: body)) as! [String: Any]
        Self.requestBodies.append(Self.requestBody)
        if Self.anthropic {
            assert(request.value(forHTTPHeaderField: "Authorization") == nil)
            assert(request.value(forHTTPHeaderField: "x-api-key") == "test-key")
            assert(request.value(forHTTPHeaderField: "anthropic-version") == "2023-06-01")
        } else {
            assert(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-key")
        }
        if let failure = Self.failure { client?.urlProtocol(self, didFailWithError: URLError(failure)); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let payload = Self.payloads.isEmpty ? Self.payload : Self.payloads.removeFirst()
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
func json(_ text: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:] }
@main struct NetworkTests {
    static func main() async throws {
        assert(Network.usageNumber(NSNumber(value: 1e100)) == 1_000_000_000)
        assert(Network.usageNumber(NSNumber(value: -1)) == nil)
        assert(Network.usageInputTokens(["usage": ["input_tokens": 1e100, "cache_read_input_tokens": 1e100]]) == 2_000_000_000)

        let relayExtension = try Network.syncExtension("https://sync.example/v1/sync", name: "project-memory")
        let desktopExtension = try Network.syncExtension("https://desktop.example/api/mobile-sync", name: "project-memory")
        assert(relayExtension.path == "/v1/project-memory" && desktopExtension.path == "/api/project-memory-sync")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let beforeDenied = MockProtocol.requestBodies.count
        do {
            _ = try await Network.reply(messages: [.init(role: "user", content: "Describe this")], endpoint: "https://example.invalid/chat", model: "opaque-model", token: "test-key", imageInputs: [ImageInput(data: Data([1,2,3]), mimeType: "image/png")], modelCapabilities: ["vision":false], session: session)
            fatalError("Disabled image input reached provider")
        } catch {}
        assert(MockProtocol.requestBodies.count == beforeDenied, "Capability rejection must make zero provider requests")
        MockProtocol.status = 400
        MockProtocol.payload = "{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"maximum context length\"}}"
        do { _ = try await Network.reply(messages: [], endpoint: "https://example.invalid/chat", model: "test", token: "test-key", session: session); fatalError("Context error accepted") }
        catch { assert(error.localizedDescription.contains("上下文")) }
        MockProtocol.payload = "{\"error\":{\"code\":\"model_not_found\",\"message\":\"no model\"}}"
        do { _ = try await Network.reply(messages: [], endpoint: "https://example.invalid/chat", model: "test", token: "test-key", session: session); fatalError("Bad model accepted") }
        catch { assert(!error.localizedDescription.contains("上下文")) }
        MockProtocol.status = 200; MockProtocol.payload = "{\"choices\":[{\"message\":{\"content\":\"Hello iPhone\"}}]}"
        var observations: [ExecutionObservation] = []
        func reply() async throws -> ModelReply {
            observations = []
            return try await Network.reply(messages: [ChatMessage(role: "user",content: "Hello")], endpoint: "https://example.invalid/chat", model: "test-model", token: "test-key", session: session, onObservation: { observations.append($0) })
        }
        let result = try await reply()
        assert(result.text == "Hello iPhone" && !result.searched)
        assert(observations.first?.pipeline.first?.status == "running")
        assert(observations.last?.returnedModel == nil, "Missing model identity must not fall back to the requested model")
        assert(observations.last?.pipeline.map(\.id) == ["model:response", "reply:format"])
        MockProtocol.payload = "{\"model\":\"vendor/model-v1\",\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"参考 [来源](https://example.com/page)\"}}]}"
        let linked = try await reply()
        let observation = observations.last!
        assert(observation.returnedModel == "vendor/model-v1" && observation.pipeline.first?.returnedModel == "vendor/model-v1")
        assert(linked.sources.count == 1 && !linked.searched && observation.operations.isEmpty, "Answer links must never fabricate search activity")
        assert(observation.sources.count == 1 && observation.sources[0].cited && !observation.sources[0].accessed)
        assert(observation.sources[0].providers == ["API 回复"])
        var record = ExecutionRecord(chatId: "api", query: "Hello", requestedModel: "test-model")
        for value in observations { record.observe(value) }
        record.finish("completed", messageID: "answer")
        record.reconcileReferences(message: ChatMessage(id: "answer", role: "assistant", content: linked.text), annotations: linked.sources)
        let restored = try JSONDecoder().decode(ExecutionRecord.self, from: JSONEncoder().encode(record))
        assert(restored.returnedModel == "vendor/model-v1" && restored.pipeline?.allSatisfy { $0.status == "completed" } == true)
        assert(restored.sources[0].providers == ["API 回复"], "History reconciliation must not relabel an API citation as ChatGPT")
        MockProtocol.payload = "{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"content\":\"只有半段回答\"}}]}"
        do { _ = try await reply(); fatalError("Truncated answer accepted as complete") } catch {}
        assert(observations.last?.pipeline.first?.status == "failed")
        assert(observations.last?.pipeline.contains(where: { $0.id == "reply:format" }) == false)
        for reason in ["content_filter", "tool_calls"] {
            MockProtocol.payload = "{\"choices\":[{\"finish_reason\":\"\(reason)\",\"message\":{\"content\":\"未完成\"}}]}"
            do { _ = try await reply(); fatalError("Nonfinal finish reason accepted") } catch {}
        }
        do { _ = try Network.endpoint("http://example.invalid"); fatalError("Insecure endpoint accepted") } catch {}
        do { _ = try Network.endpoint("https://name:secret@example.invalid"); fatalError("URL credentials accepted") } catch {}
        MockProtocol.status = 401
        do { _ = try await Network.reply(messages: [], endpoint: "https://example.invalid/chat",model: "test",token: "test-key",session: session); fatalError("Unauthorized accepted") } catch {}
        MockProtocol.status = 200; MockProtocol.payload = "{\"choices\":[]}"
        do { _ = try await Network.reply(messages: [], endpoint: "https://example.invalid/chat",model: "test",token: "test-key",session: session); fatalError("Empty reply accepted") } catch {}
        for payload in ["{}", "{", "{\"choices\":[{\"message\":{\"content\":\"  \\n \"}}]}"] {
            MockProtocol.payload = payload
            do { _ = try await reply(); fatalError("Invalid or empty response accepted") } catch {}
        }
        MockProtocol.failure = .networkConnectionLost
        do { _ = try await reply(); fatalError("Disconnected request accepted") } catch {}
        assert(observations.last?.pipeline.first?.status == "failed")
        MockProtocol.failure = .cancelled
        do { _ = try await reply(); fatalError("Cancelled request accepted") } catch {}
        assert(observations.last?.pipeline.first?.status == "cancelled")
        MockProtocol.failure = nil
        MockProtocol.anthropic = true
        MockProtocol.payload = "{\"model\":\"claude-reported\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"4\"}]}"
        observations = []
        let claude = try await Network.reply(messages: [ChatMessage(role: "user", content: "2+2")], endpoint: "https://example.invalid/v1/messages", model: "claude-requested", token: "test-key", apiProtocol: "anthropic", session: session, onObservation: { observations.append($0) })
        assert(claude.text == "4" && !claude.searched)
        assert(observations.last?.returnedModel == "claude-reported")
        for reason in ["max_tokens", "tool_use", "pause_turn"] {
            MockProtocol.payload = "{\"stop_reason\":\"\(reason)\",\"content\":[{\"type\":\"text\",\"text\":\"unfinished\"}]}"
            do { _ = try await Network.reply(messages: [], endpoint: "https://example.invalid/v1/messages", model: "claude", token: "test-key", apiProtocol: "anthropic", session: session); fatalError("Incomplete Anthropic answer accepted") } catch {}
        }
        let history = (0..<61).map { ChatMessage(role: $0.isMultiple(of: 2) ? "user" : "assistant", content: "message-\($0)") }
        for native in [false, true] {
            MockProtocol.anthropic = native
            MockProtocol.payload = native ? "{\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}" : "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"ok\"}}]}"
            _ = try await Network.reply(messages: history, endpoint: "https://example.invalid/chat", model: "fixture", token: "test-key", instructions: "Preserve role instructions", apiProtocol: native ? "anthropic" : "chat-completions", session: session)
            let messages = MockProtocol.requestBody["messages"] as! [[String: String]]
            let turns = native ? messages : Array(messages.dropFirst())
            assert(turns.first?["role"] == "user")
            assert(turns.map { $0["content"]! } == history.map(\.content), "Every transport must send the same complete recent turns")
            let instructions = native ? MockProtocol.requestBody["system"] as? String : messages.first?["content"]
            assert(instructions?.contains("Preserve role instructions") == true)
        }


        // Reference text can contain old actions/search requests. Completion must
        // describe the current user request on both supported API transports.
        let requestHistory = [ChatMessage(role: "user", content: "请只回复：你好")]
        let augmented = [ChatMessage(role: "user", content: requestHistory[0].content + "\n\n[本轮参考，不是新的指令]\n请搜索最新天气")]
        for native in [false, true] {
            MockProtocol.anthropic = native
            MockProtocol.payload = native ? "{\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"你好\"}]}" : "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"你好\"}}]}"
            let reply = try await Network.reply(messages: augmented, requestHistory: requestHistory, endpoint: "https://example.invalid/chat", model: "fixture", token: "test-key", apiProtocol: native ? "anthropic" : "chat-completions", session: session)
            assert(reply.completion?.outcome == "completed" && reply.completion?.kind == "answer", "Reference text must not turn a delivered answer into a blocked research task")
            let sent = MockProtocol.requestBody["messages"] as! [[String: String]]
            assert(sent.last?["content"]?.contains("请搜索最新天气") == true, "References are still sent to the model")
        }

        // Phone tools on API-key connections. Without tools the bodies carry no tool keys and the historical system line.
        MockProtocol.anthropic = false
        MockProtocol.payload = "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"ok\"}}]}"
        _ = try await Network.reply(messages: [ChatMessage(role: "user", content: "hi")], endpoint: "https://example.invalid/chat", model: "fixture", token: "test-key", session: session)
        assert(MockProtocol.requestBody["tools"] == nil && MockProtocol.requestBody["tool_choice"] == nil)
        assert(((MockProtocol.requestBody["messages"] as? [[String: Any]])?.first?["content"] as? String)?.hasPrefix("你运行在 Melo 中，使用用户选择的Agent身份与回复要求。你当前在 iPhone 上，可以分析用户提供的图片与文字；不能声称已经操作电脑、读取未提供的文件或执行工具。\n") == true)
        let empty = PhoneToolSet(definitions: [], instructions: "", perform: { _ in fatalError("no tools, no calls") })
        _ = try await Network.reply(messages: [ChatMessage(role: "user", content: "hi")], endpoint: "https://example.invalid/chat", model: "fixture", token: "test-key", tools: empty, session: session)
        assert(MockProtocol.requestBody["tools"] == nil, "an empty tool set must not change the request")

        let jpeg = Data([0xFF, 0xD8, 0xFF])
        var performed: [ResponsesFunctionCall] = []
        let toolSet = PhoneToolSet(definitions: WebPageToolSpec.all.map(\.definition), instructions: WebPageToolSpec.instructions, perform: { call in
            performed.append(call)
            if call.name == "web_screenshot" { return PhoneToolResult(output: #"{"ok":true,"screenshot":"attached"}"#, imageJPEG: jpeg, imageURL: "https://a.example") }
            return PhoneToolResult(output: #"{"ok":true,"text":"page text"}"#)
        })
        // Chat Completions: tool_calls round, assistant echoed verbatim, one tool message per call, screenshot as a user image message, then the answer.
        MockProtocol.requestBodies = []
        MockProtocol.payloads = [
            "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"call_a\",\"type\":\"function\",\"function\":{\"name\":\"open_url\",\"arguments\":\"{\\\"url\\\":\\\"https://a.example\\\"}\"}},{\"id\":\"call_b\",\"type\":\"function\",\"function\":{\"name\":\"web_screenshot\",\"arguments\":\"{\\\"url\\\":\\\"https://a.example\\\"}\"}}]}}]}",
            "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"页面说 page text\"}}]}",
            String(data: try JSONSerialization.data(withJSONObject: ["choices": [["finish_reason": "stop", "message": ["content": #"{"decision":"complete","reasonType":"fulfilled","reason":"已查看页面","nextStep":"","requirements":[{"text":"查看页面","status":"met","evidenceIds":["call_a"]}]}"#]]]]), encoding: .utf8)!]
        let chatAnswer = try await Network.reply(messages: [ChatMessage(role: "user", content: "看看 https://a.example")], endpoint: "https://example.invalid/chat", model: "fixture", token: "test-key", instructions: "Role", tools: toolSet, session: session)
        assert(chatAnswer.text == "页面说 page text" && performed.map(\.name) == ["open_url", "web_screenshot"] && performed.map(\.callID) == ["call_a", "call_b"])
        assert(performed[0].arguments == #"{"url":"https://a.example"}"#)
        assert(MockProtocol.requestBodies.count == 3 && chatAnswer.completion?.outcome == "completed")
        let chatCheck = MockProtocol.requestBodies[2]
        assert(chatCheck["tools"] == nil && chatCheck["tool_choice"] == nil)
        assert(((chatCheck["messages"] as? [[String: Any]])?.first?["content"] as? String)?.contains("task completion checker") == true)
        let firstChat = MockProtocol.requestBodies[0]
        assert((firstChat["tools"] as? [[String: Any]])?.count == 2 && firstChat["tool_choice"] as? String == "auto")
        assert(((firstChat["tools"] as? [[String: Any]])?.first?["function"] as? [String: Any])?["name"] as? String == "open_url")
        let systemLine = (firstChat["messages"] as? [[String: Any]])?.first?["content"] as? String
        assert(systemLine?.contains("open_url") == true && systemLine?.contains("不能声称已经操作电脑、读取未提供的文件或执行工具") == false && systemLine?.hasSuffix("Role") == true)
        let secondChat = MockProtocol.requestBodies[1]["messages"] as! [[String: Any]]
        assert(secondChat.count == 6, "system, user, assistant(tool_calls), tool, tool, user(image)")
        assert(secondChat[2]["role"] as? String == "assistant" && (secondChat[2]["tool_calls"] as? [[String: Any]])?.count == 2 && secondChat[2]["content"] is NSNull)
        // Tool results reach the model as the shared envelope (2026-10-19); the tool's own JSON is its `output`.
        let toolContent = json(secondChat[3]["content"] as? String ?? "")
        assert(secondChat[3]["role"] as? String == "tool" && secondChat[3]["tool_call_id"] as? String == "call_a" && toolContent["status"] as? String == "ok" && toolContent["output"] as? String == #"{"ok":true,"text":"page text"}"#)
        assert(systemLine?.contains(AgentLoopContract.shared.contractNote) == true, "the envelope note joins the tool instructions")
        assert(secondChat[4]["tool_call_id"] as? String == "call_b")
        let chatImage = secondChat[5]["content"] as? [[String: Any]]
        assert(secondChat[5]["role"] as? String == "user" && chatImage?[0]["text"] as? String == "[web_screenshot of https://a.example]" && ((chatImage?[1]["image_url"] as? [String: Any])?["url"] as? String)?.hasPrefix("data:image/jpeg;base64,") == true)
        assert(MockProtocol.requestBodies[1]["tools"] != nil, "tools stay offered on the follow-up round")

        // Anthropic: tool_use round, assistant content echoed, tool_result blocks first, then the screenshot blocks in the same user message.
        MockProtocol.anthropic = true
        MockProtocol.requestBodies = []; performed = []
        MockProtocol.payloads = [
            "{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"text\",\"text\":\"我来看看\"},{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"web_screenshot\",\"input\":{\"url\":\"https://a.example\",\"fullPage\":true}}]}",
            "{\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"截图已附上\"}]}",
            String(data: try JSONSerialization.data(withJSONObject: ["stop_reason": "end_turn", "content": [["type": "text", "text": #"{"decision":"complete","reasonType":"fulfilled","reason":"截图已提供","nextStep":"","requirements":[{"text":"查看截图","status":"met","evidenceIds":["toolu_1"]}]}"#]]]), encoding: .utf8)!]
        let claudeAnswer = try await Network.reply(messages: [ChatMessage(role: "user", content: "截图 https://a.example")], endpoint: "https://example.invalid/v1/messages", model: "claude", token: "test-key", apiProtocol: "anthropic", tools: toolSet, session: session)
        assert(claudeAnswer.text == "截图已附上" && performed.count == 1 && performed[0].callID == "toolu_1")
        assert(MockProtocol.requestBodies.count == 3 && claudeAnswer.completion?.outcome == "completed")
        assert(MockProtocol.requestBodies[2]["tools"] == nil && MockProtocol.requestBodies[2]["tool_choice"] == nil)
        assert((MockProtocol.requestBodies[2]["system"] as? String)?.contains("task completion checker") == true)
        assert(json(performed[0].arguments)["fullPage"] as? Bool == true && json(performed[0].arguments)["url"] as? String == "https://a.example")
        let firstClaude = MockProtocol.requestBodies[0]
        assert((firstClaude["tools"] as? [[String: Any]])?.first?["input_schema"] != nil && firstClaude["tool_choice"] == nil)
        assert((firstClaude["system"] as? String)?.contains("web_screenshot") == true)
        let secondClaude = MockProtocol.requestBodies[1]["messages"] as! [[String: Any]]
        assert(secondClaude.count == 3, "user, assistant(tool_use), user(tool_result + image)")
        assert(secondClaude[1]["role"] as? String == "assistant" && (secondClaude[1]["content"] as? [[String: Any]])?.count == 2)
        let resultBlocks = secondClaude[2]["content"] as! [[String: Any]]
        assert(secondClaude[2]["role"] as? String == "user" && resultBlocks.count == 3)
        assert(resultBlocks[0]["type"] as? String == "tool_result" && resultBlocks[0]["tool_use_id"] as? String == "toolu_1" && json(resultBlocks[0]["content"] as? String ?? "")["output"] as? String == #"{"ok":true,"screenshot":"attached"}"#)
        assert(resultBlocks[1]["type"] as? String == "text" && resultBlocks[2]["type"] as? String == "image" && ((resultBlocks[2]["source"] as? [String: Any])?["media_type"] as? String) == "image/jpeg")

        // Audit I11: tool calls cut off by `length` / `max_tokens` are never executed; the truncation is reported.
        MockProtocol.anthropic = false; MockProtocol.requestBodies = []; performed = []
        MockProtocol.payloads = ["{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"call_cut\",\"type\":\"function\",\"function\":{\"name\":\"open_url\",\"arguments\":\"{\\\"url\\\":\\\"https://a.exa\"}}]}}]}"]
        do { _ = try await Network.reply(messages: [ChatMessage(role: "user", content: "x")], endpoint: "https://example.invalid/chat", model: "fixture", token: "test-key", tools: toolSet, session: session); fatalError("truncated tool call executed") }
        catch { assert(performed.isEmpty && MockProtocol.requestBodies.count == 1 && error.localizedDescription.contains("length"), error.localizedDescription) }
        MockProtocol.anthropic = true; MockProtocol.requestBodies = []
        MockProtocol.payloads = ["{\"stop_reason\":\"max_tokens\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"open_url\",\"input\":{\"url\":\"https://a.example\"}}]}"]
        do { _ = try await Network.reply(messages: [ChatMessage(role: "user", content: "x")], endpoint: "https://example.invalid/v1/messages", model: "claude", token: "test-key", apiProtocol: "anthropic", tools: toolSet, session: session); fatalError("truncated tool_use executed") }
        catch { assert(performed.isEmpty && MockProtocol.requestBodies.count == 1) }

        // Audit I12: the echoed assistant row carries only role/content/tool_calls (+ reasoning_content when sent).
        MockProtocol.anthropic = false; MockProtocol.requestBodies = []; performed = []
        MockProtocol.payloads = [
            "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":null,\"refusal\":null,\"annotations\":[],\"audio\":null,\"function_call\":null,\"reasoning_content\":\"let me look\",\"tool_calls\":[{\"id\":\"call_r\",\"type\":\"function\",\"function\":{\"name\":\"open_url\",\"arguments\":\"{\\\"url\\\":\\\"https://a.example\\\"}\"}}]}}]}",
            "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"ok\"}}]}"]
        _ = try await Network.reply(messages: [ChatMessage(role: "user", content: "x")], endpoint: "https://example.invalid/chat", model: "fixture", token: "test-key", tools: toolSet, session: session)
        let echoed = (MockProtocol.requestBodies[1]["messages"] as! [[String: Any]])[2]
        assert(Set(echoed.keys) == ["role", "content", "tool_calls", "reasoning_content"], "\(echoed.keys)")
        assert(echoed["content"] is NSNull && echoed["reasoning_content"] as? String == "let me look" && (echoed["tool_calls"] as? [[String: Any]])?.count == 1)
        assert(Set(Network.echoedAssistant(["role": "assistant", "content": "hi", "refusal": NSNull()]).keys) == ["role", "content"])
        assert(Network.echoedAssistant([:])["content"] is NSNull)

        // Audit I9: at most two screenshots per reply (the third is refused without rendering); earlier
        // rounds keep only the caption of their screenshots; a round's images are byte-budgeted, oldest first.
        func shotCall(_ id: String) -> String { "{\"id\":\"\(id)\",\"type\":\"function\",\"function\":{\"name\":\"web_screenshot\",\"arguments\":\"{\\\"url\\\":\\\"https://a.example\\\"}\"}}" }
        MockProtocol.requestBodies = []; performed = []
        MockProtocol.payloads = [
            "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[\(shotCall("s1")),\(shotCall("s2")),\(shotCall("s3"))]}}]}",
            "{\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[\(shotCall("s4"))]}}]}",
            "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"done\"}}]}"]
        let shots = try await Network.reply(messages: [ChatMessage(role: "user", content: "截图")], endpoint: "https://example.invalid/chat", model: "fixture", token: "test-key", tools: toolSet, session: session)
        assert(shots.text == "done" && performed.map(\.callID) == ["s1", "s2"], "third and fourth screenshots are refused without rendering: \(performed.map(\.callID))")
        let second = MockProtocol.requestBodies[1]["messages"] as! [[String: Any]]
        assert(second.count == 8, "system, user, assistant, tool×3, image×2: \(second.count)")
        assert((second[5]["content"] as? String)?.contains("TOO_MANY_SCREENSHOTS") == true && second[5]["tool_call_id"] as? String == "s3")
        assert((second[6]["content"] as? [[String: Any]])?.count == 2 && (second[7]["content"] as? [[String: Any]])?.count == 2)
        let third = MockProtocol.requestBodies[2]["messages"] as! [[String: Any]]
        assert(third.count == 10 && third[6]["content"] as? String == "[web_screenshot of https://a.example]" && third[7]["content"] as? String == "[web_screenshot of https://a.example]")
        assert(!third.contains { ($0["content"] as? [[String: Any]])?.contains { $0["type"] as? String == "image_url" } == true }, "no base64 image is re-sent on a later round")
        assert((third[9]["content"] as? String)?.contains("TOO_MANY_SCREENSHOTS") == true)
        let big = PhoneToolResult(output: "{}", imageJPEG: Data(count: 4 * 1024 * 1024), imageURL: "https://old.example")
        let later = PhoneToolResult(output: "{}", imageJPEG: Data(count: 3 * 1024 * 1024), imageURL: "https://new.example")
        let budgeted = Network.budgetedImages([("a", big), ("b", later)])
        assert(budgeted.map(\.url) == ["https://old.example", "https://new.example"] && budgeted[0].jpeg == nil && budgeted[1].jpeg != nil, "oldest dropped first")
        let budgetRows = Network.chatToolRound(assistant: ["role": "assistant"], results: [("a", big), ("b", later)])
        assert(budgetRows.count == 5 && budgetRows[3]["content"] as? String == "[web_screenshot of https://old.example]" && (budgetRows[4]["content"] as? [[String: Any]])?.count == 2)
        let claudeRows = Network.anthropicToolRound(assistant: [], results: [("a", big), ("b", later)])
        let claudeBlocks = claudeRows[1]["content"] as! [[String: Any]]
        assert(claudeBlocks.map { $0["type"] as? String } == ["tool_result", "tool_result", "text", "text", "image"])
        MockProtocol.payloads = []; MockProtocol.anthropic = true

        // Ten work rounds plus one tool-free report. A report that attempts
        // another tool call falls back to the limit reply without execution.
        MockProtocol.requestBodies = []; performed = []
        MockProtocol.payloads = (0..<12).map { "{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t\($0)\",\"name\":\"open_url\",\"input\":{\"url\":\"https://a.example/\($0)\"}}]}" }
        let limited = try await Network.reply(messages: [ChatMessage(role: "user", content: "一直查")], endpoint: "https://example.invalid/v1/messages", model: "claude", token: "test-key", apiProtocol: "anthropic", tools: toolSet, session: session)
        assert(limited.text == AgentLoopContract.shared.toolLimitReplyZH && performed.count == AgentLoopContract.shared.maxIterations && MockProtocol.requestBodies.count == AgentLoopContract.shared.maxIterations + 1)
        assert(MockProtocol.requestBodies.last?["tools"] == nil, "the final report offers no tools")
        // A call id the model already used in this turn is refused before anything runs (desktop T12).
        MockProtocol.requestBodies = []; performed = []
        MockProtocol.payloads = Array(repeating: "{\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"id\":\"same\",\"name\":\"open_url\",\"input\":{\"url\":\"https://a.example\"}}]}", count: 2)
        do { _ = try await Network.reply(messages: [ChatMessage(role: "user", content: "x")], endpoint: "https://example.invalid/v1/messages", model: "claude", token: "test-key", apiProtocol: "anthropic", tools: toolSet, session: session); fatalError("reused call id executed") }
        catch { assert(performed.count == 1 && MockProtocol.requestBodies.count == 2) }
        MockProtocol.payloads = []; MockProtocol.anthropic = false
        print("Swift network tests passed: compatible + Anthropic protocols, whole-turn request history, actual model, complete/empty/truncated replies, source evidence, pipeline persistence, transport cancellation, authorization and endpoint safety, phone tool rounds on both API protocols")
    }
}
