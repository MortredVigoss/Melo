import Foundation
final class MockProtocol: URLProtocol {
    static var status = 200
    static var failure: URLError.Code?
    static var anthropic = false
    static var requestBody: [String: Any] = [:]
    static var payload = "{\"choices\":[{\"message\":{\"content\":\"Hello iPhone\"}}]}"
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
        client?.urlProtocol(self, didLoad: Data(Self.payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@main struct NetworkTests {
    static func main() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
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
            assert(turns.map { $0["content"]! } == history.dropFirst(2).map(\.content), "Every transport must send the same complete recent turns")
            let instructions = native ? MockProtocol.requestBody["system"] as? String : messages.first?["content"]
            assert(instructions?.contains("Preserve role instructions") == true)
        }
        print("Swift network tests passed: compatible + Anthropic protocols, whole-turn request history, actual model, complete/empty/truncated replies, source evidence, pipeline persistence, transport cancellation, authorization and endpoint safety")
    }
}
