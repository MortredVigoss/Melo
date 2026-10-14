import Foundation
import CryptoKit
import Security

// Public-client ChatGPT plan authorization. Credentials never enter chat/sync payloads.
enum ChatGPTProtocol {
    static let issuer = "https://auth.openai.com"
    static let resource = "https://api.openai.com/v1"
    static let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func decode64(_ text: String) throws -> Data {
        let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.count % 4) % 4)
        guard let value = Data(base64Encoded: padded) else { throw MeloError.message("授权数据格式无效，请重新登录。") }
        return value
    }
    static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw MeloError.message("无法生成安全登录请求。") }
        return base64URL(Data(bytes))
    }
    static func form(_ values: [String: String]) -> Data {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return Data(values.sorted { $0.key < $1.key }.map { "\($0.key.addingPercentEncoding(withAllowedCharacters: allowed)!)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&").utf8)
    }
    static func callback(_ url: URL, redirect: URL, state: String, clientID: String?) throws -> (code: String, clientID: String) {
        guard url.scheme == redirect.scheme, url.host == redirect.host, url.port == redirect.port, url.path == redirect.path, url.fragment == nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { throw MeloError.message("登录返回地址不匹配。") }
        var query: [String: String] = [:]
        for item in items {
            guard query[item.name] == nil, let value = item.value else { throw MeloError.message("登录返回参数无效。") }
            query[item.name] = value
        }
        guard query["state"] == state else { throw MeloError.message("登录校验失败，请重新登录。") }
        if query["error"] != nil { throw MeloError.message("授权未完成。请在官方页面允许 Melo 使用你的 ChatGPT 计划。") }
        guard let code = query["code"], !code.isEmpty, let issued = query["client_id"] ?? clientID, !issued.isEmpty, issued != "dynamic_agent_client",
              clientID == nil || issued == clientID else { throw MeloError.message("登录注册未完成，请重试。") }
        return (code, issued)
    }
    static func validateIDToken(_ token: String, jwks: Data, clientID: String, nonce: String?, now: Date = Date()) throws -> (subject: String, email: String) {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3,
              let header = try JSONSerialization.jsonObject(with: decode64(parts[0])) as? [String: Any], header["alg"] as? String == "RS256", let kid = header["kid"] as? String,
              let keySet = try JSONSerialization.jsonObject(with: jwks) as? [String: Any], let keys = keySet["keys"] as? [[String: Any]],
              let key = keys.first(where: { $0["kid"] as? String == kid && $0["kty"] as? String == "RSA" && ($0["alg"] as? String ?? "RS256") == "RS256" }),
              let n = key["n"] as? String, let e = key["e"] as? String else { throw MeloError.message("无法验证官方登录签名。") }
        func der(_ tag: UInt8, _ body: Data) -> Data {
            var length = body.count
            var encoded = [UInt8]()
            repeat { encoded.insert(UInt8(length & 255), at: 0); length >>= 8 } while length > 0
            let prefix: [UInt8] = body.count < 128 ? [UInt8(body.count)] : [0x80 | UInt8(encoded.count)] + encoded
            return Data([tag] + prefix) + body
        }
        func integer(_ value: Data) -> Data { der(2, (value.first ?? 0) >= 128 ? Data([0]) + value : value) }
        let keyData = try der(0x30, integer(decode64(n)) + integer(decode64(e)))
        let attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic]
        guard let publicKey = SecKeyCreateWithData(keyData as CFData, attributes as CFDictionary, nil),
              SecKeyVerifySignature(publicKey, .rsaSignatureMessagePKCS1v15SHA256, Data("\(parts[0]).\(parts[1])".utf8) as CFData, try decode64(parts[2]) as CFData, nil),
              let claims = try JSONSerialization.jsonObject(with: decode64(parts[1])) as? [String: Any] else { throw MeloError.message("登录签名验证失败。") }
        let audiences = (claims["aud"] as? [String]) ?? (claims["aud"] as? String).map { [$0] } ?? []
        guard claims["iss"] as? String == issuer, audiences.contains(clientID),
              audiences.count == 1 || claims["azp"] as? String == clientID,
              let expiry = claims["exp"] as? Double, expiry > now.timeIntervalSince1970 - 30,
              (claims["nbf"] as? Double ?? 0) <= now.timeIntervalSince1970 + 30,
              nonce == nil || claims["nonce"] as? String == nonce,
              let subject = claims["sub"] as? String, !subject.isEmpty else { throw MeloError.message("登录身份或有效期校验失败，请重新登录。") }
        return (subject, claims["email"] as? String ?? "ChatGPT 账号")
    }
}

