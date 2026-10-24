import Foundation
import CryptoKit

struct RoutingAssignment: Codable, Equatable, Hashable {
    var connectionId: String
    var model: String
    var vision = false
}
struct PhoneRoutingPolicy: Codable, Equatable {
    var revision = 0
    var defaultMode = "fixed"
    var preference = "balanced"
    var allowCrossConnection = false
    var allowEscalation = true
    var tiers: [String: [RoutingAssignment]] = ["light": [], "standard": [], "strong": []]
    static func read(_ defaults: UserDefaults = .standard) -> Self {
        defaults.data(forKey: "smartRouting").flatMap { try? JSONDecoder().decode(Self.self, from: $0) } ?? Self()
    }
    static func save(_ value: Self, defaults: UserDefaults = .standard) throws -> Self {
        guard read(defaults).revision == value.revision else { throw MeloError.message("智能模式设置已被更新，草稿保留；请载入最新版本。") }
        var next = value; next.revision += 1
        defaults.set(try JSONEncoder().encode(next), forKey: "smartRouting")
        return next
    }
    var dictionary: [String: Any] { (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self))) as? [String: Any] ?? [:] }
}
struct PhoneRoutingCandidate: Codable, Equatable, Identifiable {
    var connectionId: String
    var model: String
    var name: String
    var capabilities: [String: Bool] = ["tools": true]
    var contextWindow = 0
    var available = true
    var id: String { connectionId + ":" + model }
    var assignment: RoutingAssignment { .init(connectionId: connectionId, model: model, vision: capabilities["vision"] == true) }
    var dictionary: [String: Any] { (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self))) as? [String: Any] ?? [:] }
}

