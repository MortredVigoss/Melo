#if DEBUG && targetEnvironment(simulator)
import Foundation

/// Exercises the real ChatStore preparation, persistence and approval queue.
/// Isolated directory, scripted replies, no credentials or device data access.
@MainActor enum ParityVerification {
    static func run() async {
        let output = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/parity-verification.json")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("parity-" + UUID().uuidString)
        var receipt: [String: Any] = ["passed": false]
        var requests: [([ChatMessage], String)] = []
        let loader: ([ChatMessage], String) async throws -> ModelReply = { messages, system in
            await MainActor.run { requests.append((messages, system)) }
            if system == PhoneCompact.instruction { return ModelReply(text: "Earlier verified plan: keep compatibility; original IDs remain available.") }
            if messages.last?.content.hasPrefix("wait for approval") == true { try await Task.sleep(nanoseconds: 600_000_000) }
            return ModelReply(text: "fixture reply")
        }
        let store = ChatStore(directory: directory, replyLoader: loader)
        func settle() async throws {
            for _ in 0..<500 where store.anySending { try await Task.sleep(nanoseconds: 20_000_000) }
            if store.anySending { throw MeloError.message("fixture did not settle") }
            if let error = store.error { throw MeloError.message(error) }
        }
        do {
            guard let chat = store.newChat(agentID: "melo") else { throw MeloError.message("new chat failed") }
            let old = (0..<40).map { ChatMessage(id: "old-\($0)", role: $0.isMultiple(of: 2) ? "user" : "assistant", content: "prior plan \($0) " + String(repeating: "汉", count: 600)) }
            store.chats[0].messages = old
            store.selectModel(.init(connectionID: "chatgpt", model: "fixture", contextWindow: 14000), chatID: chat)
            store.send("continue the earlier plan", chatID: chat)
            try await settle()
            guard store.preferences.chatCompact?[chat] != nil, requests.contains(where: { $0.1 == PhoneCompact.instruction }), requests.last?.1.contains("Earlier verified plan") == true else { throw MeloError.message("ChatStore failed to use its own compact card") }
            guard Array(store.chats[0].messages.prefix(old.count)) == old else { throw MeloError.message("source messages changed") }
            let reloaded = ChatStore(directory: directory, replyLoader: loader)
            guard reloaded.chats[0].messages == store.chats[0].messages, reloaded.preferences.chatCompact?[chat] == store.preferences.chatCompact?[chat] else { throw MeloError.message("round-trip persistence failed") }
            receipt["compact_and_originals"] = true

            let secret = KnowledgeNote(id: "private", title: "private", content: "DISABLED_KNOWLEDGE_SECRET", updatedAt: timestamp())
            _ = store.updatePreferences { p in
                p.knowledge = [secret]; p.chatKnowledge = [chat: [secret.id]]
                if let i = p.agents.firstIndex(where: { $0.id == "melo" }) { p.agents[i].contextSources = .object(["knowledge": .bool(false), "projects": .bool(false)]) }
            }
            store.send("what is the earlier decision?", chatID: chat)
            try await settle()
            guard requests.last?.1.contains("DISABLED_KNOWLEDGE_SECRET") == false else { throw MeloError.message("disabled context sent") }
            receipt["filtered_preparation"] = true

            store.send("wait for approval", chatID: chat)
            var writes = 0
            let approval = Task { @MainActor in
                try await PhoneDeadline.run(seconds: 0.04) {
                    let allowed = await store.requestDeviceApproval(DeviceActionRequest(tool: "reminders_create", title: "fixture", detail: "fixture"), chatID: chat)
                    try Task.checkCancellation()
                    if allowed { await MainActor.run { writes += 1 } }
                    return allowed
                }
            }
            for _ in 0..<50 where store.pendingDeviceAction == nil { try await Task.sleep(nanoseconds: 1_000_000) }
            do { _ = try await approval.value; throw MeloError.message("approval did not expire") } catch is PhoneDeadline.Reached {}
            for _ in 0..<50 where store.pendingDeviceAction != nil { try await Task.sleep(nanoseconds: 2_000_000) }
            guard store.pendingDeviceAction == nil else { throw MeloError.message("expired approval remained visible") }
            store.resolveDeviceAction(true)
            guard writes == 0 else { throw MeloError.message("late approval wrote data") }
            try await settle()
            store.send("next turn", chatID: chat); try await settle()
            receipt["approval_timeout_no_write_next_turn"] = true
            // Real team send uses project overrides and the already-filtered context.
            let project = PersonalProject(id: "team-project", name: "Team project", goal: "PROJECT_TEAM_GOAL")
            let teamNote = KnowledgeNote(id: "team-note", title: "Team source", content: "TEAM_KNOWLEDGE_EVIDENCE", updatedAt: timestamp())
            _ = store.updatePreferences { p in
                p.projects = [project]; p.chatProjects = [chat: project.id]
                p.knowledge = [teamNote] + (0..<14).map { KnowledgeNote(id: "extra-\($0)", title: "Extra", content: "other reference", updatedAt: timestamp()) }; p.chatKnowledge = [chat: Set(p.knowledge!.map(\.id))]
                if let i = p.agents.firstIndex(where: { $0.id == "melo" }) {
                    p.agents[i].contextSources = nil
                    p.agents[i].collaboration = .object(["canDelegate": .bool(true), "delegateTargets": .array([.string("writer")])])
                }
                var member = p.agents.first { $0.id == "writer" }!
                member.instructions = "PROJECT_MEMBER_PERSONA"
                p.projectAgents = [project.id: [member.id: member]]
            }
            let beforeTeam = requests.count
            store.armTeam(.init(templateID: "research-build-review", members: ["writer"]), chatID: chat)
            store.send("continue with the team", chatID: chat); try await settle()
            guard let memberRequest = requests.dropFirst(beforeTeam).first(where: { $0.1.contains("PROJECT_MEMBER_PERSONA") }),
                  memberRequest.1.contains("PROJECT_TEAM_GOAL"), memberRequest.1.contains("TEAM_KNOWLEDGE_EVIDENCE"),
                  memberRequest.0[0].content.contains("Earlier verified plan") else { throw MeloError.message("team dropped context or override") }
            receipt["team_context_and_override"] = true
            receipt["passed"] = true
        } catch { receipt["error"] = error.localizedDescription }
        try? FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]).write(to: output, options: .atomic)
    }
}
#endif
