import Foundation

// Capability elevation rule 6 on the iPhone (2026-10-20): a new Agent starts
// read-only, and «基于已有 Agent» copies what the desktop's
// buildNewCustomAgent copies (src/services/agent/agentProfileService.js).
// Pure; the create form in AgentEditor.swift applies it to its draft.

enum AgentStarter {
    /// The contract's starter set (`newAgentStarter`: 读取文件, 联网, 知识与记忆)
    /// in the synced capability shape; MCP servers, skills and connectors empty.
    static var capabilities: SyncValue {
        var object = AgentSettingsProjection.emptyCapabilities.object
        for key in CapabilityElevation.contract.newAgentStarter where object[key] != nil { object[key] = .bool(true) }
        return .object(object)
    }
    /// A blank new Agent with the starter set. Its phone permissions ("这台手机上")
    /// are device-local and keep the phone default; this contract does not change them.
    static func newAgent() -> AgentProfile {
        var agent = AgentProfile(name: "", subtitle: "", symbol: "person.crop.square", instructions: "")
        agent.capabilities = capabilities
        return agent
    }

    /// Settings from the starting point: the chosen Agent's capabilities,
    /// collaboration (minus the new Agent as a delegate target), context sources
    /// and model — or the starter set and defaults. Never the id, name, avatar or icon.
    static func settings(_ draft: AgentProfile, source: AgentProfile?) -> AgentProfile {
        var value = draft
        guard let source else {
            value.capabilities = capabilities; value.collaboration = nil; value.contextSources = nil; value.model = nil
            return value
        }
        value.capabilities = source.capabilities ?? capabilities
        value.collaboration = source.collaboration.map { collaboration in
            var object = collaboration.object
            object["delegateTargets"] = .array(collaboration["delegateTargets"].array.filter { $0.string != draft.id })
            return .object(object)
        }
        value.contextSources = source.contextSources
        value.model = source.model
        return value
    }

    struct Persona: Equatable { var instructions: String; var description: String; var mood: String? }
    static func persona(_ agent: AgentProfile) -> Persona { Persona(instructions: agent.instructions, description: agent.description, mood: agent.mood) }
    /// Identity and persona — the instruction document (with its 身份 / 风格
    /// sections), the description and the mood — only when ticked. The phone has
    /// no per-Agent voice to copy.
    static func copyPersona(_ draft: AgentProfile, from source: AgentProfile) -> AgentProfile {
        var value = draft
        value.instructions = source.instructions; value.description = source.description; value.mood = source.mood
        return value
    }
    static func clearPersona(_ draft: AgentProfile) -> AgentProfile {
        var value = draft
        value.instructions = ""; value.description = ""; value.mood = nil
        return value
    }
    /// Re-applies the starting point after the choice or the tick changed. A
    /// persona copied earlier is taken out again only while it is unedited.
    static func apply(_ draft: AgentProfile, source: AgentProfile?, copyPersona copy: Bool, previousSource: AgentProfile?, previousCopy: Bool) -> AgentProfile {
        var value = settings(draft, source: source)
        if previousCopy, let previousSource, persona(value) == persona(previousSource) { value = clearPersona(value) }
        if copy, let source { value = copyPersona(value, from: source) }
        return value
    }
}

/// A phone-originated widening of an Agent's synced (desktop) capabilities.
/// It is written to the phone's copy of the Agent's settings and travels on
/// the optional agent-settings sync channel; the desktop applies narrowing at
/// once but holds a widening as pending until the user confirms it there
/// (mobile-sync/agentSettings.js). Phone permissions never come here.
enum AgentCapabilityWidening {
    static func has(_ capabilities: SyncValue?, _ atom: String) -> Bool {
        guard let capabilities, case .object = capabilities else { return false }
        guard let separator = atom.firstIndex(of: ":") else { return capabilities[atom].bool }
        return capabilities[String(atom[..<separator])].array.contains(.string(String(atom[atom.index(after: separator)...])))
    }
    static func widened(_ capabilities: SyncValue, with atoms: [String]) -> SyncValue {
        var object = capabilities.object
        for atom in atoms {
            if let separator = atom.firstIndex(of: ":") {
                let list = String(atom[..<separator]), id = SyncValue.string(String(atom[atom.index(after: separator)...]))
                var items = object[list]?.array ?? []
                if !items.contains(id) { items.append(id) }
                object[list] = .array(items.sorted { $0.string < $1.string })
            } else { object[atom] = .bool(true) }
        }
        return .object(object)
    }
    /// Writes the widening into the settings scope this chat runs under (the
    /// project override when it has capabilities, else the global settings) and
    /// returns that scope ("project" | "global").
    static func propose(_ atoms: [String], agentID: String, projectID: String?, preferences: inout MobilePreferences) throws -> String {
        let contract = CapabilityElevation.contract
        guard !atoms.isEmpty, atoms.allSatisfy({ CapabilityElevation.isAtom($0) && !contract.phonePermissionAtoms.contains($0) && !contract.phoneBooleanKeys.contains($0) }) else {
            throw MeloError.message("This capability is not a synced Agent setting.")
        }
        guard let index = preferences.agents.firstIndex(where: { $0.id == agentID }) else { throw MeloError.message("本对话的Agent已不存在，请重新选择。") }
        guard let global = preferences.agents[index].capabilities else { throw MeloError.message("请先在 Agent 设置里完成能力迁移。") }
        if let projectID, let override = preferences.projectAgents?[projectID]?[agentID]?.capabilities {
            // A project override is intersected with the global settings: it cannot enable on its own what they lack.
            guard atoms.allSatisfy({ has(global, $0) }) else {
                throw MeloError.message(CapabilityElevation.text("alwaysUnavailable", ["capability": CapabilityElevation.label(atoms: atoms)]))
            }
            preferences.projectAgents?[projectID]?[agentID]?.capabilities = widened(override, with: atoms)
            return "project"
        }
        preferences.agents[index].capabilities = widened(global, with: atoms)
        return "global"
    }
}
