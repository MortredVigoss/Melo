import Foundation
import CryptoKit

// Pure building blocks of the phone agent loop, each a port of the desktop
// module named in its comment and driven by the shared contract
// (AgentLoopContract.swift). Foundation + CryptoKit only.

private var loopContract: AgentLoopContract { AgentLoopContract.shared }

// MARK: Run budget (src/runtime/runBudget.js)

/// One deadline / input-token / tool-call pool for a turn. Children (team
/// members) narrow it and every use they record also lands on the parent.
/// Times are milliseconds from an injectable clock.
final class PhoneRunBudget: @unchecked Sendable {
    struct Usage: Equatable { var inputTokens = 0; var toolCalls = 0; var providerCalls = 0 }
    struct Exhaustion: Equatable {
        let reason: String
        let limit: Double
        let used: Double
        let usage: Usage
        var reasonText: String { reason == "policy-unavailable" ? "共享运行策略不可用" : loopContract.budgetReasonText[reason] ?? reason }
    }
    private static let lock = NSLock()
    static func wallClock() -> Double { Date().timeIntervalSince1970 * 1000 }

    private(set) var startedAt: Double
    private(set) var deadlineAt: Double
    private(set) var maxInputTokens: Int
    private(set) var maxToolCalls: Int
    private var usedValue = Usage()
    let parent: PhoneRunBudget?
    let now: () -> Double

    private var policyAvailable = true
    private var available: Bool { policyAvailable && (parent?.available ?? true) }
    private func invalidatePolicy() {
        var node: PhoneRunBudget? = self
        while let current = node { current.policyAvailable = false; node = current.parent }
    }

    init(deadlineMs: Double? = nil, maxInputTokens: Int? = nil, maxToolCalls: Int? = nil, now: @escaping () -> Double = PhoneRunBudget.wallClock) {
        self.now = now; parent = nil
        startedAt = now(); deadlineAt = startedAt; self.maxInputTokens = 0; self.maxToolCalls = 0
        var options: [String: Any] = [:]
        if let deadlineMs { options["deadlineMs"] = deadlineMs }
        if let maxInputTokens { options["maxInputTokens"] = maxInputTokens }
        if let maxToolCalls { options["maxToolCalls"] = maxToolCalls }
        apply(Self.operation("create", time: startedAt, fields: ["options": options]) as? [String: Any])
    }
    private init(parent: PhoneRunBudget, state: [String: Any]?) {
        self.parent = parent; now = parent.now
        startedAt = now(); deadlineAt = startedAt; maxInputTokens = 0; maxToolCalls = 0
        apply(state, ancestors: false)
    }
    private static func operation(_ action: String, time: Double, fields: [String: Any] = [:]) -> Any? {
        var input = fields; input["action"] = action; input["now"] = time
        return SharedLoopPolicy.value("budget", input)
    }
    // Called while the native ownership lock is held. The JS policy receives
    // a value snapshot, and never holds or mutates native objects itself.
    private func snapshot() -> [String: Any] {
        ["startedAt": startedAt, "deadlineAt": deadlineAt, "maxInputTokens": maxInputTokens, "maxToolCalls": maxToolCalls,
         "used": ["inputTokens": usedValue.inputTokens, "toolCalls": usedValue.toolCalls, "providerCalls": usedValue.providerCalls],
         "parent": parent.map { $0.snapshot() } as Any? ?? NSNull()]
    }
    private func apply(_ state: [String: Any]?, ancestors: Bool = true) {
        guard let state, let start = state["startedAt"] as? Double, let deadline = state["deadlineAt"] as? Double,
              let tokens = state["maxInputTokens"] as? Int, let calls = state["maxToolCalls"] as? Int,
              let usage = state["used"] as? [String: Int] else { invalidatePolicy(); return }
        startedAt = start; deadlineAt = deadline; maxInputTokens = tokens; maxToolCalls = calls
        usedValue = Usage(inputTokens: usage["inputTokens"] ?? 0, toolCalls: usage["toolCalls"] ?? 0, providerCalls: usage["providerCalls"] ?? 0)
        if ancestors, let parent { parent.apply(state["parent"] as? [String: Any]) }
    }
    var used: Usage { Self.lock.lock(); defer { Self.lock.unlock() }; return usedValue }

