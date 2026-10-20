import Foundation

// iPhone half of temporary capability elevation and just-in-time enabling
// (2026-10-20, docs/capability-elevation-20261020.md §9). Pure and
// Foundation-only: the same decision vocabulary, atoms, effective-scope
// formula, grant validity, durations, options and texts as
// src/domain/agent/capabilityElevation.js, all read from the shared contract
// (shared/protocol/agent-loop.json `capabilityElevation`, embedded in
// AgentLoopContract.swift). SharedContractTests runs the desktop fixtures
// against this file.
//
//   ceiling   = the Agent's own settings (phone execution: this iPhone's
//               per-Agent permissions, PhoneAgentPermissions)
//   base      = ceiling ∩ parent for a team member; the ceiling at top level
//   effective = base ∪ (ceiling ∩ active beyond-parent grants)
//                    ∪ active enable-own grants
//
// Grants are never folded into a scope: the runtime decides every call with
// the live ledger (CapabilityElevationRuntime.swift), so a revocation applies
// on the next call and a member starts from its parent's grant-free base.
//
// Atoms: the contract booleans, then the phone-only booleans of
// `capabilityElevation.phone` (calendar, reminders, contacts, location), then
// `<list>:<id>` (MCP servers, skills, connectors) — the canonical order.

struct CapabilityElevationContract {
    let decisions: [String]
    let responses: [String]
    let options: [String: [String]]
    let grantKinds: [String]
    /// Grant duration per scope (`run` is the 6-hour backstop; it also ends with its run).
    let grantDurations: [String: Double]
    let promptTimeoutMs: Double
    let booleanKeys: [String]
    let listKeys: [String]
    let jitVisible: [String]
    let newAgentStarter: [String]
    let capabilityLabels: [String: String]
    let listLabels: [String: String]
    let separator: String
    let texts: [String: String]
    let optionLabels: [String: [String: String]]
    let settingsScopes: [String: String]
    // phone
    let phoneBooleanKeys: [String]
    let phoneLabels: [String: String]
    /// Atoms backed by this iPhone's per-Agent permissions (device-local, never synced).
    let phonePermissionAtoms: [String]
    /// Phone tool → atom; nil value = no capability gate; missing tool = unclassified.
    let phoneTools: [String: String?]
    let phoneTexts: [String: String]

    init(_ raw: [String: Any]) {
        func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
        func strings(_ value: Any?) -> [String] { value as? [String] ?? [] }
        func map(_ value: Any?) -> [String: String] { value as? [String: String] ?? [:] }
        decisions = strings(raw["decisions"]); responses = strings(raw["responses"])
        options = (raw["options"] as? [String: [String]]) ?? [:]
        grantKinds = strings(raw["grantKinds"])
        grantDurations = object(raw["grantScopes"]).compactMapValues { (($0 as? [String: Any])?["durationMs"] as? NSNumber)?.doubleValue }
        promptTimeoutMs = (raw["promptTimeoutMs"] as? NSNumber)?.doubleValue ?? 120_000
        booleanKeys = strings(raw["booleanCapabilities"]); listKeys = strings(raw["listCapabilities"])
        jitVisible = strings(raw["jitVisible"]); newAgentStarter = strings(raw["newAgentStarter"])
        let labels = object(raw["labels"])
        listLabels = map(labels["lists"]); separator = labels["separator"] as? String ?? "、"
        let textObject = object(raw["texts"])
        texts = textObject.compactMapValues { $0 as? String }
        optionLabels = (textObject["optionLabels"] as? [String: [String: String]]) ?? [:]
        settingsScopes = map(textObject["settingsScopes"])
        let phone = object(raw["phone"])
        phoneBooleanKeys = strings(phone["booleanCapabilities"])
        let phoneLabelMap = map(phone["labels"])
        phoneLabels = phoneLabelMap
        capabilityLabels = map(labels["capabilities"]).merging(phoneLabelMap) { own, _ in own }
        phonePermissionAtoms = strings(phone["permissionAtoms"])
        phoneTools = object(phone["toolCapabilities"]).mapValues { $0 as? String }
        phoneTexts = map(phone["texts"])
    }
    /// Contract booleans first, then the phone-only ones.
    var allBooleans: [String] { booleanKeys + phoneBooleanKeys.filter { !booleanKeys.contains($0) } }
    /// What an Agent may see (and so ask for) on this iPhone with a surface:
    /// the contract's just-in-time booleans plus the phone-only booleans.
    var phoneJitVisible: [String] { jitVisible + phoneBooleanKeys.filter { !jitVisible.contains($0) } }
}

