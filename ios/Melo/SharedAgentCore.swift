import Foundation
import CryptoKit
import JavaScriptCore

enum SharedAgentCoreError: Error { case unavailable, invalidBundle, invalidReply, closed }

/// One serial JSCore context per turn. No native IO functions are exposed.
final class SharedAgentCore: @unchecked Sendable {
    private let queue = DispatchQueue(label: "melo.agent-core.\(UUID().uuidString)")
    private var context: JSContext?
    private var closed = false
    let bundleHash: String

    static func resourceURL(_ name: String, _ ext: String) -> URL? {
        if let url = Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "AgentCore") { return url }
        #if MELO_TEST
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("ios/Melo/AgentCore/\(name).\(ext)")
        #else
        return nil
        #endif
    }

    init(bundleURL: URL? = SharedAgentCore.resourceURL("agent-core", "js"),
         manifestURL: URL? = SharedAgentCore.resourceURL("manifest", "json")) throws {
        guard let bundleURL, let manifestURL else { throw SharedAgentCoreError.unavailable }
        let bytes = try Data(contentsOf: bundleURL)
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any]
        bundleHash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard manifest?["sha256"] as? String == bundleHash, let source = String(data: bytes, encoding: .utf8) else { throw SharedAgentCoreError.invalidBundle }
        try queue.sync {
            guard let js = JSContext() else { throw SharedAgentCoreError.unavailable }
            js.evaluateScript(source)
            guard js.exception == nil, js.objectForKeyedSubscript("MeloAgent")?.isObject == true else { throw SharedAgentCoreError.invalidBundle }
            context = js
        }
    }

    // Synchronous policy decisions (budgets/permits) must finish before an OS
    // effect. They use the same serial context and JSON-only data boundary.
    func evaluateSync(_ request: [String: Any]) throws -> [String: Any] {
        let bytes = try JSONSerialization.data(withJSONObject: request)
        guard bytes.count <= 2_000_000, let json = String(data: bytes, encoding: .utf8) else { throw SharedAgentCoreError.invalidReply }
        return try queue.sync { try evaluateOnQueue(json) }
    }

    private func evaluateOnQueue(_ json: String) throws -> [String: Any] {
        guard !closed, let context else { throw SharedAgentCoreError.closed }
        context.exception = nil
        // JSON is an argument value, never interpolated into source.
        guard let output = context.objectForKeyedSubscript("MeloAgent")?.objectForKeyedSubscript("evaluate")?.call(withArguments: [json])?.toString(),
              context.exception == nil, let data = output.data(using: .utf8),
              let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw SharedAgentCoreError.invalidReply }
        return value
    }

    func evaluate(_ request: [String: Any]) async throws -> [String: Any] {
        try Task.checkCancellation()
        let bytes = try JSONSerialization.data(withJSONObject: request)
        guard bytes.count <= 2_000_000, let json = String(data: bytes, encoding: .utf8) else { throw SharedAgentCoreError.invalidReply }
        let result: [String: Any] = try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                do { continuation.resume(returning: try evaluateOnQueue(json)) }
                catch { continuation.resume(throwing: error) }
            }
        }
        try Task.checkCancellation()
        return result
    }

    func close() { queue.async { [self] in closed = true; context = nil } }
}

/// Pure operations share a serial engine, with no persistent JS state. Hosts
/// retain native locks/object identity; missing/corrupt policy never grants work.
enum SharedLoopPolicy {
    private static let core = try? SharedAgentCore()
    static func value(_ operation: String, _ fields: [String: Any]) -> Any? {
        guard let core else { return nil }
        var request = fields
        request["version"] = 1; request["op"] = operation
        guard let reply = try? core.evaluateSync(request), reply["ok"] as? Bool == true else { return nil }
        return reply["value"]
    }
}

/// Native ownership for the portable reducer. The Host retains transport,
/// cancellation, approvals and persistence; no decision is reimplemented here.
final class PhoneCoreTurn {
    private var state: [String: Any]
    private static func clock() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
    var completed: Bool { state["status"] as? String == "completed" }
    var active: Bool { state["status"] as? String == "running" }
    var reason: String { state["reason"] as? String ?? "LOOP_STOPPED" }
    init(tools: [String], rounds: Int, callsPerRound: Int) throws {
        let turn: [String: Any] = ["runId": UUID().uuidString, "turnId": UUID().uuidString, "now": Self.clock(),
            "allowedTools": tools, "hostToolSchemas": true, "limits": ["rounds": rounds, "callsPerRound": callsPerRound]]
        guard let value = SharedLoopPolicy.value("start", ["turn": turn]) as? [String: Any] else { throw SharedAgentCoreError.unavailable }
        state = value
    }
    @discardableResult func event(_ type: String, _ fields: [String: Any] = [:]) throws -> Bool {
        var event = fields; event["type"] = type; event["runId"] = state["runId"]; event["turnId"] = state["turnId"]
        guard let value = SharedLoopPolicy.value("advance", ["state": state, "event": event, "now": Self.clock()]) as? [String: Any] else {
            state["status"] = "blocked"; state["reason"] = "INVALID_LOOP_EVENT"
            throw SharedAgentCoreError.invalidReply
        }
        state = value
        return active
    }
    func permits(_ id: String) -> Bool { active && (state["permitted"] as? [String] ?? []).contains(id) && (state["pending"] as? [String] ?? []).contains(id) }
    func rejection(_ id: String) -> (code: String, output: String) {
        let code = (state["rejections"] as? [String: String])?[id] ?? "TOOL_NOT_PERMITTED"
        let result = (state["rejectionResults"] as? [String: [String: Any]])?[id]
        return (code, result?["output"] as? String ?? "Tool request rejected by the shared loop policy: \(code)")
    }
    func reply(_ text: String) -> String { SharedLoopPolicy.value("stopReply", ["reason": reason, "text": text]) as? String ?? "共享运行策略不可用，本轮已停止。" }
    static func fingerprint(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
}
