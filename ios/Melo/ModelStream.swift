import Foundation

/// Reads the event stream of one API-key model request (Chat Completions or
/// Anthropic Messages) and puts it together again as the JSON the same request
/// returns without streaming, so everything after the request is one code path.
/// The text so far is available while the stream runs; tool arguments are not
/// shown and nothing is executed before the stream has ended properly.
///
/// The rules for an OpenAI-compatible stream are the desktop's
/// (`readChatCompletionsSseResponse` in src/providers/streams.js): a stream is
/// complete at `[DONE]` or once a finish reason has arrived, a tool call
/// fragment without an index starts a new call, a name replaces, arguments are
/// appended. An Anthropic stream is complete at `message_stop`, as on the
/// desktop (src/providers/anthropic.js).
struct ModelStreamDecoder {
    static let maxToolArgumentCharacters = 256 * 1024
    let anthropic: Bool
    /// The reply text received so far.
    private(set) var text = ""
    /// A tool call has started: the text is then not an answer and is not shown as a draft.
    private(set) var hasTools = false
    /// Counts the events read, so a caller can tell when there is something new.
    private(set) var revision = 0
    private var completed = false
    private var closed = false
    private var line = Data()
    private var eventLines = [String]()
    private var bytes = 0
    private var receipt = [String: Any]()
    private var calls = [Int: [String: Any]]()
    private var blocks = [Int: [String: Any]]()
    private var partialInput = [Int: String]()
    private var reasoning = ""
    private var finishReason: String?
    private var usage = [String: Any]()

    private static let invalid = MeloError.message("模型响应格式无效，未保存为完整回答。")
    private static let interrupted = MeloError.message("模型流中断，未保存为完整回答。")
    private static let oversized = MeloError.message("响应超过当前版本的容量限制。")