/// Host adapter only: all minimums, scope, tier and escalation decisions are JS Core.
final class PhoneRoutingSession: @unchecked Sendable {
    private var input: [String: Any]
    private(set) var decision: [String: Any]
    private(set) var escalated = false
    var active: Bool { decision["mode"] as? String == "smart" }
    var model: String { decision["model"] as? String ?? "" }
    var connectionId: String { decision["connectionId"] as? String ?? "" }
    var cacheToken: String { String(data: (try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? "" }
    var judgmentText: String {
        let value = SharedLoopPolicy.value("modelRouting", ["action": "judgeInput", "routing": input]) as? [String: Any] ?? [:]
        return String(data: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data(), encoding: .utf8) ?? ""
    }
    var judge: [String: Any]? { decision["judge"] as? [String: Any] }
    var label: String { SharedLoopPolicy.value("modelRouting", ["action": "label", "decision": decision]) as? String ?? model }
    init(policy: PhoneRoutingPolicy, mode: String, connectionId: String, defaultModel: String, fixedModel: String = "", candidates: [PhoneRoutingCandidate], text: String, history: [[String: String]], attachments: [[String: String]]) throws {
        var policy = policy
        var candidates = candidates
        for i in candidates.indices {
            if candidates[i].capabilities["vision"] != false, policy.tiers.values.flatMap({ $0 }).contains(where: { $0.connectionId == candidates[i].connectionId && $0.model == candidates[i].model && $0.vision }) { candidates[i].capabilities["vision"] = true }
        }
        let local = candidates.filter { $0.connectionId == connectionId && $0.available }
        if policy.tiers.values.allSatisfy(\.isEmpty), local.count == 1 {
            policy.tiers = Dictionary(uniqueKeysWithValues: ["light", "standard", "strong"].map { ($0, [local[0].assignment]) })
        }
        input = ["mode": mode, "connectionId": connectionId, "defaultModel": defaultModel, "fixedModel": fixedModel, "policy": policy.dictionary,
                 "candidates": candidates.map(\.dictionary), "text": text, "context": history, "attachments": attachments]
        guard let selected = SharedLoopPolicy.value("modelRouting", ["routing": input]) as? [String: Any] else { throw MeloError.message("没有符合任务要求的智能模型，请在设置中配置所需档位和连接。") }
        decision = selected
    }
    func applyJudgment(_ json: String?) throws {
        input["judgmentAttempted"] = true
        if let json, let value = SharedLoopPolicy.value("modelRouting", ["action": "parse", "text": json]) as? [String: Any] { input["judgment"] = value }
        guard let selected = SharedLoopPolicy.value("modelRouting", ["routing": input]) as? [String: Any] else { throw MeloError.message("没有符合任务要求的智能模型，请在设置中配置所需档位和连接。") }
        decision = selected
    }
    func escalate(rounds: Int, failures: Int, requested: Bool = false, stopped: Bool = false, sideEffects: Bool = false) -> Bool {
        var request = input; request["previous"] = decision; request["rounds"] = rounds; request["failures"] = failures; request["requested"] = requested; request["stopped"] = stopped; request["sideEffects"] = sideEffects
        guard let selected = SharedLoopPolicy.value("modelRouting", ["action": "escalate", "routing": request]) as? [String: Any] else { return false }
        decision = selected; escalated = true; return true
    }
    static var judgePrompt: String { SharedLoopPolicy.value("modelRouting", ["action": "prompt"]) as? String ?? "" }
}

/// Routing requests share the caller's budget and cancellation. The factory
/// captures this turn's account/connection snapshot; no lookup of global secrets
/// is performed while choosing a tier.
final class PhoneRoutingHost: @unchecked Sendable {
    let session: PhoneRoutingSession
    let factory: @MainActor (String, String) async throws -> AgentModelTransport
    let judgmentMessages: [ChatMessage]
    var requested = false
    var sideEffects = false
    private let cacheKey: String
    private var prepared = false
    var currentTransport: AgentModelTransport? { selectedTransport }
    private var selectedTransport: AgentModelTransport?
    init(session: PhoneRoutingSession, messages: [ChatMessage], identity: String = UUID().uuidString, factory: @escaping @MainActor (String, String) async throws -> AgentModelTransport) {
        self.session = session; judgmentMessages = [ChatMessage(role: "user", content: session.judgmentText)]; self.factory = factory
        cacheKey = SHA256.hash(data: Data((identity + session.cacheToken).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static let control = PhoneToolDefinition(name: "melo_escalate", description: "Request one higher configured model tier. Continue from existing tool results without repeating successful actions.", parameters: ["type": "object", "properties": ["reason": ["type": "string"]], "required": ["reason"], "additionalProperties": false])
    func prepare(budget: PhoneRunBudget, stage: (@MainActor (String, String, String, String) -> Void)?) async throws -> AgentModelTransport {
        if prepared, let selectedTransport { return selectedTransport }
        try Task.checkCancellation()
        if let exhausted = budget.exhausted() { throw MeloError.message(PhoneRunBudget.reply(exhausted)) }
        if session.judge != nil, let cached = PhoneRoutingCache.read(cacheKey) { try session.applyJudgment(cached) }
        if let judge = session.judge, let model = judge["model"] as? String, let connection = judge["connectionId"] as? String {
            let transport = try await factory(connection, model)
            let rows = judgmentMessages.map { ["role": $0.role, "content": $0.content] }
            let review: [String: Any] = ["systemPrompt": PhoneRoutingSession.judgePrompt, "messages": rows]
            var reply: AgentRound?
            defer { budget.record(inputTokens: reply?.inputTokens ?? reply?.estimatedInputTokens ?? PhoneContextBudget.cost(judgmentMessages.map(\.content).joined(separator: "\n")), providerCalls: 1) }
            do {
                reply = try await PhoneDeadline.run(seconds: min(3, budget.remainingMs() / 1000)) {
                    try await transport.round(.init(iteration: 0, transcript: [], timeout: min(3, budget.requestTimeout(cap: 3)), outputLimit: 512, goalReview: review))
                }
            } catch { try Task.checkCancellation() }
            try session.applyJudgment(reply?.text)
            if let text = reply?.text, SharedLoopPolicy.value("modelRouting", ["action": "parse", "text": text]) is [String: Any] { PhoneRoutingCache.store(cacheKey, text) }
            await stage?("model-routing:judge", "智能模式判断", reply == nil ? "failed" : "completed", model)
        }
        try Task.checkCancellation()
        let transport = try await factory(session.connectionId, session.model)
        selectedTransport = transport; prepared = true
        await stage?("model-routing:0", "智能选模", "completed", session.label)
        return transport
    }
    func upgrade(rounds: Int, failures: Int, stopped: Bool, stage: (@MainActor (String, String, String, String) -> Void)?) async throws -> AgentModelTransport? {
        try Task.checkCancellation()
        defer { requested = false }
        guard session.escalate(rounds: rounds, failures: failures, requested: requested, stopped: stopped, sideEffects: sideEffects) else { return nil }
        let next = try await factory(session.connectionId, session.model)
        selectedTransport = next
        await stage?("model-routing:1", "智能选模", "completed", session.label)
        return next
    }
}

private enum PhoneRoutingCache {
    static let lock = NSLock()
    nonisolated(unsafe) static var values: [String: (Date, String)] = [:]
    static func read(_ key: String) -> String? { lock.lock(); defer { lock.unlock() }; guard let row = values[key], Date().timeIntervalSince(row.0) < 300 else { return nil }; return row.1 }
    static func store(_ key: String, _ value: String) { lock.lock(); defer { lock.unlock() }; if values.count >= 128 { values.removeAll() }; values[key] = (Date(), value) }
}