struct ChatGPTStream {
    private let acceptImageCompletion: Bool
    private var reportedImageModel = ""
    init(acceptImageCompletion: Bool = false) { self.acceptImageCompletion = acceptImageCompletion }
    private(set) var observation = ExecutionObservation()
    private(set) var completed = false
    private(set) var text = ""
    private(set) var sources: [WebSource] = []
    private(set) var searched = false
    private(set) var searching = false
    private(set) var images: [ImagePayload] = []
    private(set) var generatingImage = false
    mutating func accept(_ json: String) throws {
        if json == "[DONE]" { return }
        guard let data = json.data(using: .utf8), let event = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = event["type"] as? String else { throw MeloError.message("模型响应格式无效。") }
        observation.accept(event)
        if let response = event["response"] as? [String:Any], let tools = response["tools"] as? [[String:Any]],
           let model = tools.first(where: { $0["type"] as? String == "image_generation" })?["model"] as? String {
            reportedImageModel = model
        }
        if type.hasPrefix("response.image_generation_call.") || (event["item"] as? [String: Any])?["type"] as? String == "image_generation_call" {
            generatingImage = true
            observation.stage("image:generate", name: "处理图片", status: "running", output: "图片服务正在生成结果")
        }
        if type == "response.failed" || type == "response.incomplete" || type == "error" {
            let details = (event["response"] as? [String: Any]) ?? (type == "error" && event["error"] == nil ? ["error": event] : event)
            let detailData = (try? JSONSerialization.data(withJSONObject: details)) ?? Data()
            throw MeloError.message("模型未完成回复\(Network.rejectionDetail(detailData))，请检查所选模型、工具支持和计划额度；本次要求已保留。")
        }
        if type.hasPrefix("response.web_search_call.") { searching = !type.hasSuffix("completed"); if type.hasSuffix("completed") { searched = true } }
        if type == "response.output_text.delta", let delta = event["delta"] as? String { text += delta }
        // Codex can deliver the complete image before the response tail. Only a
        // completed image tool item qualifies; partial images/text never do.
        if acceptImageCompletion, type == "response.output_item.done", let item = event["item"] as? [String:Any],
           item["type"] as? String == "image_generation_call", item["status"] as? String == "completed" {
            images = [try ImagePayload.decode(base64:item["result"] as? String,model:item["model"] as? String ?? reportedImageModel,prompt:item["revised_prompt"] as? String ?? "")]
            observation.stage("image:generate",name:"处理图片",status:"completed",output:"已收到完整图片")
            if let index = observation.pipeline.firstIndex(where: { $0.id == "image:generate" }) { observation.pipeline[index].returnedModel = images.first?.reportedModel.isEmpty == false ? images.first?.reportedModel : nil }
            generatingImage=false; completed=true
        }
        if type == "response.completed" {
            guard let response = event["response"] as? [String: Any], response["status"] as? String == "completed" else { throw MeloError.message("模型未完成回复。") }
            observation.stage("reply:format", name: "整理回答与引用", status: "running", output: "处理服务返回的文字与引用标记")
            // Completed output is authoritative; never save an interrupted partial answer.
            if let output = response["output"] as? [[String: Any]] {
                searched = searched || output.contains { $0["type"] as? String == "web_search_call" && $0["status"] as? String == "completed" }
                searching = false
                let imageItems = output.filter { $0["type"] as? String == "image_generation_call" }
                guard imageItems.count <= 4 else { throw MeloError.message("单次图片返回超过四张，未写入对话。") }
                images = try imageItems.map { item in
                    guard item["status"] as? String == "completed" else { throw MeloError.message("图片尚未生成完成。") }
                    return try ImagePayload.decode(base64: item["result"] as? String, model: item["model"] as? String ?? reportedImageModel, prompt: item["revised_prompt"] as? String ?? "")
                }
                if !images.isEmpty {
                    observation.stage("image:generate", name: "处理图片", status: "completed", output: "已收到 \(images.count) 张完整图片")
                    if let index = observation.pipeline.firstIndex(where: { $0.id == "image:generate" }) { observation.pipeline[index].returnedModel = images.first?.reportedModel.isEmpty == false ? images.first?.reportedModel : nil }
                }
                generatingImage = false
                var pieces: [String] = []
                for item in output where item["type"] as? String == "message" {
                    for part in item["content"] as? [[String: Any]] ?? [] {
                        if part["type"] as? String == "output_text", let value = part["text"] as? String {
                            let (formatted, references) = WebReplyFormatter.format(value, annotations: part["annotations"] as? [[String: Any]] ?? [])
                            pieces.append(formatted)
                            sources = WebReplyFormatter.references(in: "", annotations: sources + references)
                            for source in references {
                                observation.source(url: source.url, title: source.title, cited: true)
                            }
                        } else if part["type"] as? String == "refusal", let refusal = part["refusal"] as? String { pieces.append(refusal) }
                    }
                }
                let final = pieces.joined(separator: "\n")
                if !final.isEmpty { text = final }
            }
            observation.stage("reply:format", name: "整理回答与引用", status: "completed", output: "回答格式与引用整理完成")
            completed = true
        }
    }
    func result() throws -> String {
        guard completed, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else { throw MeloError.message("连接中断或模型未返回完整文字，消息已保留，可以重试。") }
        return text.isEmpty ? "图片已生成。" : text
    }
}

