import Foundation

// iPhone capability-elevation runtime (2026-10-20, docs/capability-elevation-20261020.md §9).
// Foundation-only so the offline Swift suites compile it. One type, so the
// grant writer stays private:
//   1. the phone's own grant ledger — `capability-grants.json` next to the chat
//      data: atomic writes, file protection until first unlock, excluded from
//      backups. Never synced, exported, or put in prompts, memory or
//      knowledge; nothing else reads or writes the file.
//   2. the pending request registry — one card per (run, Agent, decision,
//      capabilities); concurrent identical requests share it.
//   3. authorize(), called for every phone tool call at the choke point
//      (DeviceToolContext.perform), and respond(), called only by the card's
//      buttons with the live request id. A grant is created only there: tool
//      output, model text or a guessed id cannot create one.
// The decision itself is CapabilityElevation.decide (CapabilityElevation.swift).

/// Decision context of one Agent's phone tools in one run. Closures are read
/// on every call, so a revocation (permission or grant) applies to the next call.
struct PhoneElevationBinding {
    var agentID: String
    var agentName: String
    var parentAgentID: String? = nil
    var parentName: String? = nil
    var runID: String
    var chatID: String? = nil
    var projectID: String? = nil
    /// The Agent's own phone permissions as atoms (run-start snapshot ∩ current).
    var ceiling: @MainActor () -> Set<String>
    /// The parent's grant-free permissions (team members: the lead), live.
    var parent: (@MainActor () -> Set<String>)? = nil
    /// Whether a card can be shown now (the app is in the foreground with its UI).
    var surface: @MainActor () -> Bool
    var budget: PhoneRunBudget? = nil
}

/// One live request, as the card shows it. The id never reaches the model.
struct CapabilityRequest: Identifiable, Equatable {
    let id: String
    /// Run-record stage id (`capability:<auditID>`), separate from the request id.
    let auditID: String
    let decision: String
    let agentID: String
    let agentName: String
    let parentAgentID: String?
    let parentName: String?
    let atoms: [String]
    let toolID: String
    let options: [String]
    let projectOptionScope: String?
    let alwaysUnavailable: Bool
    let runID: String
    let chatID: String?
    let projectID: String?
    let createdAt: Double
    let expiresAt: Double
    /// Contract source text (the card localizes the same template).
    let prompt: String
}

enum CapabilityRequestError: LocalizedError, Equatable {
    case ended, notOffered, inProgress
    var errorDescription: String? {
        switch self {
        case .ended: return "这个授权请求已经结束，没有保存任何授权。"
        case .notOffered: return "This decision is not offered for this request."
        case .inProgress: return "正在保存上一次选择，请稍候。"
        }
    }
}

@MainActor final class CapabilityElevationBroker {
    enum Status: String { case granted, denied, timeout, budget, aborted }
    struct Outcome { var status: Status; var response: String? = nil; var grant: CapabilityGrant? = nil; var settingsScope: String? = nil }

    static let fileName = "capability-grants.json"
    static let ledgerVersion = 1
    static let maxGrants = 500

    let file: URL?
    /// Per launch: run grants of another launch are dropped on load.
    let bootID: String
    let clock: () -> Double
    let promptTimeoutMs: Double
    private(set) var grants: [CapabilityGrant] = []
    private var pending: [String: Entry] = [:]
    private var collapsed: [String: String] = [:]

    /// Show / close a card (ChatStore's approval queue).
    var onRequest: (@MainActor (CapabilityRequest) -> Void)?
    var onClose: (@MainActor (CapabilityRequest, Status) -> Void)?
    /// Run-record stage: (request, stage status, text).
    var onAudit: (@MainActor (CapabilityRequest, String, String) -> Void)?
    var onGrantsChanged: (@MainActor () -> Void)?
    /// «一直开启»: changes the Agent's setting through the existing path and
    /// returns the settings-scope key ("phone", or "global"/"project" for a
    /// synced widening that waits for desktop confirmation).
    var enableAlways: (@MainActor (CapabilityRequest) throws -> String)?

