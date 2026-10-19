import Foundation

@main struct ParityRegressionTests {
    @MainActor static func main() async throws {
        var agent = AgentProfile(id: "main", name: "main", subtitle: "", symbol: "star", instructions: "persona")
        let note = KnowledgeNote(id: "doc", title: "routing", content: String(repeating: "unrelated paragraph. ", count: 1000) + "\nzephyr-route FINAL_TAIL_ANSWER", updatedAt: timestamp())
        let project = PersonalProject(id: "p", name: "PRIVATE_PROJECT", goal: "PRIVATE_GOAL", instructions: "PRIVATE_INSTRUCTION", knowledgeIds: [note.id])
        let resolved = ConversationContext.resolve(agent: agent, project: project, notes: [note], query: "zephyr-route")
        assert(resolved.knowledge.contains("FINAL_TAIL_ANSWER"), "A5: tail is relevant, not only the prefix")
        assert(resolved.knowledge.contains("doc:") && resolved.knowledgeChunks <= 8)
        var edited = note; edited.content = "zephyr-route UPDATED_ANSWER"
        let changed = ConversationContext.resolve(agent: agent, project: project, notes: [edited], query: "zephyr-route")
        assert(changed.knowledge.contains("UPDATED_ANSWER") && !changed.knowledge.contains("FINAL_TAIL_ANSWER"), "revision cache must invalidate")
        var result = note; result.kind = "result"
        assert(MobileKnowledge.search([result], query: "zephyr").isEmpty)
        agent.contextSources = .object(["projects": .bool(false), "knowledge": .bool(false)])
        let excluded = ConversationContext.resolve(agent: agent, project: project, notes: [note], query: "zephyr-route")
        assert(!excluded.instructions.contains("PRIVATE") && !excluded.instructions.contains("FINAL_TAIL") && excluded.evidence.isEmpty, "A3: same filtered blocks feed main/verification/members")
        var preferences = MobilePreferences(); preferences.agents = [agent]
        preferences.projects = [project]; preferences.chatProjects = ["c": "p"]
        preferences.knowledge = (0..<15).map { KnowledgeNote(id: "n\($0)", title: "N", content: "body", updatedAt: timestamp()) }
        preferences.chatKnowledge = ["c": Set(preferences.knowledge!.map(\.id))]
        try ConversationContext.validate(preferences: preferences, chatID: "c")

        // A4: model budget, no 60-message cut, append-only card ranges and recovery.
        try ConversationHistory.validateCurrentInput("hi", budget: PhoneContextBudget(capacity: 4096))
        assert(RequestSizeEstimate.tokens(Data(String(repeating: "汉", count: 200).utf8)) >= 200, "member estimates must budget CJK too")
        let short = (0..<81).map { ChatMessage(id: "s\($0)", role: $0.isMultiple(of: 2) ? "user" : "assistant", content: "small turn") }
        assert(PhoneContextBudget().recent(short).count == 81)
        let history = (0..<81).map { ChatMessage(id: "m\($0)", role: $0.isMultiple(of: 2) ? "user" : "assistant", content: "decision-\($0) " + String(repeating: "汉", count: 500)) }
        let budget = PhoneContextBudget(capacity: 12000)
        let plan = PhoneCompact.plan(messages: history, existing: nil, budget: budget, instructions: "persona")
        assert(plan.value != nil && !plan.pending.isEmpty)
        let context = ConversationHistory.compactContext(plan.value, messages: history)
        assert(context.messages.count < history.count && context.summary.contains("消息 #"))
        assert(history[0].content.contains("decision-0"), "original stays untouched")
        try SyncWireContract.validate(plan.value!, definition: "compact")
        let first = plan.pending[0]
        let upgraded = PhoneCompact.upgraded(plan.value!, cardID: first.id, summary: "verified earlier decision")
        assert(upgraded["cards"].array.first?["summary"].string == "verified earlier decision")
        let retry = PhoneCompact.plan(messages: history, existing: plan.value, budget: budget, instructions: "persona")
        assert(retry.pending.contains { $0.id == first.id }, "failed model summary is retryable")
        let exhausted = PhoneCompact.plan(messages: history, existing: plan.value, budget: budget, instructions: "persona", attempts: Dictionary(uniqueKeysWithValues: plan.pending.map { ($0.id,3) }))
        assert(!exhausted.pending.contains { $0.id == first.id }, "persisted retry fuse")
        let original = PhoneReadHistory.run(arguments: #"{"fromMessageId":"m0","limit":1}"#, chatID: "c", title: "long", messages: history)
        assert(original.contains("decision-0"))

        // A6: member priority/overrides/limits and background survive explicit chat model selection.
        var member = agent; member.id = "builder"; member.model = "member-model"; member.instructions = "global"
        member.collaboration = .object(["maxIterations": .number(3), "maxTokens": .number(1900), "timeoutMs": .number(5000)])
        member.contextSources = .object(["knowledge": .bool(false)])
        var override = member; override.instructions = "project override"; override.contextSources = nil; override.collaboration = nil
        preferences.agents.append(member); preferences.projectAgents = ["p": ["builder": override]]
        let effective = AgentTeam.effectiveAgents(preferences, projectID: "p").first { $0.id == "builder" }!
        assert(effective.instructions == "project override" && effective.contextSources?["knowledge"].bool == false)
        assert(AgentTeam.model(effective, fallback: "explicit-chat-model") == "member-model")
        assert(AgentTeam.limits(effective).iterations == 3 && AgentTeam.limits(effective).tokens == 1900 && AgentTeam.limits(effective).timeoutMs == 5000)
        assert(AgentTeam.background(messages: history, compact: "earlier plan").contains("earlier plan"))
        do { _ = try PhoneMemberLimits.outputAllowance(body: ["messages": String(repeating: "x", count: 8000)], remaining: 20); assertionFailure("oversized member request") } catch {}

        // Writer lanes stay exclusive and cancellation removes queued work.
        var events: [String] = []
        let firstWriter = Task { @MainActor in
            try await PhoneMemberWriters.run(enabled: true) {
                events.append("first-start")
                try await Task.sleep(nanoseconds: 40_000_000)
                events.append("first-end"); return "first"
            }
        }
        while events.isEmpty { await Task.yield() }
        let cancelledWriter = Task { @MainActor in
            try await PhoneMemberWriters.run(enabled: true) { events.append("cancelled-wrote"); return "bad" }
        }
        await Task.yield(); cancelledWriter.cancel()
        let nextWriter = Task { @MainActor in
            try await PhoneMemberWriters.run(enabled: true) { events.append("next"); return "next" }
        }
        _ = try await firstWriter.value
        do { _ = try await cancelledWriter.value; assertionFailure("queued writer ran") } catch {}
        _ = try await nextWriter.value
        assert(events == ["first-start", "first-end", "next"])

        // A7: a project source is valid without a chat; v1 cannot accidentally carry it.
        var fact = MobileMemoryFact(id: MobileMemoryFact.identifier("book-user-p"), memoryID: "book-user-p", text: "Keep compatibility", originalFact: "Keep compatibility", scope: "project", chatId: "", messageId: "", projectId: "p", agentId: "main", sourceText: "project page", category: "project_context", updatedAt: timestamp(), userEdited: true, section: "convention", bookStatus: "user", origin: "project")
        _ = try fact.validated()
        assert(fact.eligible(chat: "c", project: "p", agent: "main", liveChats: [], liveProjects: ["p"]))
        assert(!fact.eligible(chat: "c", project: "other", agent: "main", liveChats: [], liveProjects: ["p"]))
        assert(!fact.eligible(chat: "c", project: "p", agent: "main", liveChats: [], liveProjects: []))
        preferences.memoryFacts = [fact]
        let exported = try ProjectMemoryProjection.refreshed(preferences, device: "phone")
        assert(exported.records.count == 1)
        var receiver = MobilePreferences(); receiver.projects = [project]
        try ProjectMemoryProjection.apply(exported, preferences: &receiver)
        assert(receiver.memoryFacts == [fact])
        let encoded = try JSONEncoder().encode(receiver)
        receiver = try JSONDecoder().decode(MobilePreferences.self, from: encoded)
        let roundTrip = try ProjectMemoryProjection.refreshed(receiver, device: "phone")
        assert(roundTrip.records == exported.records)
        let v1 = try WorkspaceProjection.refreshed(receiver, chats: [], records: [], connections: [], device: "phone")
        assert(!v1.records.contains { $0.kind == "memory" })
        fact.scope = "chat"
        do { _ = try fact.validated(); assertionFailure("project origin cannot fabricate chat scope") } catch {}
        print("Parity regressions passed: filtered context, tail retrieval/cache, many documents, model budget/cards/recovery, member configuration, project-source sync and preservation")
    }
}