    mutating func accept(_ byte: UInt8, maxBytes: Int = 8 * 1024 * 1024) throws {
        bytes += 1
        guard bytes <= maxBytes else { throw Self.oversized }
        guard byte == 10 else { line.append(byte); return }
        // A line is decoded whole, so a character split across network chunks is never cut.
        guard let decoded = String(data: line, encoding: .utf8) else { throw Self.invalid }
        line.removeAll(keepingCapacity: true)
        let value = decoded.hasSuffix("\r") ? String(decoded.dropLast()) : decoded
        if value.isEmpty { try dispatch() }
        else if value.hasPrefix("data:") { eventLines.append(String(value.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
        // `event:` lines and `:` comments (keep-alives) carry nothing the reply needs.
    }

    private mutating func dispatch() throws {
        guard !eventLines.isEmpty else { return }
        let data = eventLines.joined(separator: "\n"); eventLines.removeAll(keepingCapacity: true)
        guard !closed else { return }
        if data == "[DONE]" {
            guard !anthropic else { return }
            completed = true; closed = true; return
        }
        guard let value = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else { throw Self.invalid }
        guard value["error"] == nil else { throw Self.interrupted }
        revision += 1
        if anthropic { try anthropicEvent(value) } else { try chatEvent(value) }
    }

    private mutating func chatEvent(_ value: [String: Any]) throws {
        for key in ["id", "model"] { if let v = value[key] as? String, !v.isEmpty { receipt[key] = v } }
        if let u = value["usage"] as? [String: Any] { usage = u }
        guard let choice = (value["choices"] as? [[String: Any]])?.first(where: { ($0["index"] as? Int ?? 0) == 0 }) else { return }
        if let reason = choice["finish_reason"] as? String, !reason.isEmpty { finishReason = reason; completed = true }
        let delta = choice["delta"] as? [String: Any] ?? [:]
        text += delta["content"] as? String ?? ""
        reasoning += delta["reasoning_content"] as? String ?? ""
        for fragment in delta["tool_calls"] as? [[String: Any]] ?? [] {
            let index = fragment["index"] as? Int ?? calls.count
            guard index >= 0, index < 1024 else { throw Self.invalid }
            hasTools = true
            var row = calls[index] ?? ["type": "function"]
            if let id = fragment["id"] as? String, !id.isEmpty { row["id"] = id }
            if let type = fragment["type"] as? String, !type.isEmpty { row["type"] = type }
            var function = row["function"] as? [String: Any] ?? ["name": "", "arguments": ""]
            let part = fragment["function"] as? [String: Any] ?? [:]
            if let name = part["name"] as? String, !name.isEmpty { function["name"] = name }
            if let arguments = part["arguments"] as? String {
                let joined = (function["arguments"] as? String ?? "") + arguments
                guard joined.utf16.count <= Self.maxToolArgumentCharacters else { throw Self.oversized }
                function["arguments"] = joined
            }
            row["function"] = function; calls[index] = row
        }
    }

    private mutating func anthropicEvent(_ value: [String: Any]) throws {
        switch value["type"] as? String {
        case "message_start":
            receipt = value["message"] as? [String: Any] ?? [:]
            usage = receipt["usage"] as? [String: Any] ?? [:]
        case "content_block_start":
            guard let index = value["index"] as? Int, index >= 0, index < 1024, let block = value["content_block"] as? [String: Any], blocks[index] == nil else { throw Self.invalid }
            blocks[index] = block
            if block["type"] as? String == "tool_use" { hasTools = true }
            if block["type"] as? String == "text" { text += block["text"] as? String ?? "" }
        case "content_block_delta":
            guard let index = value["index"] as? Int, var block = blocks[index], let delta = value["delta"] as? [String: Any] else { throw Self.invalid }
            switch delta["type"] as? String {
            case "text_delta":
                let part = delta["text"] as? String ?? ""; text += part; block["text"] = (block["text"] as? String ?? "") + part
            case "input_json_delta":
                let joined = partialInput[index, default: ""] + (delta["partial_json"] as? String ?? "")
                guard joined.utf16.count <= Self.maxToolArgumentCharacters else { throw Self.oversized }
                partialInput[index] = joined
            case "thinking_delta": block["thinking"] = (block["thinking"] as? String ?? "") + (delta["thinking"] as? String ?? "")
            case "signature_delta": block["signature"] = (block["signature"] as? String ?? "") + (delta["signature"] as? String ?? "")
            default: break
            }
            blocks[index] = block
        case "message_delta":
            if let reason = (value["delta"] as? [String: Any])?["stop_reason"] as? String { finishReason = reason }
            usage.merge(value["usage"] as? [String: Any] ?? [:]) { _, new in new }
        case "message_stop":
            guard finishReason != nil else { throw MeloError.message("模型未完成回复。") }
            completed = true; closed = true
        case "error": throw Self.interrupted
        default: break
        }
    }

    /// The whole reply as non-streamed JSON. Throws when the stream stopped before its end:
    /// a reply that was cut is never handed on as an answer, and its tool calls are not run.
    mutating func finish() throws -> Data {
        if !line.isEmpty { try accept(10) }
        try dispatch()
        guard completed else { throw URLError(.networkConnectionLost) }
        if anthropic {
            for (index, raw) in partialInput where !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // A tool that takes no arguments streams none: its block keeps the `input` it started with.
                guard let object = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] else { throw MeloError.message("模型工具参数不完整，未执行。") }
                blocks[index]?["input"] = object
            }
            receipt["content"] = blocks.keys.sorted().compactMap { blocks[$0] }
            receipt["stop_reason"] = finishReason
        } else {
            var message: [String: Any] = ["role": "assistant", "content": text]
            if hasTools {
                message["tool_calls"] = calls.keys.sorted().compactMap { calls[$0] }.map { call -> [String: Any] in
                    var call = call
                    var function = call["function"] as? [String: Any] ?? [:]
                    if (function["arguments"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { function["arguments"] = "{}" }
                    call["function"] = function
                    return call
                }
            }
            if !reasoning.isEmpty { message["reasoning_content"] = reasoning }
            receipt["choices"] = [["index": 0, "message": message, "finish_reason": finishReason ?? ""] as [String: Any]]
        }
        if !usage.isEmpty { receipt["usage"] = usage }
        return try JSONSerialization.data(withJSONObject: receipt)
    }
}