    private final class Entry {
        let request: CapabilityRequest
        let key: String
        var waiters: [CheckedContinuation<Outcome, Never>] = []
        var settled = false
        var resolving = false
        var outcome: Outcome?
        var timer: Task<Void, Never>?
        init(_ request: CapabilityRequest, key: String) { self.request = request; self.key = key }
    }

    init(file: URL?, bootID: String = UUID().uuidString, clock: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }, promptTimeoutMs: Double? = nil) {
        self.file = file; self.bootID = bootID; self.clock = clock
        let contractTimeout = CapabilityElevation.contract.promptTimeoutMs
        self.promptTimeoutMs = promptTimeoutMs.map { max(1, min($0, contractTimeout)) } ?? contractTimeout
        grants = prune(readLedger(), now: clock())
    }

    // MARK: Ledger

    /// A valid record, or nil (desktop normalizeGrant): nothing is widened.
    static func normalize(_ raw: CapabilityGrant) -> CapabilityGrant? {
        let c = CapabilityElevation.contract
        func text(_ value: String?, _ max: Int = 200) -> String? { value.flatMap { !JSText.trim($0).isEmpty && JSText.length($0) <= max ? $0 : nil } }
        guard text(raw.id, 80) != nil, text(raw.agentId, 100) != nil, c.grantDurations[raw.scope] != nil, c.grantKinds.contains(raw.kind),
              (1...16).contains(raw.atoms.count), raw.atoms.allSatisfy(CapabilityElevation.isAtom),
              raw.createdAt.isFinite, raw.createdAt > 0, raw.expiresAt.isFinite, raw.expiresAt > raw.createdAt, raw.decidedBy == "user" else { return nil }
        var record = raw
        record.atoms = CapabilityElevation.sort(raw.atoms)
        record.runId = raw.scope == "run" ? text(raw.runId) : nil
        record.projectId = raw.scope == "chat" ? nil : text(raw.projectId)
        record.chatId = text(raw.chatId)
        record.parentAgentId = text(raw.parentAgentId, 100)
        record.toolId = text(raw.toolId, 240)
        record.requestId = text(raw.requestId, 80)
        record.bootId = raw.scope == "run" ? text(raw.bootId, 80) : nil
        record.revokedAt = nil
        if raw.revokedAt.map({ $0 != 0 }) == true { return nil }
        if raw.scope == "run" && (record.runId == nil || record.bootId == nil) { return nil }
        if raw.scope == "project" && record.projectId == nil { return nil }
        if raw.scope == "chat" && record.chatId == nil { return nil }
        return record
    }
    /// Drop invalid and expired grants and run grants of another launch.
    private func prune(_ list: [CapabilityGrant], now: Double) -> [CapabilityGrant] {
        Array(list.compactMap(Self.normalize).filter { $0.expiresAt > now && ($0.scope != "run" || $0.bootId == bootID) }.suffix(Self.maxGrants))
    }
    /// Missing file = empty ledger. An unreadable one is kept aside as
    /// `.corrupt-<time>` and treated as empty (it can only ever have held grants).
    private func readLedger() -> [CapabilityGrant] {
        guard let file, FileManager.default.fileExists(atPath: file.path) else { return [] }
        do {
            let data = try Data(contentsOf: file)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (object["version"] as? NSNumber)?.intValue == Self.ledgerVersion, let rows = object["grants"] as? [Any] else { throw CocoaError(.fileReadCorruptFile) }
            return rows.compactMap { row in
                guard JSONSerialization.isValidJSONObject(row), let bytes = try? JSONSerialization.data(withJSONObject: row) else { return nil }
                return try? JSONDecoder().decode(CapabilityGrant.self, from: bytes)
            }
        } catch {
            try? FileManager.default.moveItem(at: file, to: file.appendingPathExtension("corrupt-\(Int(clock()))"))
            return []
        }
    }
    private struct LedgerFile: Codable { var version: Int; var grants: [CapabilityGrant] }
    /// The only writer. Atomic, private to this app's data directory, not backed up.
    private func writeGrants(_ mutate: ([CapabilityGrant]) -> [CapabilityGrant]) throws {
        let next = prune(mutate(grants), now: clock())
        if var file {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
            let data = try encoder.encode(LedgerFile(version: Self.ledgerVersion, grants: next))
            #if os(iOS)
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: file, options: [.atomic])
            #endif
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try? file.setResourceValues(values)
        }
        grants = next
        onGrantsChanged?()
    }

    /// Grants in force (not expired; run grants of this launch), newest first.
    func list(agentID: String? = nil) -> [CapabilityGrant] {
        let now = clock()
        return grants.filter { $0.expiresAt > now && (agentID == nil || $0.agentId == agentID) }.sorted { $0.createdAt > $1.createdAt }
    }
    /// Revocation takes effect on the next tool call (every call re-reads the ledger).
    @discardableResult func revoke(_ id: String) throws -> CapabilityGrant? {
        guard let found = grants.first(where: { $0.id == id }) else { return nil }
        try writeGrants { $0.filter { $0.id != id } }
        return found
    }
    /// Run grants end with their run; open cards of the run close.
    func releaseRun(_ runID: String) {
        if grants.contains(where: { $0.scope == "run" && $0.runId == runID }) {
            try? writeGrants { $0.filter { !($0.scope == "run" && $0.runId == runID) } }
        }
        for entry in pending.values where entry.request.runID == runID { settle(entry.request.id, Outcome(status: .aborted)) }
    }
    /// Closes one open card as cancelled (its run stopped).
    func abort(_ requestID: String) { settle(requestID, Outcome(status: .aborted)) }
    var pendingRequests: [CapabilityRequest] { pending.values.map(\.request).sorted { $0.createdAt < $1.createdAt } }

    // MARK: Decisions

    func decide(toolID: String, requirement: CapabilityRequirement, binding: PhoneElevationBinding, surface: Bool) -> CapabilityDecision {
        let member = CapabilityParty(agentId: binding.agentID, capabilities: binding.ceiling())
        let parent = binding.parent.map { CapabilityParty(agentId: binding.parentAgentID ?? "", capabilities: $0()) }
        let context = CapabilityContext(surface: surface, runId: binding.runID, projectId: binding.projectID, chatId: binding.chatID)
        return CapabilityElevation.decide(toolId: toolID, requirement: requirement, member: member, parent: parent, grants: grants, context: context, now: clock())
    }
    /// Whether the call is allowed right now without asking (re-checks during a running call).
    func allowsNow(toolID: String, requirement: CapabilityRequirement, binding: PhoneElevationBinding) -> Bool {
        decide(toolID: toolID, requirement: requirement, binding: binding, surface: false).decision == "allowed"
    }

    static func deniedOutput(agentID: String, toolID: String) -> String {
        PhoneToolEnvelope.failure("CAPABILITY_DENIED", "Agent \(agentID) is not allowed to execute \(toolID).")
    }
    private static func audit(_ decision: CapabilityDecision, allowed: Bool) -> CapabilityAudit {
        CapabilityAudit(decision: decision.decision, reason: decision.reason ?? decision.wouldPrompt, missing: decision.missing,
                        grantIds: decision.grantIds.isEmpty ? nil : decision.grantIds, allowed: allowed)
    }

    /// The choke-point check for one call. Allowed by the grant-free view →
    /// pass; allowed by a grant → pass with an audit; a deny decision → the
    /// same CAPABILITY_DENIED as before; a prompt decision → a card, then the
    /// user's decision (or timeout / run deadline / cancellation).
    func authorize(toolID: String, requirement: CapabilityRequirement, binding: PhoneElevationBinding) async -> CapabilityGate {
        let decision = decide(toolID: toolID, requirement: requirement, binding: binding, surface: binding.surface())
        if decision.decision == "allowed" { return decision.reason == "grant" ? CapabilityGate(denial: nil, audit: Self.audit(decision, allowed: true)) : .pass }
        guard decision.isPrompt else { return CapabilityGate(denial: Self.deniedOutput(agentID: binding.agentID, toolID: toolID), audit: Self.audit(decision, allowed: false)) }
        let outcome = await wait(decision: decision, toolID: toolID, binding: binding)
        var meta = Self.audit(decision, allowed: false)
        meta.status = outcome.status.rawValue; meta.response = outcome.response
        let values = ["agent": binding.agentName, "capability": CapabilityElevation.label(atoms: decision.missing), "tool": toolID]
        switch outcome.status {
        case .granted:
            let after = decide(toolID: toolID, requirement: requirement, binding: binding, surface: false)
            guard after.decision == "allowed" else { meta.status = "changed"; return CapabilityGate(denial: Self.deniedOutput(agentID: binding.agentID, toolID: toolID), audit: meta) }
            meta.allowed = true; meta.grantIds = after.grantIds.isEmpty ? nil : after.grantIds
            meta.grantScope = outcome.grant?.scope; meta.expiresAt = outcome.grant?.expiresAt
            return CapabilityGate(denial: nil, audit: meta)
        case .budget:
            return CapabilityGate(denial: PhoneToolEnvelope.failure("BUDGET_EXHAUSTED", CapabilityElevation.phoneText("timeoutOutput", values)), audit: meta)
        case .aborted:
            return CapabilityGate(denial: PhoneToolEnvelope.failure("ABORTED", CapabilityElevation.text("abortedOutput", values)), audit: meta)
        case .timeout:
            return CapabilityGate(denial: PhoneToolEnvelope.failure("CAPABILITY_DENIED", CapabilityElevation.phoneText("timeoutOutput", values)), audit: meta)
        case .denied:
            return CapabilityGate(denial: PhoneToolEnvelope.failure("CAPABILITY_DENIED", CapabilityElevation.text("deniedOutput", values)), audit: meta)
        }
    }

    /// Opens (or joins) the card for this decision and waits for its outcome.
    private func wait(decision: CapabilityDecision, toolID: String, binding: PhoneElevationBinding) async -> Outcome {
        let key = [binding.runID, binding.agentID, decision.decision, decision.missing.joined(separator: ",")].joined(separator: "\u{1F}")
        let entry: Entry
        if let id = collapsed[key], let existing = pending[id], !existing.settled { entry = existing }
        else {
            let now = clock()
            let budgetLeft = binding.budget?.remainingMs() ?? .infinity
            guard budgetLeft > 0 else { return Outcome(status: .budget) }
            let wait = max(1, min(promptTimeoutMs, budgetLeft))
            // The run deadline still applies while waiting: when it is the nearer limit, expiry is a budget stop.
            let byBudget = budgetLeft <= promptTimeoutMs
            let request = CapabilityRequest(
                id: UUID().uuidString, auditID: UUID().uuidString, decision: decision.decision, agentID: binding.agentID, agentName: binding.agentName,
                parentAgentID: binding.parentAgentID, parentName: binding.parentName, atoms: decision.missing, toolID: toolID,
                options: decision.options ?? [], projectOptionScope: decision.projectOptionScope, alwaysUnavailable: decision.alwaysUnavailable,
                runID: binding.runID, chatID: binding.chatID, projectID: binding.projectID, createdAt: now, expiresAt: now + wait,
                prompt: CapabilityElevation.promptText(decision: decision.decision, agent: binding.agentName, parent: binding.parentName, atoms: decision.missing))
            entry = Entry(request, key: key)
            pending[request.id] = entry; collapsed[key] = request.id
            let id = request.id
            entry.timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000))
                guard !Task.isCancelled else { return }
                self?.settle(id, Outcome(status: byBudget ? .budget : .timeout))
            }
            onAudit?(request, "running", CapabilityElevation.text("auditWaiting", ["prompt": request.prompt]))
            onRequest?(request)
        }
        let id = entry.request.id
        return await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
                if entry.settled { continuation.resume(returning: entry.outcome ?? Outcome(status: .aborted)); return }
                entry.waiters.append(continuation)
                if Task.isCancelled { settle(id, Outcome(status: .aborted)) }
            }
        }, onCancel: {
            Task { @MainActor [weak self] in self?.settle(id, Outcome(status: .aborted)) }
        })
    }

    private static func minute(_ ms: Double) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
    private func settle(_ id: String, _ outcome: Outcome) {
        guard let entry = pending[id], !entry.settled else { return }
        entry.settled = true; entry.outcome = outcome
        entry.timer?.cancel()
        pending[id] = nil
        if collapsed[entry.key] == id { collapsed[entry.key] = nil }
        let request = entry.request, c = CapabilityElevation.contract
        let values = ["agent": request.agentName, "capability": CapabilityElevation.label(atoms: request.atoms)]
        switch outcome.status {
        case .granted where outcome.response == "always":
            let scope = outcome.settingsScope == "phone" ? c.phoneTexts["settingsScope"] ?? "" : c.settingsScopes[outcome.settingsScope ?? ""] ?? ""
            onAudit?(request, "completed", CapabilityElevation.text("auditAlways", values.merging(["settingsScope": scope]) { a, _ in a }) + " · " + request.toolID)
        case .granted:
            let scope = CapabilityElevation.optionLabel(request.decision, outcome.response ?? "run", projectOptionScope: request.projectOptionScope ?? "project")
            onAudit?(request, "completed", CapabilityElevation.text("auditGranted", values.merging(["scope": scope, "expires": Self.minute(outcome.grant?.expiresAt ?? 0)]) { a, _ in a }) + " · " + request.toolID)
        default:
            let key = ["denied": "auditDenied", "timeout": "auditTimeout", "budget": "auditTimeout", "aborted": "auditAborted"][outcome.status.rawValue] ?? "auditDenied"
            onAudit?(request, outcome.status == .aborted ? "cancelled" : "failed", CapabilityElevation.text(key, values) + " · " + request.toolID)
        }
        onClose?(request, outcome.status)
        let waiters = entry.waiters; entry.waiters = []
        for waiter in waiters { waiter.resume(returning: outcome) }
    }

    // MARK: The user's decision

    /// The only path that creates a grant: the card's button, with the id of a
    /// request that is still open, and one of the options that card offered.
    @discardableResult func respond(requestID: String, decision: String) throws -> CapabilityGrant? {
        guard let entry = pending[requestID], !entry.settled else { throw CapabilityRequestError.ended }
        guard CapabilityElevation.contract.responses.contains(decision), entry.request.options.contains(decision) else { throw CapabilityRequestError.notOffered }
        guard !entry.resolving else { throw CapabilityRequestError.inProgress }
        entry.resolving = true
        defer { entry.resolving = false }
        if decision == "deny" { settle(requestID, Outcome(status: .denied, response: "deny")); return nil }
        var settingsScope: String? = nil
        if decision == "always" {
            guard let enableAlways else { throw CapabilityRequestError.notOffered }
            settingsScope = try enableAlways(entry.request)
        }
        guard !entry.settled else { throw CapabilityRequestError.ended }
        // «一直开启» also grants this run: the run's permission snapshot predates the change.
        let grant = try createGrant(entry.request, scope: decision == "project" ? "project" : "run")
        settle(requestID, Outcome(status: .granted, response: decision, grant: grant, settingsScope: settingsScope))
        return grant
    }
    private func createGrant(_ request: CapabilityRequest, scope: String) throws -> CapabilityGrant {
        let now = clock()
        let grantScope = scope == "project" ? (request.projectOptionScope ?? ((request.projectID ?? "").isEmpty ? "chat" : "project")) : "run"
        guard let expiresAt = CapabilityElevation.grantExpiry(grantScope, now: now) else { throw CapabilityRequestError.notOffered }
        let grant = CapabilityGrant(id: "cg_" + UUID().uuidString.lowercased(), agentId: request.agentID, atoms: request.atoms, kind: request.decision, scope: grantScope,
                                    runId: request.runID, projectId: grantScope == "chat" ? nil : request.projectID, chatId: request.chatID,
                                    parentAgentId: request.parentAgentID, toolId: request.toolID, requestId: request.id, decidedBy: "user",
                                    createdAt: now, expiresAt: expiresAt, bootId: grantScope == "run" ? bootID : nil)
        guard let valid = Self.normalize(grant) else { throw CapabilityRequestError.notOffered }
        try writeGrants { $0 + [valid] }
        return valid
    }
}
