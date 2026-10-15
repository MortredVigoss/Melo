import Foundation

final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
enum Network {
    struct ExtensionUnavailable: Error {}
    static func contextLimitError(_ data: Data) -> MeloError? {
        guard data.count <= 16_384, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let error = json["error"] as? [String: Any] else { return nil }
        let code = (error["code"] as? String ?? "").lowercased()
        let message = (error["message"] as? String ?? "").lowercased()
        guard ["context_length_exceeded", "max_tokens_exceeded", "prompt_too_long"].contains(code) || ["maximum context length", "context window", "prompt is too long", "input is too long"].contains(where: { message.contains($0) }) else { return nil }
        return .message("对话或引用资料超出此模型的上下文上限。请减少资料、缩短本次输入，或新建对话；原记录已保留。")
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
            case 413: throw MeloError.message("资料超过服务容量限制（413），原记录已保留。请先导出备份，再减少同步资料或本次输入。")
            case 401, 403: throw MeloError.message("服务拒绝了登录凭证，请检查设置中的密钥。")
            case 409: throw MeloError.message("同步内容发生冲突，原有记录已保留。")
            case 429: throw MeloError.message("请求过于频繁或额度不足，请稍后重试。")
            default: throw MeloError.message("服务暂时不可用（\(http.statusCode)），记录已保存在手机。")
            }
        }
        guard data.count <= maxBytes else { throw MeloError.message("响应超过当前版本的容量限制。") }
        return data
    }
    static func reply(messages: [ChatMessage], endpoint: String, model: String, token: String, instructions: String = "", apiProtocol: String = "chat-completions", imageInputs: [ImageInput] = [], session: URLSession = Network.session, onObservation: ((ExecutionObservation) -> Void)? = nil) async throws -> ModelReply {
        try ConversationHistory.validateCurrentInput(messages.last(where: { $0.role == "user" })?.content ?? "", instructions: instructions)
        guard !token.isEmpty, !model.trimmingCharacters(in: .whitespaces).isEmpty else { throw MeloError.message("先在设置中填写模型服务和 API 密钥。") }
        var body: [String: Any] = ["model": model, "stream": false, "messages": [["role": "system", "content": "你运行在 Melo 中，使用用户选择的Agent身份与回复要求。你当前在 iPhone 上，可以分析用户提供的图片与文字；不能声称已经操作电脑、读取未提供的文件或执行工具。\n" + instructions]] + ImageRequestBody.chat(messages: messages, inputs: imageInputs, anthropic: apiProtocol == "anthropic", instructions: instructions)]
        var headers: [String: String] = [:]
        if apiProtocol == "anthropic" {
            let original = body["messages"] as! [[String: Any]]
            body = ["model": model, "stream": false, "max_tokens": 8192, "system": original[0]["content"] ?? "", "messages": Array(original.dropFirst())]
            headers = ["x-api-key": token, "anthropic-version": "2023-06-01"]
        }
        let url = try self.endpoint(endpoint), payload = try JSONSerialization.data(withJSONObject: body)
        var observation = ExecutionObservation()
        observation.stage("model:response", name: "模型请求", status: "running", output: "等待服务返回", model: model)
        onObservation?(observation)
        do {
            let data = try await post(url, token: token, body: payload, session: session, headers: headers)
            try Task.checkCancellation()
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
                if apiProtocol == "anthropic" {
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
            onObservation?(observation)
            let sources = WebReplyFormatter.references(in: text)
            for source in sources { observation.source(url: source.url, title: source.title, cited: true, provider: "API 回复") }
            observation.stage("reply:format", name: "整理回答与引用", status: "completed", output: "文字与 \(sources.count) 条引用已整理；无搜索调用记录")
            onObservation?(observation)
            return ModelReply(text: text, sources: sources)
        } catch {
            let cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
            observation.stage("model:response", name: "模型请求", status: cancelled ? "cancelled" : "failed", output: cancelled ? "请求已取消" : "未取得完整响应")
            onObservation?(observation)
            throw error
        }
    }
}
