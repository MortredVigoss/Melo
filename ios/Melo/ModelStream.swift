import Foundation

/// Incremental API-key response decoder. Keeps tool arguments private until a
/// completed tool turn, and reconstitutes the same receipt the JSON path uses.
struct ModelStreamDecoder {
    let anthropic: Bool
    var text = ""
    var hasTools = false
    var completed = false
    private var line = Data()
    private var eventLines = [String]()
    private var bytes = 0
    private var receipt = [String: Any]()
    private var calls = [Int: [String: Any]]()
    private var blocks = [Int: [String: Any]]()
    private var arguments = [Int: String]()
    private var reasoning = ""
    private var finishReason: String?
    private var usage = [String: Any]()
    var revision = 0

    mutating func accept(_ byte: UInt8, maxBytes: Int = 8 * 1024 * 1024) throws {
        bytes += 1
        guard bytes <= maxBytes else { throw MeloError.message("响应超过当前版本的容量限制。") }
        if byte == 10 {
            guard let decoded = String(data: line, encoding: .utf8) else { throw MeloError.message("模型响应格式无效，未保存为完整回答。") }
            line.removeAll(keepingCapacity: true)
            let value = decoded.hasSuffix("\r") ? String(decoded.dropLast()) : decoded
            if value.isEmpty { try dispatch() }
            else if value.hasPrefix("data:") { eventLines.append(String(value.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
        } else { line.append(byte) }
    }

    private mutating func dispatch() throws {
        guard !eventLines.isEmpty else { return }
        let data = eventLines.joined(separator: "\n"); eventLines.removeAll(keepingCapacity: true)
        if data == "[DONE]" {
            guard !anthropic, finishReason != nil else { throw MeloError.message("模型未完成回复。") }
            completed = true; return
        }
        guard !completed, let value = try JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any], value["error"] == nil else { throw MeloError.message("模型流中断，未保存为完整回答。") }
        revision += 1
        if anthropic {
            switch value["type"] as? String {
            case "message_start":
                receipt = value["message"] as? [String: Any] ?? [:]
                usage = receipt["usage"] as? [String: Any] ?? [:]
            case "content_block_start":
                guard let index = value["index"] as? Int, index >= 0, index < 1024, let block = value["content_block"] as? [String: Any], blocks[index] == nil else { throw MeloError.message("模型响应格式无效，未保存为完整回答。") }
                blocks[index] = block
                if block["type"] as? String == "tool_use" { hasTools = true }
                if block["type"] as? String == "text" { text += block["text"] as? String ?? "" }
            case "content_block_delta":
                guard let index = value["index"] as? Int, var block = blocks[index], let delta = value["delta"] as? [String: Any] else { throw MeloError.message("模型响应格式无效，未保存为完整回答。") }
                switch delta["type"] as? String {
                case "text_delta":
                    let part = delta["text"] as? String ?? ""; text += part; block["text"] = (block["text"] as? String ?? "") + part
                case "input_json_delta": arguments[index, default: ""] += delta["partial_json"] as? String ?? ""
                case "thinking_delta": block["thinking"] = (block["thinking"] as? String ?? "") + (delta["thinking"] as? String ?? "")
                case "signature_delta": block["signature"] = (block["signature"] as? String ?? "") + (delta["signature"] as? String ?? "")
                default: break
                }
                blocks[index] = block
            case "message_delta":
                finishReason = (value["delta"] as? [String: Any])?["stop_reason"] as? String
                usage.merge(value["usage"] as? [String: Any] ?? [:]) { _, new in new }
            case "message_stop":
                guard finishReason != nil else { throw MeloError.message("模型未完成回复。") }; completed = true
            case "error": throw MeloError.message("模型流中断，未保存为完整回答。")
            default: break
            }
        } else {
            for key in ["id", "model"] { if let v = value[key] { receipt[key] = v } }
            if let u = value["usage"] as? [String: Any] { usage = u }
            guard let choice = (value["choices"] as? [[String: Any]])?.first(where: { ($0["index"] as? Int ?? 0) == 0 }) else { return }
            if let reason = choice["finish_reason"] as? String { finishReason = reason }
            let delta = choice["delta"] as? [String: Any] ?? [:]
            text += delta["content"] as? String ?? ""
            reasoning += delta["reasoning_content"] as? String ?? ""
            for call in delta["tool_calls"] as? [[String: Any]] ?? [] {
                guard let index = call["index"] as? Int, index >= 0, index < 1024 else { throw MeloError.message("模型响应格式无效，未保存为完整回答。") }
                hasTools = true
                var row = calls[index] ?? ["type": "function"]
                if let id = call["id"] { row["id"] = id }
                var function = row["function"] as? [String: Any] ?? [:]
                for (key, value) in call["function"] as? [String: String] ?? [:] { function[key] = (function[key] as? String ?? "") + value }
                row["function"] = function; calls[index] = row
            }
        }
    }

    mutating func finish() throws -> Data {
        if !line.isEmpty { try accept(10) }; try dispatch()
        guard completed else { throw URLError(.networkConnectionLost) }
        if anthropic {
            for (index, raw) in arguments {
                guard let object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { throw MeloError.message("模型工具参数不完整，未执行。") }
                blocks[index]?["input"] = object
            }
            receipt["content"] = blocks.keys.sorted().compactMap { blocks[$0] }; receipt["stop_reason"] = finishReason
        } else {
            var message: [String: Any] = ["role": "assistant", "content": text]
            if hasTools {
                let ordered = calls.keys.sorted().compactMap { calls[$0] }
                for call in ordered {
                    guard call["id"] is String, let f = call["function"] as? [String: Any], f["name"] is String, let args = f["arguments"] as? String,
                          (try? JSONSerialization.jsonObject(with: Data(args.utf8))) is [String: Any] else { throw MeloError.message("模型工具参数不完整，未执行。") }
                }
                message["tool_calls"] = ordered
            }
            if !reasoning.isEmpty { message["reasoning_content"] = reasoning }
            receipt["choices"] = [["message": message, "finish_reason": finishReason ?? ""]]
        }
        receipt["usage"] = usage
        return try JSONSerialization.data(withJSONObject: receipt)
    }
}