// AsyncBytes.lines drops blank lines. SSE must preserve them to delimit events.
struct ChatGPTSSE {
    private var line = Data()
    private var eventLines: [String] = []
    private var previousCR = false
    private var byteCount = 0
    private let maxBytes: Int
    init(maxBytes: Int = 8 * 1024 * 1024, acceptImageCompletion: Bool = false) { self.maxBytes = maxBytes; self.stream = ChatGPTStream(acceptImageCompletion: acceptImageCompletion) }
    private(set) var stream: ChatGPTStream
    mutating func accept(_ byte: UInt8) throws {
        byteCount += 1
        guard byteCount <= maxBytes else { throw MeloError.message("模型响应超过容量限制。") }
        if byte == 10 && previousCR { previousCR = false; return }
        previousCR = byte == 13
        if byte == 10 || byte == 13 { try finishLine() } else { line.append(byte) }
    }
    private mutating func finishLine() throws {
        guard let text = String(data: line, encoding: .utf8) else { throw MeloError.message("模型回复包含无效的文本编码。") }
        line.removeAll(keepingCapacity: true)
        if text.isEmpty {
            if !eventLines.isEmpty {
                do { try stream.accept(eventLines.joined(separator: "\n")) }
                catch is DecodingError { throw MeloError.message("模型事件解析失败，请重试。") }
                catch let error as NSError where error.domain == NSCocoaErrorDomain { throw MeloError.message("模型事件解析失败，请重试。") }
                eventLines.removeAll(keepingCapacity: true)
            }
        } else if text.hasPrefix("data:") {
            var value = String(text.dropFirst(5)); if value.first == " " { value.removeFirst() }
            eventLines.append(value)
        }
    }
    mutating func finish() throws -> String {
        // A missing delimiter is a truncated event, not a successful answer.
        guard line.isEmpty, eventLines.isEmpty else { throw MeloError.message("回复传输中断，请重试。") }
        return try stream.result()
    }
}