    func arm() {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard available else { return }
        apply(Self.operation("arm", time: now(), fields: ["budget": snapshot()]) as? [String: Any])
    }
    func remainingMs(at time: Double? = nil) -> Double {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard available else { return 0 }
        return Self.operation("remaining", time: time ?? now(), fields: ["budget": snapshot()]) as? Double ?? 0
    }
    func requestTimeout(cap: TimeInterval) -> TimeInterval {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard available else { return 0 }
        let milliseconds = Self.operation("timeout", time: now(), fields: ["budget": snapshot()]) as? Double ?? 0
        return min(cap, milliseconds / 1000)
    }
    func record(inputTokens: Int = 0, toolCalls: Int = 0, providerCalls: Int = 0) {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard available else { return }
        apply(Self.operation("record", time: now(), fields: ["budget": snapshot(), "usage": ["inputTokens": inputTokens, "toolCalls": toolCalls, "providerCalls": providerCalls]]) as? [String: Any])
    }
    func exhausted(at time: Double? = nil) -> Exhaustion? {
        Self.lock.lock(); defer { Self.lock.unlock() }
        let unavailable = Exhaustion(reason: "policy-unavailable", limit: 0, used: 0, usage: usedValue)
        guard available else { return unavailable }
        let result = Self.operation("exhausted", time: time ?? now(), fields: ["budget": snapshot()])
        if result is NSNull { return nil }
        guard let value = result as? [String: Any], let reason = value["reason"] as? String,
              let limit = value["limit"] as? Double, let spent = value["used"] as? Double,
              let usage = value["usage"] as? [String: Int] else { invalidatePolicy(); return unavailable }
        return Exhaustion(reason: reason, limit: limit, used: spent, usage: Usage(inputTokens: usage["inputTokens"] ?? 0, toolCalls: usage["toolCalls"] ?? 0, providerCalls: usage["providerCalls"] ?? 0))
    }
    func narrowed(deadlineMs: Double? = nil, maxInputTokens: Int? = nil, maxToolCalls: Int? = nil) -> PhoneRunBudget {
        Self.lock.lock(); defer { Self.lock.unlock() }
        var options: [String: Any] = [:]
        if let deadlineMs { options["deadlineMs"] = deadlineMs }
        if let maxInputTokens { options["maxInputTokens"] = maxInputTokens }
        if let maxToolCalls { options["maxToolCalls"] = maxToolCalls }
        let result = available ? Self.operation("narrow", time: now(), fields: ["budget": snapshot(), "options": options]) as? [String: Any] : nil
        return PhoneRunBudget(parent: self, state: result)
    }
    /// `describeBudgetReason`
    static func describe(_ exhausted: Exhaustion) -> String {
        let formats = loopContract.budgetReasonFormat
        switch exhausted.reason {
        case "deadline":
            let minutes = Int((exhausted.limit / 60_000).rounded())
            return minutes >= 1
                ? AgentLoopContract.fill(formats["deadlineMinutes"] ?? "", ["text": exhausted.reasonText, "minutes": String(minutes)])
                : AgentLoopContract.fill(formats["deadlineSeconds"] ?? "", ["text": exhausted.reasonText, "seconds": String(Int((exhausted.limit / 1000).rounded()))])
        case "tool-calls": return AgentLoopContract.fill(formats["tool-calls"] ?? "", ["text": exhausted.reasonText, "limit": JSText.number(exhausted.limit)])
        default: return AgentLoopContract.fill(formats["input-tokens"] ?? "", ["text": exhausted.reasonText, "limit": JSText.number(exhausted.limit)])
        }
    }
    /// `budgetExhaustedReply`
    static func reply(_ exhausted: Exhaustion) -> String { AgentLoopContract.fill(loopContract.budgetReplyTemplate, ["reason": describe(exhausted)]) }
    /// The run-record stage text the desktop emits for `budget:exhausted`.
    static func stageText(_ exhausted: Exhaustion) -> String {
        let limitText = exhausted.reason == "deadline" ? "\(Int((exhausted.used / 1000).rounded()))s / \(Int((exhausted.limit / 1000).rounded()))s" : "\(JSText.number(exhausted.used)) / \(JSText.number(exhausted.limit))"
        return "已达到运行预算（\(describe(exhausted))，已用 \(limitText)），本轮停止。已用：模型请求 \(exhausted.usage.providerCalls) 次、输入约 \(exhausted.usage.inputTokens) token、工具调用 \(exhausted.usage.toolCalls) 次。"
    }
}

// MARK: Tool result envelope (src/tools/toolResult.js + functionCalling.js toolOutput)

/// Outcome of one tool call, the phone twin of the desktop's finalised result.
struct PhoneToolOutcome: Equatable {
    var ok: Bool
    var status: String          // ok | empty | error
    var code: String?
    var output: String
    var detail: String?
}

enum PhoneToolEnvelope {
    /// Phone-era codes that predate the shared set, renamed like the desktop's legacy aliases.
    static let phoneAliases: [String: String] = [
        "USER_DECLINED": "PERMISSION_DENIED", "NOT_ENABLED": "CAPABILITY_DENIED", "INVALID_ARGUMENTS": "INVALID_ARGS",
        "INVALID_URL": "INVALID_ARGS", "CANCELLED": "ABORTED", "DEVICE_ERROR": "UNKNOWN", "ENCODING_FAILED": "UNKNOWN",
    ]

