import Foundation

// From codex/reply-latency-20261109 (merged 2026-11-14): the stream of an API-key model request is read
// while it arrives and handed on as the JSON of a non-streamed reply. The decoder follows the desktop's
// readers (src/providers/streams.js, anthropic.js); the cases below marked "desktop rule" pin that.

func frame(_ object: [String: Any]) -> String {
    "data: " + String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)! + "\r\n\r\n"
}
func decode(_ input: String, anthropic: Bool = false) throws -> [String: Any] {
    var decoder = ModelStreamDecoder(anthropic: anthropic)
    for byte in input.utf8 { try decoder.accept(byte) }
    return try JSONSerialization.jsonObject(with: decoder.finish()) as! [String: Any]
}
func message(_ receipt: [String: Any]) -> [String: Any] { (receipt["choices"] as! [[String: Any]])[0]["message"] as! [String: Any] }
func rejected(_ input: String, anthropic: Bool = false) -> Bool { (try? decode(input, anthropic: anthropic)) == nil }

/// Sends the first text, then holds the rest of the response until the test says it has seen that text
/// as a draft. The order "draft first, end of response after" is then a fact, not a timing.
final class HeldModelProtocol: URLProtocol, @unchecked Sendable {
    static var gate = DispatchSemaphore(value: 0)
    static var releasedByDraft = false
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(frame(["model":"fixture", "choices":[["index":0,"delta":["content":"你好 🌌"],"finish_reason":NSNull()]]]).utf8))
        let gate = Self.gate
        DispatchQueue.global().async { [self] in
            Self.releasedByDraft = gate.wait(timeout: .now() + 10) == .success
            lock.lock(); defer { lock.unlock() }
            guard !stopped else { return }
            client?.urlProtocol(self, didLoad: Data((frame(["choices":[["index":0,"delta":[:],"finish_reason":"stop"]],"usage":["prompt_tokens":12,"completion_tokens":4]]) + "data: [DONE]\n\n").utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { lock.withLock { stopped = true } }
}
/// A server that ignores `stream: true` and answers with plain JSON.
final class PlainModelProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"model":"plain","choices":[{"finish_reason":"stop","message":{"content":"整段返回"}}],"usage":{"prompt_tokens":3}}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct ModelStreamTests {
    @MainActor static func main() async throws {
        // A character split across network chunks, usage, and the same JSON as a non-streamed reply.
        let chat = frame(["id":"r1", "model":"opaque", "choices":[["index":0,"delta":["content":"你好 🌌"],"finish_reason":NSNull()]]]) + frame(["choices":[["index":0,"delta":[:],"finish_reason":"stop"]],"usage":["prompt_tokens":15,"completion_tokens":8]]) + "data: [DONE]\n\n"
        let object = try decode(chat)
        assert(Network.usageInputTokens(object) == 15 && object["model"] as? String == "opaque")
        assert(message(object)["content"] as! String == "你好 🌌")
        assert((object["choices"] as! [[String: Any]])[0]["finish_reason"] as? String == "stop")

        // Tool arguments arrive in pieces and are joined; nothing is lost when a later piece repeats the
        // name or carries a null one (desktop rule: a name replaces, arguments are appended).
        let tools = frame(["choices":[["index":0,"delta":["tool_calls":[["index":0,"id":"c1","type":"function","function":["name":"open_url","arguments":"{\"url\":"]]]]]]])
            + frame(["choices":[["index":0,"delta":["tool_calls":[["index":0,"function":["name":NSNull(),"arguments":"\"https://exa"]]]]]]])
            + frame(["choices":[["index":0,"delta":["tool_calls":[["index":0,"function":["name":"open_url","arguments":"mple.com\"}"]]]],"finish_reason":"tool_calls"]]]) + "data: [DONE]\n\n"
        let toolReceipt = try decode(tools)
        let call = Network.chatToolCalls(message(toolReceipt)).first
        assert(call?.callID == "c1" && call?.name == "open_url" && call?.arguments == "{\"url\":\"https://example.com\"}")
        assert((toolReceipt["choices"] as! [[String: Any]])[0]["finish_reason"] as? String == "tool_calls")

        // A server that sends no call id (master 2026-11-10: such a call used to be dropped) streams none
        // either: the call is kept and gets its id where the non-streamed reply gets it.
        let unnamed = frame(["choices":[["index":0,"delta":["tool_calls":[["function":["name":"open_url","arguments":"{\"url\":\"https://a.example\"}"]]]]]]])
            + frame(["choices":[["index":0,"delta":["tool_calls":[["function":["name":"open_url","arguments":"{\"url\":\"https://b.example\"}"]]]],"finish_reason":"tool_calls"]]]) + "data: [DONE]\n\n"
        var used = Set<String>()
        let identified = Network.identifiedToolCalls(message(try decode(unnamed)), used: &used)
        let unnamedCalls = Network.chatToolCalls(identified)
        assert(unnamedCalls.map(\.callID) == ["call_1", "call_2"], "a fragment without an index starts a new call (desktop rule)")
        assert(unnamedCalls.map(\.arguments) == ["{\"url\":\"https://a.example\"}", "{\"url\":\"https://b.example\"}"])

        // A tool that takes no arguments streams none: it runs with an empty object, on both protocols.
        let bare = frame(["choices":[["index":0,"delta":["tool_calls":[["index":0,"id":"c2","function":["name":"device_location","arguments":""]]]],"finish_reason":"tool_calls"]]]) + "data: [DONE]\n\n"
        let bareCalls = Network.chatToolCalls(message(try decode(bare)))
        assert(bareCalls.first?.arguments == "{}")
        let native = frame(["type":"message_start","message":["id":"a","model":"opaque","usage":["input_tokens":10,"cache_read_input_tokens":20]]])
          + frame(["type":"content_block_start","index":0,"content_block":["type":"text","text":""]])
          + frame(["type":"content_block_delta","index":0,"delta":["type":"text_delta","text":"原生 🌌"]])
          + frame(["type":"content_block_start","index":1,"content_block":["type":"tool_use","id":"a1","name":"open_url","input":[:]]])
          + frame(["type":"content_block_delta","index":1,"delta":["type":"input_json_delta","partial_json":"{\"url\":\"https://exam"]])
          + frame(["type":"content_block_delta","index":1,"delta":["type":"input_json_delta","partial_json":"ple.com\"}"]])
          + frame(["type":"content_block_start","index":2,"content_block":["type":"tool_use","id":"a2","name":"device_location","input":[:]]])
          + frame(["type":"content_block_delta","index":2,"delta":["type":"input_json_delta","partial_json":""]])
          + frame(["type":"message_delta","delta":["stop_reason":"tool_use"],"usage":["output_tokens":7]])
          + frame(["type":"message_stop"])
        let a = try decode(native, anthropic: true)
        assert(Network.usageInputTokens(a) == 30 && a["stop_reason"] as? String == "tool_use")
        let nativeCalls = Network.anthropicToolCalls(a["content"] as! [[String:Any]])
        let nativeArguments = (try JSONSerialization.jsonObject(with: Data(nativeCalls[0].arguments.utf8))) as? [String: String]
        assert(nativeCalls.map(\.callID) == ["a1", "a2"] && nativeArguments == ["url": "https://example.com"] && nativeCalls[1].arguments == "{}")
        assert(((a["content"] as! [[String: Any]])[0]["text"] as? String) == "原生 🌌")

        // The end of a stream (desktop rule). Chat Completions: `[DONE]`, or a finish reason when the
        // server closes without one; what follows the finish reason (usage) is still read. Anthropic:
        // `message_stop`.
        let noDone = String(chat.dropLast("data: [DONE]\n\n".count))
        let closedWithoutDone = try decode(noDone)
        assert(message(closedWithoutDone)["content"] as? String == "你好 🌌", "a finish reason ends the reply when the server sends no [DONE]")
        let lateUsage = frame(["choices":[["index":0,"delta":["content":"好"],"finish_reason":NSNull()]]]) + frame(["choices":[["index":0,"delta":[:],"finish_reason":"stop"]]]) + frame(["choices":[],"usage":["prompt_tokens":9]]) + "data: [DONE]\n\n"
        let withLateUsage = try decode(lateUsage)
        assert(Network.usageInputTokens(withLateUsage) == 9)
        let cut = frame(["model":"opaque", "choices":[["index":0,"delta":["content":"你好"],"finish_reason":NSNull()]]])
        assert(rejected(cut), "a stream that stops without a finish reason is a cut reply")
        assert(rejected(String(cut.dropLast(8))), "and so is one cut inside an event")
        assert(rejected(String(native.prefix(native.count - frame(["type":"message_stop"]).count)), anthropic: true))
        assert(rejected("data: {invalid}\n\n"))
        assert(rejected(frame(["error":["message":"overloaded"]])))
        assert(rejected(frame(["type":"error","error":["message":"private secret"]]), anthropic: true))
        // Arguments cut off in the middle are never run (Anthropic sends them as text to be parsed).
        let halfInput = frame(["type":"message_start","message":["id":"a"]]) + frame(["type":"content_block_start","index":0,"content_block":["type":"tool_use","id":"a1","name":"open_url","input":[:]]])
            + frame(["type":"content_block_delta","index":0,"delta":["type":"input_json_delta","partial_json":"{\"url\":\"https://exam"]]) + frame(["type":"message_delta","delta":["stop_reason":"tool_use"]]) + frame(["type":"message_stop"])
        assert(rejected(halfInput, anthropic: true))
        // Keep-alive comments and `event:` lines carry nothing and break nothing.
        let withComments = try decode(": keep-alive\n\nevent: message\n" + chat)
        assert(message(withComments)["content"] as? String == "你好 🌌")
        var limited = ModelStreamDecoder(anthropic: false)
        do { for byte in chat.utf8 { try limited.accept(byte, maxBytes: 20) }; fatalError("Size limit not enforced") } catch {}
        var argumentLimit = ModelStreamDecoder(anthropic: false)
        let hugeArguments = frame(["choices":[["index":0,"delta":["tool_calls":[["index":0,"id":"c","function":["name":"t","arguments":String(repeating:"x", count: ModelStreamDecoder.maxToolArgumentCharacters + 1)]]]]]]])
        do { for byte in hugeArguments.utf8 { try argumentLimit.accept(byte) }; fatalError("Tool argument limit not enforced") } catch {}

        // The draft is hidden once a tool call starts: text before a tool call is not an answer.
        var preamble = ModelStreamDecoder(anthropic: false)
        for byte in frame(["choices":[["index":0,"delta":["content":"让我查一下"]]]]).utf8 { try preamble.accept(byte) }
        assert(preamble.text == "让我查一下" && !preamble.hasTools)
        for byte in frame(["choices":[["index":0,"delta":["tool_calls":[["index":0,"id":"c","function":["name":"open_url","arguments":"{}"]]]]]]]).utf8 { try preamble.accept(byte) }
        assert(preamble.hasTools)

        // Through the transport: the first text is shown while the response is still open, each request
        // keeps its own stage with the time of its first text, and a check neither shows a draft nor
        // touches a stage.
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [HeldModelProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        var rows = [ExecutionStage](), drafts = [String](), published = 0
        var receivingBeforeFinished = false
        let transport = APIChatTransport(url: URL(string:"https://example.invalid/chat")!, token:"fixture", headers:[:], session:session, anthropic:false, apiProtocol:"chat-completions", model:"fixture", base:["model":"fixture","messages":[]], offersTools:false, onObservation:{ published += 1; rows += $0.pipeline; if $0.pipeline.contains(where:{ $0.status == "running" && $0.output == "正在接收模型输出" }) { receivingBeforeFinished = true } })
        var request=AgentLoopRequest(iteration:0, transcript:[], timeout:15)
        request.onDraft = { value in drafts.append(value); if !value.isEmpty { HeldModelProtocol.gate.signal() } }
        HeldModelProtocol.gate = DispatchSemaphore(value: 0); HeldModelProtocol.releasedByDraft = false
        let firstRound=try await transport.round(request)
        assert(HeldModelProtocol.releasedByDraft, "the first text must be shown before the response has ended")
        assert(firstRound.text == "你好 🌌" && drafts.last == firstRound.text && receivingBeforeFinished)
        HeldModelProtocol.gate = DispatchSemaphore(value: 0)
        _ = try await transport.round(request)
        let modelRows=rows.filter { $0.id.hasPrefix("model:") }
        assert(Set(modelRows.map(\.id)).count == 2, "Each request must retain its own timing")
        let completed=modelRows.filter { $0.status == "completed" }
        assert(Set(completed.map(\.id)).count == 2 && completed.allSatisfy { $0.api?["firstTextMs"] != nil && $0.api?["firstEventMs"] != nil && $0.api?["durationMs"] != nil })
        var record=ExecutionRecord(chatId:"fixture",query:"hello",requestedModel:"fixture")
        for id in Set(completed.map(\.id)) { var observation=ExecutionObservation(); observation.pipeline = rows.filter { $0.id == id }; for stage in observation.pipeline { var single=ExecutionObservation();single.pipeline=[stage];record.observe(single) } }
        assert(record.pipeline?.filter { $0.id.hasPrefix("model:") }.count == 2)
        let publishedBeforeCheck = published, draftsBeforeCheck = drafts.count
        var check = AgentLoopRequest(iteration: 1, transcript: [], timeout: 15, goalReview: ["systemPrompt": "check", "messages": [["role": "user", "content": "{}"]]])
        check.onDraft = nil
        HeldModelProtocol.gate = DispatchSemaphore(value: 1)
        _ = try await transport.round(check)
        assert(published == publishedBeforeCheck && drafts.count == draftsBeforeCheck, "a check has no stage and no draft")

        // A server that does not stream is read as before.
        let plainConfig = URLSessionConfiguration.ephemeral; plainConfig.protocolClasses = [PlainModelProtocol.self]
        let plainSession = URLSession(configuration: plainConfig); defer { plainSession.invalidateAndCancel() }
        var plainStages = [ExecutionStage]()
        let plain = APIChatTransport(url: URL(string:"https://example.invalid/chat")!, token:"fixture", headers:[:], session:plainSession, anthropic:false, apiProtocol:"chat-completions", model:"fixture", base:["model":"fixture","messages":[]], offersTools:false, onObservation:{ plainStages = $0.pipeline })
        let plainRound = try await plain.round(AgentLoopRequest(iteration: 0, transcript: [], timeout: 15))
        assert(plainRound.text == "整段返回" && plainRound.inputTokens == 3)
        assert(plainStages.first(where: { $0.id.hasPrefix("model:") })?.api?["firstTextMs"] == nil, "no first-text time is made up for a reply that was not streamed")
        print("Model streaming: split characters, joined tool arguments, calls without ids, tools without arguments, end-of-stream rules, limits, early draft, per-request stages and the non-streaming fallback passed")
    }
}
