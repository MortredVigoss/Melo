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

    init(bundleURL: URL? = Bundle.main.url(forResource: "agent-core", withExtension: "js", subdirectory: "AgentCore"),
         manifestURL: URL? = Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "AgentCore")) throws {
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

    func evaluate(_ request: [String: Any]) async throws -> [String: Any] {
        try Task.checkCancellation()
        let bytes = try JSONSerialization.data(withJSONObject: request)
        guard bytes.count <= 2_000_000, let json = String(data: bytes, encoding: .utf8) else { throw SharedAgentCoreError.invalidReply }
        let result: [String: Any] = try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                guard !closed, let context else { continuation.resume(throwing: SharedAgentCoreError.closed); return }
                context.exception = nil
                // JSON is an argument value, never interpolated into source.
                guard let output = context.objectForKeyedSubscript("MeloAgent")?.objectForKeyedSubscript("evaluate")?.call(withArguments: [json])?.toString(),
                      context.exception == nil, let data = output.data(using: .utf8),
                      let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    continuation.resume(throwing: SharedAgentCoreError.invalidReply); return
                }
                continuation.resume(returning: value)
            }
        }
        try Task.checkCancellation()
        return result
    }

    func close() { queue.async { [self] in closed = true; context = nil } }
}