/// One side of a decision: the Agent's own settings (nil = legacy, unmigrated).
struct CapabilityParty: Equatable {
    var agentId: String
    var capabilities: Set<String>?
    /// Which settings scope "一直开启" writes ("global" | "project"); the phone's own permissions have none.
    var scope: String? = nil
    var globalCapabilities: Set<String>? = nil
}

struct CapabilityContext: Equatable {
    var surface = false
    var runId: String? = nil
    var projectId: String? = nil
    var chatId: String? = nil
    var allowedToolIds: [String]? = nil
}

/// A ledger record. Created only by the runtime's response path for a live request.
struct CapabilityGrant: Codable, Equatable, Identifiable {
    var id: String
    var agentId: String
    var atoms: [String]
    var kind: String
    var scope: String
    var runId: String?
    var projectId: String?
    var chatId: String?
    var parentAgentId: String?
    var toolId: String?
    var requestId: String?
    var decidedBy: String?
    var createdAt: Double
    var expiresAt: Double
    var bootId: String?
    var revokedAt: Double?
}

struct CapabilityScope: Equatable {
    var capabilities: Set<String>?
    var base: Set<String>?
    var ceiling: Set<String>?
    var grantIds: [String]
}

/// What one call needs: a predicate over atom sets plus the list atoms the tool names.
struct CapabilityRequirement {
    var allows: (Set<String>) -> Bool
    var listAtoms: [String] = []
    static let ungated = CapabilityRequirement(allows: { _ in true })
    static let unclassified = CapabilityRequirement(allows: { _ in false })
    static func atom(_ atom: String) -> CapabilityRequirement {
        CapabilityRequirement(allows: { $0.contains(atom) }, listAtoms: atom.contains(":") ? [atom] : [])
    }
    static func all(_ atoms: [String]) -> CapabilityRequirement {
        CapabilityRequirement(allows: { set in !atoms.isEmpty && atoms.allSatisfy { set.contains($0) } }, listAtoms: atoms.filter { $0.contains(":") })
    }
    /// The phone tool table (`capabilityElevation.phone.toolCapabilities`).
    static func phoneTool(_ name: String) -> CapabilityRequirement {
        guard let entry = CapabilityElevation.contract.phoneTools[name] else { return .unclassified }
        guard let atom = entry else { return .ungated }
        return CapabilityElevation.isAtom(atom) ? .atom(atom) : .unclassified
    }
}

struct CapabilityDecision: Equatable {
    var decision: String
    var reason: String? = nil
    var missing: [String] = []
    var effective: Set<String>?
    var base: Set<String>?
    var ceiling: Set<String>?
    var grantIds: [String] = []
    var options: [String]? = nil
    var projectOptionScope: String? = nil
    var alwaysUnavailable = false
    var wouldPrompt: String? = nil
    var isPrompt: Bool { CapabilityElevation.isPromptDecision(decision) }
}

/// Run-record summary of a decision (ExecutionToolCall.capability); never sent to the model.
struct CapabilityAudit: Codable, Equatable {
    var decision: String
    var reason: String?
    var missing: [String]
    var grantIds: [String]?
    var response: String?
    var status: String?
    var grantScope: String?
    var expiresAt: Double?
    var allowed: Bool
}

/// The runtime's verdict on one call at the tool choke point.
struct CapabilityGate: Equatable {
    /// Envelope to return instead of running the tool; nil = run it.
    var denial: String?
    var audit: CapabilityAudit?
    static let pass = CapabilityGate(denial: nil, audit: nil)
}

enum CapabilityElevation {
    static let contract = CapabilityElevationContract(AgentLoopContract.shared.raw["capabilityElevation"] as? [String: Any] ?? [:])
    private static let promptDecisions: Set<String> = ["elevate-beyond-parent", "enable-own"]
    static func isPromptDecision(_ decision: String) -> Bool { promptDecisions.contains(decision) }
    private static func present(_ value: String?) -> Bool { !(value ?? "").isEmpty }

    // MARK: Atoms

