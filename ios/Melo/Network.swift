import Foundation

final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
enum Network {
    struct ExtensionUnavailable: Error {}
    /// A context-length rejection; the loop condenses older tool outputs and retries once.
    static func contextLimitError(_ data: Data) -> RequestTooLarge? {
        guard data.count <= 16_384, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let error = json["error"] as? [String: Any] else { return nil }
        let code = (error["code"] as? String ?? "").lowercased()
        let message = (error["message"] as? String ?? "").lowercased()
        guard ["context_length_exceeded", "max_tokens_exceeded", "prompt_too_long"].contains(code) || ["maximum context length", "context window", "prompt is too long", "input is too long"].contains(where: { message.contains($0) }) else { return nil }
        return RequestTooLarge(message: "对话或引用资料超出此模型的上下文上限。请减少资料、缩短本次输入，或新建对话；原记录已保留。")
    }
    // Keep diagnostic codes, not the provider's arbitrary message or echoed request data.
    static func rejectionDetail(_ data: Data) -> String {
        guard data.count <= 16_384, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = object["error"] as? [String: Any] else { return "" }
        let fields = ["code", "param"].compactMap { field -> String? in
            guard let value = error[field] as? String, value.count <= 100,
                  value.range(of: #"^[A-Za-z][A-Za-z0-9_.\[\]-]*$"#, options: .regularExpression) != nil,
                  !value.hasPrefix("sk-"), !value.hasPrefix("eyJ") else { return nil }
            return "\(field)=\(value)"
        }
        return fields.isEmpty ? "" : "（" + fields.joined(separator: "，") + "）"
    }
    static let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
    static func endpoint(_ value: String) throws -> URL {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.fragment == nil else { throw MeloError.message("请输入完整的 HTTPS 服务地址。") }
        return url
    }
    static func syncExtension(_ endpoint: String, name: String) throws -> URL {
        let base = try self.endpoint(endpoint)
        let suffix = base.lastPathComponent == "mobile-sync" ? name + "-sync" : name
        return base.deletingLastPathComponent().appendingPathComponent(suffix)
    }
    static func post(_ url: URL, token: String, body: Data, session: URLSession = Network.session, headers: [String: String] = [:], maxBytes: Int = 8 * 1024 * 1024, timeout: TimeInterval = 120, optionalExtension: Bool = false) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if headers["x-api-key"] == nil { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw MeloError.message("服务未返回有效响应。") }
        if optionalExtension && http.statusCode == 404 { throw ExtensionUnavailable() }
        guard (200..<300).contains(http.statusCode) else {
            if [400, 413, 422].contains(http.statusCode), let contextError = contextLimitError(data) { throw contextError }
            switch http.statusCode {
            case 400, 422: throw MeloError.message("服务拒绝了本次请求（\(http.statusCode)）\(rejectionDetail(data))，请检查所选模型、工具或输入内容；原记录已保留。")
            case 413: throw RequestTooLarge(message: "资料超过服务容量限制（413），原记录已保留。请先导出备份，再减少同步资料或本次输入。")
            case 401, 403: throw MeloError.message("服务拒绝了登录凭证，请检查设置中的密钥。")
            case 409: throw MeloError.message("同步内容发生冲突，原有记录已保留。")
            case 429: throw MeloError.message("请求过于频繁或额度不足，请稍后重试。")
            default: throw MeloError.message("服务暂时不可用（\(http.statusCode)），记录已保存在手机。")
            }
        }
        guard data.count <= maxBytes else { throw MeloError.message("响应超过当前版本的容量限制。") }
        return data
    }
    /// System line for API connections. Without tools it is byte-identical to
    /// the historical text; with tools it names them instead of denying them
    /// (the tool instructions end with the shared envelope note).
    static func systemLine(toolInstructions: String?) -> String {
        guard let toolInstructions else { return "你运行在 Melo 中，使用用户选择的Agent身份与回复要求。你当前在 iPhone 上，可以分析用户提供的图片与文字；不能声称已经操作电脑、读取未提供的文件或执行工具。\n" }
        return "你运行在 Melo 中，使用用户选择的Agent身份与回复要求。你当前在 iPhone 上，可以分析用户提供的图片与文字，并可以调用下面提供的手机工具；除这些工具外不能声称已经操作电脑、读取未提供的文件或执行其他工具。\n" + toolInstructions + "\n"
    }
    /// Provider-reported input tokens of one response (chat-completions or Anthropic, cache reads included).
    static func usageNumber(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, number.doubleValue.isFinite, number.doubleValue >= 0 else { return nil }
        return Int(min(1_000_000_000, number.doubleValue))
    }
    static func usageInputTokens(_ receipt: [String: Any]?) -> Int? {
        guard let usage = receipt?["usage"] as? [String: Any] else { return nil }
        if let input = usageNumber(usage["input_tokens"]) {
            return input + (usageNumber(usage["cache_read_input_tokens"]) ?? 0) + (usageNumber(usage["cache_creation_input_tokens"]) ?? 0)
        }
        return usageNumber(usage["prompt_tokens"])
    }