    /// `canonicalToolCode`; with `phone` the phone aliases apply as well.
    static func canonicalCode(_ raw: String?, aborted: Bool = false, timedOut: Bool = false, phone: Bool = true) -> String {
        if timedOut { return "TIMEOUT" }
        if aborted { return "ABORTED" }
        let text = JSText.trim(raw ?? "")
        guard !text.isEmpty else { return "UNKNOWN" }
        if loopContract.canonicalCode.test(text) {
            if let alias = loopContract.legacyAliases[text] { return alias }
            if phone, let alias = phoneAliases[text] { return alias }
            return text
        }
        for (pattern, code) in loopContract.legacyPatterns where pattern.test(text) { return code }
        return "UNKNOWN"
    }
    /// `finalizeToolResult`
    static func finalize(ok: Bool, status: String? = nil, code: String? = nil, error: String? = nil, output: String, detail: String? = nil, phone: Bool = true) -> PhoneToolOutcome {
        let resolved: String = !ok ? "error" : (status == "empty" || code == "NO_RESULTS") ? "empty" : "ok"
        if resolved != "error" { return PhoneToolOutcome(ok: ok, status: resolved, code: resolved == "empty" ? "NO_RESULTS" : nil, output: output, detail: detail) }
        let canonical: String
        if let code, loopContract.canonicalCode.test(code) { canonical = phone ? (phoneAliases[code] ?? code) : code }
        else { canonical = canonicalCode(error, phone: phone) }
        var detailText = detail
        if let error, error != canonical, detailText == nil { detailText = JSText.prefix(error, 500) }
        if let code, code != canonical, detailText == nil { detailText = code }
        return PhoneToolOutcome(ok: false, status: "error", code: canonical, output: output, detail: detailText)
    }
    /// `toolCodeHint`; the phone reads its own wording where the desktop names a desktop-only tool.
    static func hint(_ code: String?, phone: Bool = true) -> String {
        guard let code else { return "" }
        if phone, let override = loopContract.phoneHintOverrides[code] { return override }
        return loopContract.hints[code] ?? ""
    }
    /// The exact string the model sees (`toolOutput`).
    static func modelFacing(_ outcome: PhoneToolOutcome, maxOutputChars: Int? = nil, phone: Bool = true) -> String {
        let limit = maxOutputChars ?? loopContract.maxModelFacingOutputChars
        let code = outcome.code ?? (outcome.status == "error" ? "UNKNOWN" : nil)
        var parts = ["\"ok\":" + (outcome.ok ? "true" : "false"), "\"status\":" + JSText.json(outcome.status)]
        if let code {
            parts.append("\"code\":" + JSText.json(code))
            if outcome.status == "error" { parts.append("\"error\":" + JSText.json(code)) }
        }
        let output = JSText.length(outcome.output) > limit ? JSText.prefix(outcome.output, limit) + loopContract.truncatedMarker : outcome.output
        parts.append("\"output\":" + JSText.json(output))
        let hintText = hint(code, phone: phone)
        if !hintText.isEmpty { parts.append("\"hint\":" + JSText.json(hintText)) }
        if let detail = outcome.detail, !detail.isEmpty { parts.append("\"detail\":" + JSText.json(JSText.prefix(detail, loopContract.detailMaxChars))) }
        return "{" + parts.joined(separator: ",") + "}"
    }
    /// A successful tool payload; `empty` means it ran fine and found nothing.
    static func success(_ payload: String, empty: Bool = false, maxOutputChars: Int? = nil) -> String {
        modelFacing(finalize(ok: true, status: empty ? "empty" : "ok", output: payload), maxOutputChars: maxOutputChars)
    }
    /// A failure: phone or free-text codes become canonical codes, the original stays in `detail`.
    static func failure(_ code: String, _ message: String) -> String {
        modelFacing(finalize(ok: false, error: code, output: message))
    }
    /// Reads an envelope back; legacy `{ok,error,message}` JSON and plain text are normalised.
    static func parse(_ text: String) -> PhoneToolOutcome {
        guard let data = text.data(using: .utf8), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return PhoneToolOutcome(ok: true, status: "ok", code: nil, output: text, detail: nil)
        }
        if let status = object["status"] as? String, ["ok", "empty", "error"].contains(status), let output = object["output"] as? String {
            return PhoneToolOutcome(ok: object["ok"] as? Bool == true, status: status, code: object["code"] as? String, output: output, detail: object["detail"] as? String)
        }
        if object["ok"] as? Bool == false {
            return finalize(ok: false, error: object["error"] as? String, output: object["message"] as? String ?? text)
        }
        return finalize(ok: true, output: text)
    }
    /// The tool payload inside an envelope (the JSON the tool itself produced), when it is a JSON object.
    static func payload(_ text: String) -> [String: Any] {
        let outcome = parse(text)
        return (outcome.output.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    }
}

// MARK: Repeat guard (src/agents/repeatGuard.js)

final class PhoneRepeatGuard {
    private var failures: [String: (count: Int, errorClass: String)] = [:]
    private let limit: Int
    init(limit: Int = AgentLoopContract.shared.repeatLimit) { self.limit = limit }
    private static func key(_ name: String, _ args: OrderedJSON) -> String { OrderedJSON.array([.string(name), args]).canonicalJSON }
    private static func errorClass(_ outcome: PhoneToolOutcome) -> String {
        if let code = outcome.code, !JSText.trim(code).isEmpty { return JSText.trim(code) }
        return JSText.prefix(JSText.collapse(outcome.output), loopContract.repeatErrorClassMaxChars)
    }
    /// A rejection when this exact call already failed `limit` times with the same error.
    func check(_ name: String, _ args: OrderedJSON) -> PhoneToolOutcome? {
        guard let entry = failures[Self.key(name, args)], entry.count >= limit else { return nil }
        let output = AgentLoopContract.fill(loopContract.repeatOutputTemplate, ["name": name, "count": String(entry.count), "errorClass": entry.errorClass.isEmpty ? loopContract.repeatSameErrorFallback : entry.errorClass])
        return PhoneToolEnvelope.finalize(ok: false, error: loopContract.repeatCode, output: output)
    }
    func record(_ name: String, _ args: OrderedJSON, _ outcome: PhoneToolOutcome) {
        let key = Self.key(name, args)
        if !outcome.ok {
            let cls = Self.errorClass(outcome)
            let current = failures[key]
            failures[key] = (current?.errorClass == cls ? (current?.count ?? 0) + 1 : 1, cls)
        } else { failures[key] = nil }
    }
}

// MARK: Secret redaction, args digest and hash (secretRedaction.js, toolInvocationRecord.js)