    static func isAtom(_ atom: String) -> Bool {
        guard !atom.isEmpty, JSText.length(atom) <= 240 else { return false }
        if contract.allBooleans.contains(atom) { return true }
        guard let separator = atom.firstIndex(of: ":"), separator != atom.startIndex else { return false }
        let list = String(atom[..<separator]), id = String(atom[atom.index(after: separator)...])
        return contract.listKeys.contains(list) && !JSText.trim(id).isEmpty && JSText.length(id) <= 200 && id == JSText.trim(id)
    }
    private static func rank(_ atom: String) -> (Int, String) {
        if let index = contract.allBooleans.firstIndex(of: atom) { return (index, "") }
        guard let separator = atom.firstIndex(of: ":") else { return (Int.max, atom) }
        let list = String(atom[..<separator])
        return (contract.allBooleans.count + (contract.listKeys.firstIndex(of: list) ?? contract.listKeys.count), String(atom[atom.index(after: separator)...]))
    }
    /// Canonical order: contract booleans, phone booleans, then MCP servers, skills, connectors by id (UTF-16 order, like JS).
    static func sort<S: Sequence>(_ atoms: S) -> [String] where S.Element == String {
        Array(Set(atoms)).sorted { a, b in
            let (x, y) = (rank(a), rank(b))
            if x.0 != y.0 { return x.0 < y.0 }
            return Array(x.1.utf16).lexicographicallyPrecedes(Array(y.1.utf16))
        }
    }
    /// Valid atoms only (unknown atoms are ignored: fail closed).
    static func atoms<S: Sequence>(_ values: S) -> Set<String> where S.Element == String { Set(values.filter(isAtom)) }

    static func intersect(_ a: Set<String>?, _ b: Set<String>?) -> Set<String>? {
        guard let a else { return b }
        guard let b else { return a }
        return a.intersection(b)
    }

    static func label(_ atom: String) -> String {
        if contract.allBooleans.contains(atom) { return contract.capabilityLabels[atom] ?? atom }
        guard let separator = atom.firstIndex(of: ":"), let template = contract.listLabels[String(atom[..<separator])] else { return atom }
        return AgentLoopContract.fill(template, ["id": String(atom[atom.index(after: separator)...])])
    }
    static func label<S: Sequence>(atoms: S) -> String where S.Element == String { sort(atoms).map(label).joined(separator: contract.separator) }

    // MARK: Grants

    /// run → same run; project → same project; chat → same chat outside a project.
    static func grantIsActive(_ grant: CapabilityGrant, agentId: String, context: CapabilityContext, now: Double) -> Bool {
        guard grant.agentId == agentId else { return false }
        if let revoked = grant.revokedAt, revoked != 0 { return false }
        guard grant.expiresAt.isFinite, grant.expiresAt > now, contract.grantKinds.contains(grant.kind) else { return false }
        guard !grant.atoms.isEmpty, grant.atoms.allSatisfy(isAtom) else { return false }
        switch grant.scope {
        case "run": return present(context.runId) && grant.runId == context.runId
        case "project": return present(context.projectId) && grant.projectId == context.projectId
        case "chat": return !present(context.projectId) && present(context.chatId) && grant.chatId == context.chatId
        default: return false
        }
    }
    /// Expiry of a grant created at `now` in `scope`; nil for an unknown scope.
    static func grantExpiry(_ scope: String, now: Double) -> Double? { contract.grantDurations[scope].map { now + $0 } }

    // MARK: Effective scope

    static func effectiveScope(member: CapabilityParty, parent: CapabilityParty? = nil, base: Set<String>? = nil, grants: [CapabilityGrant] = [], context: CapabilityContext = CapabilityContext(), now: Double) -> CapabilityScope {
        guard let ceiling = member.capabilities else { return CapabilityScope(capabilities: nil, base: nil, ceiling: nil, grantIds: []) }
        let baseCaps: Set<String>? = base ?? (parent != nil ? intersect(ceiling, parent?.capabilities) : ceiling)
        var added: [String] = [], grantIds: [String] = []
        for grant in grants where grantIsActive(grant, agentId: member.agentId, context: context, now: now) {
            // Beyond-parent grants only fill the gap below the member's own
            // ceiling; enable-own grants are the user's explicit widening of it.
            let atoms = grant.kind == "enable-own" ? grant.atoms : parent != nil ? grant.atoms.filter { ceiling.contains($0) } : []
            let fresh = atoms.filter { !(baseCaps?.contains($0) ?? false) }
            if !fresh.isEmpty { added += fresh; if !grantIds.contains(grant.id) { grantIds.append(grant.id) } }
        }
        return CapabilityScope(capabilities: added.isEmpty ? baseCaps : (baseCaps ?? []).union(added), base: baseCaps, ceiling: ceiling, grantIds: grantIds)
    }

    // MARK: Requirement of one call

    /// Smallest set of atoms that, added to `effective`, allows the call; ties
    /// prefer atoms inside the ceiling, then canonical order. nil: nothing allows it.
    static func missingAtoms(_ requirement: CapabilityRequirement, effective: Set<String>?, ceiling: Set<String>?) -> [String]? {
        let have = effective ?? []
        let candidates = sort((contract.allBooleans + requirement.listAtoms).filter { isAtom($0) && !have.contains($0) })
        guard !candidates.isEmpty else { return nil }
        for size in 1...candidates.count {
            var found: [[String]] = []
            func pick(_ start: Int, _ chosen: [String]) {
                if chosen.count == size {
                    if requirement.allows(have.union(chosen)) { found.append(chosen) }
                    return
                }
                guard start < candidates.count else { return }
                for index in start..<candidates.count { pick(index + 1, chosen + [candidates[index]]) }
            }
            pick(0, [])
            if !found.isEmpty { return found.first { $0.allSatisfy { ceiling?.contains($0) ?? false } } ?? found[0] }
        }
        return nil
    }