    /// Tool calls of one Chat Completions assistant message.
    static func chatToolCalls(_ message: [String: Any]) -> [ResponsesFunctionCall] {
        ((message["tool_calls"] as? [[String: Any]]) ?? []).compactMap { call in
            guard let id = call["id"] as? String, let function = call["function"] as? [String: Any], let name = function["name"] as? String else { return nil }
            return ResponsesFunctionCall(callID: id, name: name, arguments: function["arguments"] as? String ?? "{}")
        }
    }
    /// tool_use blocks of one Anthropic assistant message; input is re-serialized as a JSON string.
    static func anthropicToolCalls(_ content: [[String: Any]]) -> [ResponsesFunctionCall] {
        content.compactMap { block in
            guard block["type"] as? String == "tool_use", let id = block["id"] as? String, let name = block["name"] as? String else { return nil }
            let input = block["input"] as? [String: Any] ?? [:]
            let arguments = (try? JSONSerialization.data(withJSONObject: input)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            return ResponsesFunctionCall(callID: id, name: name, arguments: arguments)
        }
    }
    /// The assistant message echoed back in a Chat Completions tool round:
    /// only `role`, `content` (string or null), `tool_calls` and, when the
    /// provider sent one, `reasoning_content` (DeepSeek-style). Extra fields
    /// such as `refusal: null`, `annotations`, `audio` or `function_call`
    /// make some providers reject the follow-up request.
    static func echoedAssistant(_ message: [String: Any]) -> [String: Any] {
        var row: [String: Any] = ["role": "assistant", "content": (message["content"] as? String).map { $0 as Any } ?? NSNull()]
        if let calls = message["tool_calls"] as? [[String: Any]], !calls.isEmpty { row["tool_calls"] = calls }
        if let reasoning = message["reasoning_content"] as? String, !reasoning.isEmpty { row["reasoning_content"] = reasoning }
        return row
    }
    /// Screenshot JPEGs of one round that fit the per-request byte budget
    /// (oldest dropped first); the dropped ones keep their caption text only.
    static func budgetedImages(_ results: [(callID: String, result: PhoneToolResult)]) -> [(url: String, jpeg: Data?)] {
        let images = results.compactMap { item in item.result.imageJPEG.map { (url: item.result.imageURL, jpeg: $0) } }
        let kept = WebPageText.keptImages(sizes: images.map(\.jpeg.count))
        return images.enumerated().map { ($0.element.url, kept[$0.offset] ? $0.element.jpeg : nil) }
    }
    /// Messages appended after a Chat Completions tool round: the assistant
    /// message (whitelisted), one tool message per call, then screenshots as a user message.
    static func chatToolRound(assistant: [String: Any], results: [(callID: String, result: PhoneToolResult)]) -> [[String: Any]] {
        var rows: [[String: Any]] = [echoedAssistant(assistant)]
        rows += results.map { ["role": "tool", "tool_call_id": $0.callID, "content": $0.result.output] as [String: Any] }
        rows += budgetedImages(results).map { image in
            image.jpeg.map { WebPageText.chatImageMessage(url: image.url, dataURL: WebPageText.dataURL(jpeg: $0)) } ?? ["role": "user", "content": WebPageText.caption(url: image.url)]
        }
        return rows
    }
    /// Messages appended after an Anthropic tool round: the assistant content
    /// verbatim and one user message of tool_result blocks (+ screenshot blocks).
    static func anthropicToolRound(assistant: [[String: Any]], results: [(callID: String, result: PhoneToolResult)]) -> [[String: Any]] {
        var blocks: [[String: Any]] = results.map { ["type": "tool_result", "tool_use_id": $0.callID, "content": $0.result.output] as [String: Any] }
        for image in budgetedImages(results) {
            if let jpeg = image.jpeg { blocks += WebPageText.anthropicImageBlocks(url: image.url, jpeg: jpeg) }
            else { blocks.append(["type": "text", "text": WebPageText.caption(url: image.url)]) }
        }
        return [["role": "assistant", "content": assistant], ["role": "user", "content": blocks]]
    }

    /// One reply on an API-key connection (chat-completions or Anthropic). The
    /// request body without tools is unchanged; with phone tools the turn runs
    /// through AgentLoop (same limits, budget, envelopes and finalize as the desktop).
    static func reply(messages: [ChatMessage], requestHistory: [ChatMessage]? = nil, endpoint: String, model: String, token: String, instructions: String = "", apiProtocol: String = "chat-completions", imageInputs: [ImageInput] = [], tools: PhoneToolSet? = nil, session: URLSession = Network.session, budget: PhoneRunBudget? = nil, verification: AgentVerification? = nil, hooks: AgentLoopHooks = AgentLoopHooks(), onObservation: (@MainActor (ExecutionObservation) -> Void)? = nil, onStatus: (@MainActor (String) -> Void)? = nil) async throws -> ModelReply {
        try ConversationHistory.validateCurrentInput(messages.last(where: { $0.role == "user" })?.content ?? "", instructions: instructions)
        guard !token.isEmpty, !model.trimmingCharacters(in: .whitespaces).isEmpty else { throw MeloError.message("先在设置中填写模型服务和 API 密钥。") }
        let loopTools = (tools?.definitions.isEmpty ?? true) ? nil : tools?.loopTools
        let anthropic = apiProtocol == "anthropic"
        var body: [String: Any] = ["model": model, "stream": false, "messages": [["role": "system", "content": systemLine(toolInstructions: loopTools?.instructionsWithContract) + instructions]] + ImageRequestBody.chat(messages: messages, inputs: imageInputs, anthropic: anthropic, instructions: instructions)]
        var headers: [String: String] = [:]
        if anthropic {
            let original = body["messages"] as! [[String: Any]]
            body = ["model": model, "stream": false, "max_tokens": 8192, "system": original[0]["content"] ?? "", "messages": Array(original.dropFirst())]
            headers = ["x-api-key": token, "anthropic-version": "2023-06-01"]
        }
        if let loopTools {
            if anthropic { body["tools"] = loopTools.definitions.map(\.anthropicDefinition) }
            else { body["tools"] = loopTools.definitions.map(\.chatCompletionsDefinition); body["tool_choice"] = "auto" }
        }
        let url = try self.endpoint(endpoint)
        let transport = APIChatTransport(url: url, token: token, headers: headers, session: session, anthropic: anthropic, apiProtocol: apiProtocol, model: model, base: body, offersTools: loopTools != nil, onObservation: onObservation)
        transport.observation.stage("model:response", name: "模型请求", status: "running", output: "等待服务返回", model: model)
        await onObservation?(transport.observation)
        var loopHooks = hooks
        if loopHooks.onStatus == nil { loopHooks.onStatus = onStatus }
        let loop = AgentLoop(transport: transport, tools: loopTools, budget: budget ?? PhoneRunBudget(), latestUserMessage: (requestHistory ?? messages).last(where: { $0.role == "user" })?.content ?? "", verification: verification, hooks: loopHooks)
        loop.goalHistory = requestHistory ?? messages
        do {
            let outcome = try await loop.run()
            if outcome.stop != .answered {
                transport.observation.stage("model:response", name: "模型请求", status: "completed", output: outcome.stop == .toolLimit ? "已达到工具执行上限，本轮停止" : "运行预算已用完，本轮停止")
                await onObservation?(transport.observation)
            }
            return ModelReply(text: outcome.text, sources: outcome.sources, searched: outcome.searched, completion: outcome.completion)
        } catch {
            let cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
            transport.observation.stage("model:response", name: "模型请求", status: cancelled ? "cancelled" : "failed", output: cancelled ? "请求已取消" : "未取得完整响应")
            await onObservation?(transport.observation)
            throw error
        }
    }
}

/// Chat-completions and Anthropic as single-round AgentLoop transports. Each
/// round re-renders the turn: the base body, then every tool round (assistant
/// echo, tool results first, this round's screenshots; earlier screenshots
/// reduced to their caption), then supplements as user text.
final class APIChatTransport: AgentModelTransport, @unchecked Sendable {
    let url: URL, token: String, headers: [String: String], session: URLSession
    let anthropic: Bool, apiProtocol: String, model: String
    let base: [String: Any]
    let offersTools: Bool
    let timeoutCap: TimeInterval = 120
    var observation = ExecutionObservation()
    let onObservation: (@MainActor (ExecutionObservation) -> Void)?

