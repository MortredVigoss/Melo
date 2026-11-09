import Foundation

func frame(_ object: [String: Any]) -> String {
    "data: " + String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)! + "\r\n\r\n"
}
func decode(_ input: String, anthropic: Bool = false) throws -> [String: Any] {
    var decoder = ModelStreamDecoder(anthropic: anthropic)
    for byte in input.utf8 { try decoder.accept(byte) }
    return try JSONSerialization.jsonObject(with: decoder.finish()) as! [String: Any]
}
final class DelayedModelProtocol: URLProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(frame(["model":"fixture", "choices":[["index":0,"delta":["content":"你好 🌌"],"finish_reason":NSNull()]]]).utf8))
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { [self] in
            lock.lock(); defer { lock.unlock() }
            guard !stopped else { return }
            client?.urlProtocol(self, didLoad: Data((frame(["choices":[["index":0,"delta":[:],"finish_reason":"stop"]],"usage":["prompt_tokens":12,"completion_tokens":4]]) + "data: [DONE]\n\n").utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { lock.withLock { stopped = true } }
}

@main struct ModelStreamTests {
    @MainActor static func main() async throws {
        let chat = frame(["model":"opaque", "choices":[["index":0,"delta":["content":"你好 🌌"],"finish_reason":NSNull()]]]) + frame(["choices":[["index":0,"delta":[:],"finish_reason":"stop"]],"usage":["prompt_tokens":15,"completion_tokens":8]]) + "data: [DONE]\n\n"
        let object = try decode(chat)
        assert(Network.usageInputTokens(object) == 15)
        assert(((object["choices"] as! [[String:Any]])[0]["message"] as! [String:Any])["content"] as! String == "你好 🌌")
        let tools = frame(["choices":[["index":0,"delta":["tool_calls":[["index":0,"id":"c1","function":["name":"open_url","arguments":"{\"url\":"]]]]]]]) + frame(["choices":[["index":0,"delta":["tool_calls":[["index":0,"function":["arguments":"\"https://example.com\"}"]]]],"finish_reason":"tool_calls"]]]) + "data: [DONE]\n\n"
        let toolMessage = ((try decode(tools))["choices"] as! [[String:Any]])[0]["message"] as! [String:Any]
        assert(Network.chatToolCalls(toolMessage).first?.arguments == "{\"url\":\"https://example.com\"}")
        let native = frame(["type":"message_start","message":["id":"a","model":"opaque","usage":["input_tokens":10,"cache_read_input_tokens":20]]])
          + frame(["type":"content_block_start","index":0,"content_block":["type":"text","text":""]])
          + frame(["type":"content_block_delta","index":0,"delta":["type":"text_delta","text":"原生 🌌"]])
          + frame(["type":"content_block_start","index":1,"content_block":["type":"tool_use","id":"a1","name":"open_url","input":[:]]])
          + frame(["type":"content_block_delta","index":1,"delta":["type":"input_json_delta","partial_json":"{\"url\":\"https://example.com\"}"]])
          + frame(["type":"message_delta","delta":["stop_reason":"tool_use"],"usage":["output_tokens":7]])
          + frame(["type":"message_stop"])
        let a = try decode(native, anthropic: true)
        assert(Network.usageInputTokens(a) == 30)
        assert(Network.anthropicToolCalls(a["content"] as! [[String:Any]]).first?.callID == "a1")
        for (value, isAnthropic) in [(String(chat.dropLast(14)),false),(String(native.prefix(native.count - frame(["type":"message_stop"]).count)),true),("data: {invalid}\n\n",false),(frame(["type":"error","error":["message":"private secret"]]),true)] {
            do { _ = try decode(value, anthropic: isAnthropic); fatalError("Incomplete stream accepted") } catch {}
        }
        var limited = ModelStreamDecoder(anthropic: false)
        do { for byte in chat.utf8 { try limited.accept(byte, maxBytes: 20) }; fatalError("Size limit not enforced") } catch {}
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [DelayedModelProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        var rows = [ExecutionStage](), drafts = [String](), first: Date?
        var receivingBeforeFinished = false
        let transport = APIChatTransport(url: URL(string:"https://example.invalid/chat")!, token:"fixture", headers:[:], session:session, anthropic:false, apiProtocol:"chat-completions", model:"fixture", base:["model":"fixture","messages":[]], offersTools:false, onObservation:{ rows += $0.pipeline; if $0.pipeline.contains(where:{ $0.status == "running" && $0.output == "正在接收模型输出" }) { receivingBeforeFinished = true } })
        let start=Date()
        var request=AgentLoopRequest(iteration:0, transcript:[], timeout:5)
        request.onDraft = { value in if first == nil { first=Date() }; drafts.append(value) }
        let firstRound=try await transport.round(request)
        assert(firstRound.text == "你好 🌌" && drafts.last == firstRound.text && receivingBeforeFinished)
        assert(first!.timeIntervalSince(start) < 0.25 && Date().timeIntervalSince(first!) >= 0.20, "First text must arrive before response completion")
        _ = try await transport.round(request)
        let modelRows=rows.filter { $0.id.hasPrefix("model:") }
        assert(Set(modelRows.map(\.id)).count == 2, "Each request must retain its own timing")
        let completed=modelRows.filter { $0.status == "completed" }
        assert(Set(completed.map(\.id)).count == 2 && completed.allSatisfy { $0.api?["firstTextMs"] != nil && $0.api?["durationMs"] != nil })
        var record=ExecutionRecord(chatId:"fixture",query:"hello",requestedModel:"fixture")
        for id in Set(completed.map(\.id)) { var observation=ExecutionObservation(); observation.pipeline = rows.filter { $0.id == id }; for stage in observation.pipeline { var single=ExecutionObservation();single.pipeline=[stage];record.observe(single) } }
        assert(record.pipeline?.filter { $0.id.hasPrefix("model:") }.count == 2)
        print("Model streaming: fragmented UTF-8, tool JSON, usage, truncation, byte limit, early text and unique request receipts passed")
    }
}