enum PhoneToolArgs {
    /// `redactSecretsInText`
    static func redactSecrets(_ text: String) -> String {
        guard !text.isEmpty else { return text }
        return loopContract.redactionPatterns.reduce(text) { $1.0.replacingAll(in: $0, with: $1.1) }
    }
    private static let dataURL = LoopRegex(source: #"^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$"#, flags: "")
    /// `redactToolArgs`
    static func redact(_ args: OrderedJSON, maxString: Int? = nil) -> OrderedJSON {
        let limit = maxString ?? loopContract.maxRedactedStringChars
        func value(_ item: OrderedJSON, depth: Int) -> OrderedJSON {
            switch item {
            case .string(let text):
                if let match = dataURL.firstMatch(text) {
                    let payload = match[3] ?? ""
                    let bytes = (match[2] ?? "").range(of: ";base64", options: .caseInsensitive) != nil ? JSText.length(payload) * 3 / 4 : JSText.length(payload)
                    return .string("data:\((match[1] ?? "").isEmpty ? "application/octet-stream" : match[1]!) (\(bytes) bytes)")
                }
                let redacted = redactSecrets(text)
                return .string(JSText.length(redacted) > limit ? JSText.prefix(redacted, limit) + "…" : redacted)
            case .array(let items):
                guard depth < loopContract.maxDepth else { return .string("[nested]") }
                var out = items.prefix(loopContract.maxArrayItems).map { value($0, depth: depth + 1) }
                if items.count > loopContract.maxArrayItems { out.append(.string("…(+\(items.count - loopContract.maxArrayItems) items)")) }
                return .array(out)
            case .object(let fields):
                guard depth < loopContract.maxDepth else { return .string("[nested]") }
                return .object(fields.map { key, item in (key, loopContract.sensitiveKey.test(key) ? .string(loopContract.redactedToken) : value(item, depth: depth + 1)) })
            default: return item
            }
        }
        guard case .object = args else { return .object([]) }
        return value(args, depth: 0)
    }
    /// `toolArgsDigest`: scalar `key=value` pairs, first `maxEntries`, each cut to `maxValue`.
    static func digest(_ args: OrderedJSON, maxEntries: Int? = nil, maxValue: Int? = nil, maxChars: Int? = nil) -> String {
        let limits = loopContract.traceDigest
        let entriesLimit = maxEntries ?? limits.maxEntries, valueLimit = maxValue ?? limits.maxValue, charsLimit = maxChars ?? limits.maxChars
        var parts: [String] = []
        for (key, item) in args.entries {
            let raw: String
            switch item {
            case .string(let text): raw = text
            case .number(let number): raw = JSText.number(number)
            case .bool(let flag): raw = flag ? "true" : "false"
            default: continue
            }
            let text = JSText.collapse(raw)
            guard !text.isEmpty else { continue }
            parts.append("\(key)=\(JSText.length(text) > valueLimit ? JSText.prefix(text, valueLimit) + "…" : text)")
            if parts.count >= entriesLimit { break }
        }
        let digest = parts.joined(separator: ", ")
        return JSText.length(digest) > charsLimit ? JSText.prefix(digest, charsLimit) + "…" : digest
    }
    /// `hashToolArgs`: sha256 of the canonical JSON, first 16 hex characters.
    static func hash(_ args: OrderedJSON) -> String {
        let value: OrderedJSON
        if case .object = args { value = args } else { value = .object([]) }
        let digest = SHA256.hash(data: Data(value.canonicalJSON.utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(loopContract.argsHashChars))
    }
}

// MARK: Tool invocation record + tool trace (toolInvocationRecord.js, toolTraceReplay.js)

/// One phone tool call as the run record keeps it: redacted digest, hash,
/// status/code and timing — never the tool's data.
struct ExecutionToolCall: Codable, Equatable, Identifiable {
    var id: String { callId }
    var iteration: Int
    var callId: String
    var toolId: String
    var argsDigest: String
    var argsHash: String
    var status: String
    var code: String?
    var executed: Bool
    var startedAt: String
    var durationMs: Double

    init(iteration: Int, call: ResponsesFunctionCall, args: OrderedJSON, outcome: PhoneToolOutcome, executed: Bool, started: Date, finished: Date) {
        self.iteration = iteration; callId = call.callID; toolId = call.name
        argsDigest = PhoneToolArgs.digest(PhoneToolArgs.redact(args))
        argsHash = PhoneToolArgs.hash(args)
        status = outcome.status; code = outcome.code; self.executed = executed
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        startedAt = formatter.string(from: started)
        durationMs = max(0, (finished.timeIntervalSince(started) * 1000).rounded())
    }
}

enum PhoneToolTrace {
    struct Entry { var toolId: String; var digest: String; var status: String; var code: String? }
    /// `buildToolTraceText`; '' when nothing ran.
    static func text(_ entries: [Entry], status: String = "cancelled", maxChars: Int? = nil) -> String {
        let c = loopContract
        let limit = maxChars ?? c.traceMaxChars
        guard !entries.isEmpty else { return "" }
        let label = c.traceStatusLabels[status] ?? c.traceStatusLabels["cancelled"] ?? ""
        let header = AgentLoopContract.fill(c.traceHeaderTemplate, ["prefix": c.tracePrefix, "label": label, "count": String(entries.count)])
        func line(_ entry: Entry, _ index: Int) -> String {
            let mark = entry.status == "ok" ? c.traceStatusMarks["ok"] ?? "" : entry.status == "empty" ? c.traceStatusMarks["empty"] ?? ""
                : AgentLoopContract.fill(c.traceStatusMarks["error"] ?? "", ["code": (entry.code?.isEmpty == false ? entry.code! : c.traceErrorCodeFallback)])
            return AgentLoopContract.fill(c.traceLineTemplate, ["index": String(index + 1), "tool": entry.toolId, "digest": entry.digest, "status": mark])
        }
        var lines: [String] = []
        var used = JSText.length(header)
        for index in entries.indices {
            let text = line(entries[index], index)
            let remaining = entries.count - index
            let tail = remaining > 1 ? c.traceSeparator + AgentLoopContract.fill(c.traceMoreTemplate, ["count": String(remaining - 1)]) : ""
            if used + 1 + JSText.length(text) + (index + 1 < entries.count ? JSText.length(tail) : 0) > limit {
                if lines.isEmpty { lines.append(JSText.prefix(text, max(c.traceMinFirstLineChars, limit - used - JSText.length(tail) - 1))) }
                lines.append(AgentLoopContract.fill(c.traceMoreTemplate, ["count": String(entries.count - lines.count)]))
                break
            }
            lines.append(text)
            used += 1 + JSText.length(text)
        }
        let text = header + "\n" + lines.joined(separator: c.traceSeparator)
        return JSText.length(text) > limit ? JSText.prefix(text, limit - 1) + c.traceEllipsis : text
    }
    static func text(_ calls: [ExecutionToolCall], status: String) -> String {
        text(calls.map { Entry(toolId: $0.toolId, digest: $0.argsDigest, status: $0.status, code: $0.code) }, status: status)
    }
    /// Tool-trace messages are assistant messages that start with the shared prefix (the v1 sync message has no `kind`).
    static func isTrace(_ message: ChatMessage) -> Bool { message.role == "assistant" && message.content.hasPrefix(loopContract.tracePrefix) }
    /// For a retry after a stopped reply: trailing trace messages move before the
    /// question they followed, so the model sees what ran and the turn still ends on the question.
    static func retryOrder(_ messages: [ChatMessage]) -> [ChatMessage] {
        var rest = messages, traces: [ChatMessage] = []
        while let last = rest.last, isTrace(last) { traces.insert(last, at: 0); rest.removeLast() }
        guard !traces.isEmpty, let question = rest.last, question.role == "user" else { return messages }
        return Array(rest.dropLast()) + traces + [question]
    }
}

// MARK: Token estimate (src/memory/tokenEstimate.js)

enum PhoneTokenEstimate {
    static func text(_ value: String) -> Int {
        var total = 0, nonLatin = 0
        var iterator = value.utf16.makeIterator()
        var pendingHigh = false
        while let unit = iterator.next() {
            total += 1
            if pendingHigh && (0xDC00...0xDFFF).contains(unit) { pendingHigh = false; continue }
            pendingHigh = false
            if unit > 0x024F {
                nonLatin += 1
                if (0xD800...0xDBFF).contains(unit) { pendingHigh = true }
            }
        }
        return Int((Double(total - nonLatin) / 4 + Double(nonLatin) * loopContract.nonLatinTokensPerChar).rounded(.up))
    }
}

// MARK: Uncertainty marker and verification (src/retrieval/selfVerification.js, verificationEvidence.js)

enum PhoneUncertainty {
    struct Parsed: Equatable { var hasMarker: Bool; var uncertainClaim: String; var cleanReply: String; var source: String }
    struct Verification: Equatable { var verdict: String; var correction = ""; var originalClaim = ""; var evidenceId = ""; var reason = "" }
    struct Evidence {
        var id: String; var tool: String?; var ok: Bool; var source: String?; var fetchedAt: String?; var coverage: String; var truncated: Bool?; var text: String
        /// Same key order as the desktop's evidence objects (JSON.stringify).
        var json: String {
            var parts = ["\"id\":" + JSText.json(id)]
            if let tool { parts.append("\"tool\":" + JSText.json(tool)) }
            parts.append("\"ok\":" + (ok ? "true" : "false"))
            if let source { parts.append("\"source\":" + JSText.json(source)) }
            if let fetchedAt { parts.append("\"fetchedAt\":" + JSText.json(fetchedAt)) }
            parts.append("\"coverage\":" + JSText.json(coverage))
            if let truncated { parts.append("\"truncated\":" + (truncated ? "true" : "false")) }
            parts.append("\"text\":" + JSText.json(text))
            return "{" + parts.joined(separator: ",") + "}"
        }
    }
    struct ToolPair { var callID: String; var name: String; var args: OrderedJSON; var ok: Bool; var output: String; var receivedAt: String }

    static var rules: String { loopContract.uncertaintyRules.joined(separator: "\n") }

    /// `parseUncertaintyMarker`
    static func parse(_ reply: String) -> Parsed {
        let c = loopContract
        if let match = c.uncertaintyMarker.firstMatch(reply) {
            return Parsed(hasMarker: true, uncertainClaim: JSText.trim(match[1] ?? ""), cleanReply: JSText.trim(c.uncertaintyMarker.replacingFirst(in: reply, with: "")), source: "explicit")
        }
        for pattern in c.uncertaintyFuzzy {
            if let match = pattern.firstMatch(reply) {
                return Parsed(hasMarker: true, uncertainClaim: JSText.prefix(JSText.trim(match[0] ?? ""), c.fuzzyClaimMaxChars), cleanReply: JSText.trim(reply), source: "fuzzy")
            }
        }
        return Parsed(hasMarker: false, uncertainClaim: "", cleanReply: JSText.trim(reply), source: "none")
    }
    /// `applyVerificationToReply`
    static func apply(_ reply: String, _ verification: Verification) -> String {
        if verification.verdict == "CORRECTED", !verification.correction.isEmpty, !verification.originalClaim.isEmpty, reply.contains(verification.originalClaim) {
            return reply.components(separatedBy: verification.originalClaim).joined(separator: verification.correction)
        }
        if verification.verdict == "UNVERIFIED" || verification.verdict == "CORRECTED" {
            return reply + "\n\n" + (loopContract.cjk.test(reply) ? loopContract.unverifiedNoteZH : loopContract.unverifiedNoteEN)
        }
        return reply
    }
    private static let terms = LoopRegex(source: #"[\p{L}\p{N}]{2,}"#, flags: "u")
    /// `collectVerificationEvidence` (newest first, at most 8).
    static func collect(_ pairs: [ToolPair], query: String) -> [Evidence] {
        let c = loopContract
        let words = terms.matches(query.lowercased())
        return pairs.suffix(c.evidenceMaxToolItems).reversed().map { pair in
            let raw = pair.output, lower = raw.lowercased()
            let match = words.lazy.compactMap { JSText.indexOf(lower, $0) }.first ?? 0
            let start = max(0, match - c.evidenceWindowBefore)
            let text = JSText.slice(raw, start, start + c.evidenceToolTextChars)
            let source = [pair.args["url"], pair.args["filePath"], pair.args["path"]].compactMap { $0?.stringValue }.first { !$0.isEmpty } ?? ""
            return Evidence(id: "tool:\(pair.callID)", tool: pair.name, ok: pair.ok, source: JSText.prefix(source, 500), fetchedAt: pair.receivedAt,
                            coverage: "unknown", truncated: start > 0 || JSText.length(text) < JSText.length(raw), text: text)
        }
    }
    /// `buildVerificationEvidence`
    static func build(contextBlocks: [String], toolEvidence: [Evidence]) -> [Evidence] {
        let c = loopContract
        var evidence = toolEvidence.prefix(c.evidenceMaxToolItems).map { entry -> Evidence in var copy = entry; copy.text = JSText.prefix(entry.text, c.evidenceToolTextChars); return copy }
        for (index, block) in contextBlocks.enumerated() where !JSText.trim(block).isEmpty {
            evidence.append(Evidence(id: "context:\(index)", tool: nil, ok: true, source: nil, fetchedAt: nil, coverage: "background-context", truncated: nil, text: JSText.prefix(JSText.trim(block), c.evidenceContextTextChars)))
        }
        return evidence
    }
    /// `isSupportedVerification`
    static func supported(evidenceId: String?, quote: String?, evidence: [Evidence]) -> Bool {
        guard let evidenceId, let source = evidence.first(where: { $0.id == evidenceId && $0.ok }) else { return false }
        let text = JSText.trim(quote ?? "")
        return JSText.length(text) >= loopContract.evidenceQuoteMinChars && source.text.contains(text)
    }
    /// The verifier request: system prompt plus the three desktop messages.
    static func request(question: String, reply: String, claim: String, evidence: [Evidence]) -> (system: String, messages: [ChatMessage]) {
        let c = loopContract
        let context = "[" + evidence.map(\.json).joined(separator: ",") + "]"
        return (c.verifierSystemPrompt, [
            ChatMessage(role: "user", content: AgentLoopContract.fill(c.verifierQuestionTemplate, ["question": question])),
            ChatMessage(role: "assistant", content: reply),
            ChatMessage(role: "user", content: [AgentLoopContract.fill(c.verifierClaimTemplate, ["claim": claim]), "", c.verifierContextHeading, context, "", c.verifierClosingQuestion].joined(separator: "\n")),
        ])
    }
    private static let fences = LoopRegex(source: #"^```(?:json)?\s*|\s*```$"#, flags: "")
    /// `verifyUncertainClaim`; `call` sends one request through the turn's transport.
    static func verify(question: String, reply: String, claim: String, contextBlocks: [String], toolEvidence: [Evidence],
                       call: (String, [ChatMessage]) async throws -> String) async throws -> Verification {
        let evidence = build(contextBlocks: contextBlocks, toolEvidence: toolEvidence)
        guard evidence.contains(where: { $0.ok && !JSText.trim($0.text).isEmpty }) else { return Verification(verdict: "UNVERIFIED", reason: "no-context-available") }
        do {
            let request = request(question: question, reply: reply, claim: claim, evidence: evidence)
            let text = fences.replacingAll(in: JSText.trim(try await call(request.system, request.messages)), with: "")
            let payload = (text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            let verdict = payload["verdict"] as? String
            let ok = supported(evidenceId: payload["evidenceId"] as? String, quote: payload["evidenceQuote"] as? String, evidence: evidence)
            let original = JSText.trim(payload["originalClaim"] as? String ?? ""), correction = JSText.trim(payload["correction"] as? String ?? "")
            if verdict == "CORRECTED", ok, !original.isEmpty, !correction.isEmpty, reply.contains(original) {
                return Verification(verdict: "CORRECTED", correction: correction, originalClaim: original, evidenceId: payload["evidenceId"] as? String ?? "", reason: "context-contradicts")
            }
            if verdict == "VERIFIED", ok { return Verification(verdict: "VERIFIED", reason: "context-supports") }
            return Verification(verdict: "UNVERIFIED", reason: "insufficient-context")
        } catch {
            if Task.isCancelled || error is CancellationError { throw error }
            return Verification(verdict: "UNVERIFIED", reason: "verification-failed: \(error.localizedDescription)")
        }
    }
}

// MARK: Intent rules (src/retrieval/intentRouter.js, requestPolicy.js)

enum PhoneIntent {
    struct Classification: Equatable {
        /// nil = the rules could not decide (the desktop asks a classifier model).
        var taskType: String?
        var riskLevel: String
        var requiresVerification: Bool { PhoneIntent.requiresVerification(taskType: taskType ?? "factual", riskLevel: riskLevel) }
    }
    private static func pattern(_ name: String) -> LoopRegex { loopContract.intentPatterns[name]! }
    /// `maskQuotedText`: quoted spans become spaces of the same UTF-16 length.
    static func maskQuotedText(_ text: String) -> String {
        let ns = NSMutableString(string: text)
        for range in loopContract.quotedText.matchRanges(text).reversed() { ns.replaceCharacters(in: range, with: String(repeating: " ", count: range.length)) }
        return ns as String
    }
    static func isTranslationRequest(_ text: String) -> Bool {
        let instruction = maskQuotedText(text)
        if pattern("translationExcluded").test(instruction) { return false }
        return pattern("translation").test(instruction)
    }
    /// `classifyByRules`
    static func rules(_ query: String) -> String? {
        let text = JSText.trim(query)
        if text.isEmpty { return "casual" }
        if pattern("shortAck").test(text) { return "casual" }
        if isTranslationRequest(text) { return "creative" }
        if pattern("coding").test(text) { return "coding" }
        if pattern("creative").test(text) { return "creative" }
        if pattern("highStakes").test(text) { return "high-stakes" }
        if pattern("questionMark").test(text) || pattern("factualEn").test(text) || pattern("factualCn").test(text) { return "factual" }
        if JSText.length(text) < loopContract.intentShortTextChars { return "casual" }
        if JSText.length(text) > loopContract.intentLongTextChars { return "factual" }
        return nil
    }
    static func risk(_ query: String) -> String { pattern("highStakes").test(query) ? "high" : "normal" }
    /// `classifyRequest` without the model step: ambiguous text keeps `taskType == nil`.
    static func classify(_ message: String, history: [ChatMessage]) -> Classification {
        var taskType = rules(message)
        var riskText = message
        if pattern("contextualReply").test(JSText.trim(riskText)) {
            var turns = history.filter { $0.role == "user" }
            if turns.last?.content == message { turns.removeLast() }
            if let previous = turns.last?.content, !JSText.trim(previous).isEmpty {
                taskType = rules(previous) ?? "factual"
                riskText = previous + "\n" + riskText
            }
        }
        return Classification(taskType: taskType, riskLevel: taskType == "high-stakes" ? "high" : risk(riskText))
    }
    /// `intentRequiresVerification`
    static func requiresVerification(taskType: String, riskLevel: String) -> Bool {
        riskLevel == "high" || taskType == "factual" || taskType == "high-stakes"
    }
    /// The classifier model's answer, normalised like the desktop (first word, unknown → factual).
    static func normalize(_ reply: String) -> String {
        let word = JSText.trim(reply.lowercased()).split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? "factual"
        return loopContract.intentCategories.contains(word) ? word : "factual"
    }
}

// MARK: read_history (src/tools/builtins/readHistoryTool.js), current chat only

enum PhoneReadHistory {
    static let name = "read_history"
    static var definition: PhoneToolDefinition {
        PhoneToolDefinition(name: name,
            description: "Read original messages of this conversation verbatim by message id. Use it when the conversation summary (\"topic cards\") mentions a message range or a decision you need the exact wording, numbers or code of — the summary shows ranges as \"消息 #<from> … #<to>\". Returns at most ~\(loopContract.readHistoryMaxTokens / 1000)k tokens; continue with the returned nextMessageId when truncated (plus fromChar=continueFromChar when one message was cut mid-way).",
            parameters: ["type": "object", "additionalProperties": false, "properties": [
                "fromMessageId": ["type": "string", "description": "First message id to read (inclusive). Defaults to the start of the conversation."],
                "fromChar": ["type": "number", "description": "With fromMessageId: character offset inside that first message to continue from. Use the continueFromChar value returned when a single message was cut."],
                "toMessageId": ["type": "string", "description": "Last message id to read (inclusive). Defaults to fromMessageId + limit."],
                "aroundMessageId": ["type": "string", "description": "Read one message plus `before`/`after` neighbours instead of a range."],
                "before": ["type": "number", "description": "With aroundMessageId: how many earlier messages to include (default 2)."],
                "after": ["type": "number", "description": "With aroundMessageId: how many later messages to include (default 2)."],
                "limit": ["type": "number", "description": "Maximum number of messages (1–\(loopContract.readHistoryMaxLimit), default \(loopContract.readHistoryDefaultLimit))."],
                "chatId": ["type": "string", "description": "Optional; only the current conversation can be read on this iPhone."],
            ] as [String: Any]])
    }
    static let instructions = "需要早期对话原文（摘要里的“消息 #… … #…”范围、具体数字或措辞）时，调用 read_history 按消息编号读取本对话原文；只能读当前对话。"

    /// Clamp in floating point before converting. Untrusted finite values can still exceed Int.
    static func boundedInteger(_ value: Double, minimum: Int = 0, maximum: Int) -> Int {
        guard !value.isNaN else { return Swift.max(minimum, 0) }
        if value >= Double(maximum) { return maximum }
        if value <= Double(minimum) { return minimum }
        return Int(value.rounded(.down))
    }

    struct Slice: Equatable { var messages: [ChatMessage]; var hasMore = false; var nextMessageId = ""; var missing = "" }
    /// `sliceHistory`
    static func slice(_ all: [ChatMessage], fromMessageId: String? = nil, toMessageId: String? = nil, aroundMessageId: String? = nil, before: Double = 0, after: Double = 0, limit: Double? = nil) -> Slice {
        let list = all.filter { !$0.id.isEmpty && ($0.role == "user" || $0.role == "assistant") }
        func index(_ id: String?) -> Int { id.flatMap { id in list.firstIndex { $0.id == id } } ?? -1 }
        let requested = boundedInteger(limit ?? 0, minimum: -1, maximum: loopContract.readHistoryMaxLimit)
        let max = Swift.max(1, Swift.min(loopContract.readHistoryMaxLimit, requested == 0 ? loopContract.readHistoryDefaultLimit : requested))
        var start: Int, end: Int
        if let around = aroundMessageId, !around.isEmpty {
            let center = index(around)
            guard center >= 0 else { return Slice(messages: [], missing: around) }
            start = center - boundedInteger(before, maximum: center)
            end = center + 1 + boundedInteger(after, maximum: list.count - center - 1)
        } else {
            let from = (fromMessageId?.isEmpty == false) ? index(fromMessageId) : 0
            guard from >= 0 else { return Slice(messages: [], missing: fromMessageId ?? "") }
            let to = (toMessageId?.isEmpty == false) ? index(toMessageId) : -1
            if toMessageId?.isEmpty == false && to < 0 { return Slice(messages: [], missing: toMessageId ?? "") }
            start = from
            end = to >= 0 ? to + 1 : from + Swift.min(list.count - from, max)
        }
        let requestedEnd = end
        if end - start > max { end = start + max }
        let openEnded = (aroundMessageId ?? "").isEmpty && (toMessageId ?? "").isEmpty
        let hasMore = end < requestedEnd || (openEnded && end < list.count)
        return Slice(messages: start < end ? Array(list[start..<end]) : [], hasMore: hasMore, nextMessageId: hasMore ? (end < list.count ? list[end].id : "") : "")
    }
    private static func parts(_ message: ChatMessage, fromChar: Int) -> (header: String, body: String) {
        let role = message.role == "user" ? "User" : message.role == "assistant" ? "Assistant" : message.role
        let when = JSText.prefix(message.createdAt, 16).replacingOccurrences(of: "T", with: " ")
        let full = JSText.trim(message.content).isEmpty ? "(no text)" : JSText.trim(message.content)
        let offset = Swift.max(0, Swift.min(JSText.length(full), fromChar))
        return ("[#\(message.id)] \(role)\(when.isEmpty ? "" : " (\(when))")\(offset > 0 ? " (continued from character \(offset))" : ""):\n", JSText.slice(full, offset))
    }
    /// Runs the tool on this chat's messages; the result is an envelope string.
    static func run(arguments: String, chatID: String, title: String, messages: [ChatMessage]) -> String {
        let args = OrderedJSON.arguments(arguments)
        func text(_ key: String) -> String? { args[key]?.stringValue }
        func number(_ key: String, _ fallback: Double) -> Double { if case .number(let n)? = args[key] { return n }; return fallback }
        if let other = text("chatId"), !other.isEmpty, other != chatID { return PhoneToolEnvelope.failure("PERMISSION_DENIED", "This channel can only read its own conversation.") }
        let slice = slice(messages, fromMessageId: text("fromMessageId"), toMessageId: text("toMessageId"), aroundMessageId: text("aroundMessageId"),
                          before: number("before", Double(loopContract.readHistoryDefaultNeighbours)), after: number("after", Double(loopContract.readHistoryDefaultNeighbours)),
                          limit: number("limit", Double(loopContract.readHistoryDefaultLimit)))
        if !slice.missing.isEmpty { return PhoneToolEnvelope.failure("NOT_FOUND", "Message \(slice.missing) is not in conversation \(chatID).") }
        if slice.messages.isEmpty { return PhoneToolEnvelope.success("No messages in that range.", empty: true) }
        let budget = loopContract.readHistoryMaxTokens
        let startChar = (text("fromMessageId")?.isEmpty == false && (text("aroundMessageId") ?? "").isEmpty) ? boundedInteger(number("fromChar", 0), maximum: slice.messages.first.map { JSText.length(JSText.trim($0.content)) } ?? 0) : 0
        var rendered: [String] = [], used = 0, truncatedAt = "", continueFromChar = 0
        for (position, message) in slice.messages.enumerated() {
            let offset = position == 0 ? startChar : 0
            let piece = parts(message, fromChar: offset)
            let full = piece.header + piece.body
            let tokens = PhoneTokenEstimate.text(full)
            if used + tokens > budget {
                if rendered.isEmpty {
                    // One message larger than the budget: return what fits and continue by character offset.
                    let fixed = PhoneTokenEstimate.text(piece.header + loopContract.readHistoryCutMarker)
                    var low = 0, high = JSText.length(piece.body)
                    while low < high {
                        let mid = (low + high + 1) / 2
                        if fixed + PhoneTokenEstimate.text(JSText.prefix(piece.body, mid)) <= budget { low = mid } else { high = mid - 1 }
                    }
                    var cut = low
                    let units = Array(piece.body.utf16)
                    if cut > 0 && cut < units.count && (0xD800...0xDBFF).contains(units[cut - 1]) { cut -= 1 }
                    let complete = cut >= units.count
                    if cut > 0 || complete {
                        rendered.append(piece.header + JSText.prefix(piece.body, cut) + (complete ? "" : loopContract.readHistoryCutMarker))
                        if !complete { truncatedAt = message.id; continueFromChar = offset + cut }
                        else { truncatedAt = position + 1 < slice.messages.count ? slice.messages[position + 1].id : (slice.hasMore ? slice.nextMessageId : "") }
                        break
                    }
                    rendered.append(piece.header + "[message skipped: too large to render even partially]")
                    truncatedAt = position + 1 < slice.messages.count ? slice.messages[position + 1].id : (slice.hasMore ? slice.nextMessageId : "")
                    break
                }
                truncatedAt = message.id
                break
            }
            rendered.append(full)
            used += tokens
        }
        let next = !truncatedAt.isEmpty ? truncatedAt : (slice.hasMore ? slice.nextMessageId : "")
        let continuation = next.isEmpty ? "" : " — truncated; continue with fromMessageId=\"\(next)\"" + (continueFromChar > 0 ? " fromChar=\(continueFromChar) (that message was cut mid-way)" : "")
        let header = "Conversation \"\(title.isEmpty ? "Untitled" : title)\" (\(chatID)), \(rendered.count) of \(slice.messages.count) requested message(s)\(continuation)."
        return PhoneToolEnvelope.success(([header] + rendered).joined(separator: "\n\n"), maxOutputChars: Int.max)
    }
}