    init(url: URL, token: String, headers: [String: String], session: URLSession, anthropic: Bool, apiProtocol: String, model: String, base: [String: Any], offersTools: Bool, onObservation: (@MainActor (ExecutionObservation) -> Void)?) {
        self.url = url; self.token = token; self.headers = headers; self.session = session
        self.anthropic = anthropic; self.apiProtocol = apiProtocol; self.model = model
        self.base = base; self.offersTools = offersTools; self.onObservation = onObservation
    }

    /// Messages for one request: the base rows plus the rendered transcript.
    static func rendered(_ rows: [[String: Any]], transcript: [AgentTranscriptItem], anthropic: Bool) -> [[String: Any]] {
        var rows = rows
        for item in transcript {
            switch item {
            case .toolRound(let round, let results):
                let pairs = results.map { (callID: $0.call.callID, result: $0.phoneResult) }
                if anthropic {
                    guard case .anthropic(let content) = round.echo else { continue }
                    rows = WebPageText.demotedAnthropicMessages(rows) + Network.anthropicToolRound(assistant: content, results: pairs)
                } else {
                    guard case .chat(let message) = round.echo else { continue }
                    rows = WebPageText.demotedChatMessages(rows) + Network.chatToolRound(assistant: message, results: pairs)
                }
            case .userText(let text):
                // Anthropic keeps strict turn order: the supplement joins the tool_result message, after its blocks.
                if anthropic, var last = rows.last, last["role"] as? String == "user", var blocks = last["content"] as? [[String: Any]] {
                    blocks.append(["type": "text", "text": text]); last["content"] = blocks; rows[rows.count - 1] = last
                } else { rows.append(["role": "user", "content": text]) }
            }
        }
        return rows
    }