    // MARK: Decision

    static func decide(toolId: String, requirement: CapabilityRequirement, member: CapabilityParty, parent: CapabilityParty? = nil, base: Set<String>? = nil, grants: [CapabilityGrant] = [], context: CapabilityContext, now: Double) -> CapabilityDecision {
        let scope = effectiveScope(member: member, parent: parent, base: base, grants: grants, context: context, now: now)
        func result(_ decision: String, _ change: (inout CapabilityDecision) -> Void = { _ in }) -> CapabilityDecision {
            var value = CapabilityDecision(decision: decision, effective: scope.capabilities, base: scope.base, ceiling: scope.ceiling, grantIds: decision == "allowed" ? scope.grantIds : [])
            change(&value); return value
        }
        if let whitelist = context.allowedToolIds, !whitelist.contains(toolId) { return result("deny-ceiling") { $0.reason = "whitelist" } }
        guard let ceiling = scope.ceiling else { return result("allowed") { $0.reason = "legacy" } }
        if requirement.allows(scope.capabilities ?? []) {
            let viaBase = requirement.allows(scope.base ?? [])
            return result("allowed") { $0.reason = viaBase ? "base" : "grant" }
        }
        guard let missing = missingAtoms(requirement, effective: scope.capabilities, ceiling: ceiling) else { return result("deny-ceiling") { $0.reason = "unclassified" } }
        let outside = missing.filter { !ceiling.contains($0) }
        let wouldPrompt: String
        if !outside.isEmpty { wouldPrompt = "enable-own" }
        else if parent != nil { wouldPrompt = "elevate-beyond-parent" }
        else { return result("deny-ceiling") { $0.reason = "narrowed"; $0.missing = missing } }
        guard context.surface else { return result("deny-no-surface") { $0.reason = "no-surface"; $0.wouldPrompt = wouldPrompt; $0.missing = missing } }
        if wouldPrompt == "elevate-beyond-parent" {
            let projectScope = present(context.projectId) ? "project" : "chat"
            return result(wouldPrompt) { $0.missing = missing; $0.options = contract.options[wouldPrompt] ?? []; $0.projectOptionScope = projectScope }
        }
        // "一直开启" writes the settings scope this chat runs under. A project
        // override is intersected with the global settings, so it cannot enable
        // on its own what the global settings lack.
        let unavailable = member.scope == "project" && outside.contains { !(member.globalCapabilities?.contains($0) ?? false) }
        let options = (contract.options[wouldPrompt] ?? []).filter { $0 != "always" || !unavailable }
        return result(wouldPrompt) { $0.missing = missing; $0.options = options; $0.alwaysUnavailable = unavailable }
    }

    /// What an Agent may see: what it has, plus — only with a surface — its own
    /// ceiling (beyond-parent) and the just-in-time booleans (enable-own).
    static func requestable(_ capabilities: Set<String>?, ceiling: Set<String>?, surface: Bool, jitVisible: [String] = contract.jitVisible) -> Set<String>? {
        guard let capabilities, surface else { return capabilities }
        return capabilities.union(ceiling ?? []).union(atoms(jitVisible))
    }

    // MARK: Texts (contract sources; the UI localizes the same keys)

    static func text(_ key: String, _ values: [String: String] = [:]) -> String { AgentLoopContract.fill(contract.texts[key] ?? key, values) }
    /// Phone wording where the desktop text names the desktop (`phone.texts`).
    static func phoneText(_ key: String, _ values: [String: String] = [:]) -> String { AgentLoopContract.fill(contract.phoneTexts[key] ?? contract.texts[key] ?? key, values) }
    static func promptText(decision: String, agent: String, parent: String?, atoms: [String]) -> String {
        let capability = label(atoms: atoms)
        return decision == "elevate-beyond-parent"
            ? text("beyondParentPrompt", ["agent": agent, "parent": parent ?? "", "capability": capability])
            : text("enableOwnPrompt", ["agent": agent, "capability": capability])
    }
    static func optionLabel(_ decision: String, _ option: String, projectOptionScope: String = "project") -> String {
        contract.optionLabels[decision]?[option == "project" ? projectOptionScope : option] ?? option
    }
}