    func round(_ input: AgentLoopRequest) async throws -> AgentRound {
        if input.iteration > 0 {
            observation.stage("model:response", name: "模型请求", status: "running", output: "工具结果已返回，等待模型继续", model: model)
            await onObservation?(observation)
        }
        var body = base
        if let review = input.goalReview {
            let messages = review["messages"] as? [[String: Any]] ?? []
            let system = review["systemPrompt"] as? String ?? ""
            body = anthropic ? ["model": model, "stream": false, "max_tokens": 2048, "system": system, "messages": messages] : ["model": model, "stream": false, "messages": [["role": "system", "content": system]] + messages]
        } else if !input.transcript.isEmpty { body["messages"] = Self.rendered(base["messages"] as? [[String: Any]] ?? [], transcript: input.transcript, anthropic: anthropic) }
        if let allowance = try PhoneMemberLimits.outputAllowance(body: body, remaining: input.remainingTokens) {
            body["max_tokens"] = min(allowance, (body["max_tokens"] as? Int) ?? allowance)
        }
        let payload = try JSONSerialization.data(withJSONObject: body)
        let data = try await Network.post(url, token: token, body: payload, session: session, headers: headers, timeout: max(1, min(timeoutCap, input.timeout)))
        try Task.checkCancellation()
        let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        var finishReason: String?
        if let receipt {
            let choices = receipt["choices"] as? [[String: Any]]
            finishReason = receipt["stop_reason"] as? String ?? choices?.first?["finish_reason"] as? String
            observation.apiReceipt(receipt, transport: apiProtocol, finishReason: finishReason)
            await onObservation?(observation)
        }
        let usage = Network.usageInputTokens(receipt), estimate = RequestSizeEstimate.tokens(payload)
        let usageObject = receipt?["usage"] as? [String: Any]
        let outputTokens = Network.usageNumber(usageObject?["output_tokens"]) ?? Network.usageNumber(usageObject?["completion_tokens"])
        // Tool round: only a completed tool turn counts; calls cut off by `length` /
        // `max_tokens` are never executed (the truncation is reported below).
        if input.goalReview == nil, offersTools, let receipt, finishReason == (anthropic ? "tool_use" : "tool_calls") {
            let assistantMessage = ((receipt["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any]) ?? [:]
            let assistantContent = receipt["content"] as? [[String: Any]] ?? []
            let calls = anthropic ? Network.anthropicToolCalls(assistantContent) : Network.chatToolCalls(assistantMessage)
            if !calls.isEmpty {
                let text = anthropic ? assistantContent.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined() : assistantMessage["content"] as? String ?? ""
                return AgentRound(text: text, calls: calls, echo: anthropic ? .anthropic(assistantContent) : .chat(assistantMessage), inputTokens: usage, estimatedInputTokens: estimate, outputTokens: outputTokens)
            }
        }
        struct Response: Decodable {
            struct Choice: Decodable {
                struct Message: Decodable { var content: String? }
                var message: Message
                var finish_reason: String?
            }
            var model: String?
            var choices: [Choice]
        }
        let response: Response
        do {
            if anthropic {
                struct Native: Decodable {
                    struct Block: Decodable { var type: String; var text: String? }
                    var content: [Block]; var model: String?; var stop_reason: String?
                }
                let native = try JSONDecoder().decode(Native.self, from: data)
                guard ["end_turn", "stop_sequence"].contains(native.stop_reason ?? "") else { throw MeloError.message("模型未完成回复。") }
                response = Response(model: native.model, choices: [.init(message: .init(content: native.content.filter { $0.type == "text" }.compactMap(\.text).joined()), finish_reason: "stop")])
            } else { response = try JSONDecoder().decode(Response.self, from: data) }
        }
        catch { throw MeloError.message("模型响应格式无效，未保存为完整回答。") }
        let returned = response.model?.trimmingCharacters(in: .whitespacesAndNewlines)
        observation.returnedModel = returned?.isEmpty == false ? returned : nil
        guard let choice = response.choices.first else { throw MeloError.message("模型没有返回文字内容。") }
        if let reason = choice.finish_reason, !reason.isEmpty, reason != "stop" {
            throw MeloError.message("模型未完成回复（\(String(reason.prefix(60)))），未保存为完整回答。")
        }
        guard let text = choice.message.content, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MeloError.message("模型没有返回文字内容。") }
        observation.stage("model:response", name: "模型请求", status: "completed", output: "模型文字返回完成" + (observation.returnedModel.map { " · 服务返回模型：\($0)" } ?? " · 服务未报告模型标识"))
        observation.stage("reply:format", name: "整理回答与引用", status: "running", output: "处理服务返回的文字与引用标记")
        await onObservation?(observation)
        let sources = WebReplyFormatter.references(in: text)
        for source in sources { observation.source(url: source.url, title: source.title, cited: true, provider: "API 回复") }
        observation.stage("reply:format", name: "整理回答与引用", status: "completed", output: "文字与 \(sources.count) 条引用已整理；无搜索调用记录")
        await onObservation?(observation)
        return AgentRound(text: text, sources: sources, inputTokens: usage, estimatedInputTokens: estimate, outputTokens: outputTokens)
    }

    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String {
        let rows = messages.map { ["role": $0.role, "content": $0.content] as [String: Any] }
        let body: [String: Any] = anthropic
            ? ["model": model, "stream": false, "max_tokens": 2048, "system": system, "messages": rows]
            : ["model": model, "stream": false, "messages": [["role": "system", "content": system]] + rows]
        let data = try await Network.post(url, token: token, body: JSONSerialization.data(withJSONObject: body), session: session, headers: headers, timeout: max(1, min(timeoutCap, timeout)))
        let receipt = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if anthropic { return (receipt["content"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined() }
        return (((receipt["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any])?["content"] as? String) ?? ""
    }
}
