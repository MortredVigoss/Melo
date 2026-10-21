#if DEBUG && targetEnvironment(simulator)
import Foundation

/// Explicit fixture-only acceptance; isolated storage and no model request.
@MainActor enum ConversationVerification {
    static func run() async {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let root = support.appendingPathComponent("ConversationVerification-" + UUID().uuidString)
        var result: [String: Any] = ["passed": false]
        do {
            var requests = 0
            let store = ChatStore(directory: root.appendingPathComponent("preflight"), replyLoader: { _, _ in requests += 1; return ModelReply(text: "fixture", sources: [], searched: false) })
            guard let chatID = store.newChat() else { throw MeloError.message("create failed") }
            store.updatePreferences { $0.chatAgents[chatID] = "missing-role" }
            store.send("must remain draft", chatID: chatID)
            guard store.chats.first?.messages.isEmpty == true, requests == 0 else { throw MeloError.message("missing role appended a message") }
            store.updatePreferences { $0.chatAgents[chatID] = $0.agents[0].id }
            store.selectModel(.init(connectionID: "missing-api", model: "fixture", baseURL: "https://unconfigured.invalid/v1"), chatID: chatID)
            store.send("must remain draft", chatID: chatID)
            guard store.chats.first?.messages.isEmpty == true, requests == 0 else { throw MeloError.message("missing connection appended a message") }
            store.selectModel(nil, chatID: chatID)
            // Larger than the model budget itself (the budget is per model since the 2026-10-17 context work;
            // the old fixed 48 KB threshold now fits and no longer tests the guard).
            store.send(String(repeating: "中", count: PhoneContextBudget().input + 1), chatID: chatID)
            guard store.chats.first?.messages.isEmpty == true, requests == 0 else { throw MeloError.message("oversized context appended a message") }
            result["preflight"] = "missing role, missing connection and oversized context leave zero messages and zero requests"
            var prompts: [String] = [], turns: [String] = []
            let actualRoot = root.appendingPathComponent("request-context")
            let actual = ChatStore(directory: actualRoot, replyLoader: { messages, instructions in
                prompts.append(instructions); turns.append(messages.last?.content ?? "")
                return ModelReply(text: "fixture response", sources: [], searched: false)
            })
            var custom = AgentProfile(id: "custom", name: "自定义Agent", subtitle: "", symbol: "star", instructions: "CUSTOM_ROLE_REQUEST")
            custom.identity = "IDENTITY_REQUEST"; custom.soul = "SOUL_REQUEST"; custom.mood = "MOOD_REQUEST"
            actual.updatePreferences { $0.agents.append(custom) }
            let customChat = actual.newChat(agentID: custom.id)!
            func finish() async throws {
                for _ in 0..<400 where actual.anySending { try await Task.sleep(for: .milliseconds(25)) }
                guard !actual.anySending, actual.chats.first(where: { $0.id == customChat })?.messages.last?.role == "assistant" else { throw MeloError.message("fixture reply did not finish") }
            }
            actual.send("我不喜欢咖啡", chatID: customChat); try await finish()
            guard prompts.last?.contains("CUSTOM_ROLE_REQUEST") == true, prompts.last?.contains("MOOD_REQUEST") == false else { throw MeloError.message("selected role missing from the instructions") }
            guard let fact = actual.preferences.memoryFacts?.first(where: { $0.text == "User dislikes 咖啡" }) else { throw MeloError.message("preference was not extracted: \(actual.preferences.memoryFacts?.map(\.text) ?? [])") }
            // The fact is extracted from this message, so it is recalled from the next turn on.
            actual.send("推荐一杯饮料", chatID: customChat); try await finish()
            guard turns.last?.contains(fact.text) == true, prompts.last?.contains(fact.text) == false else { throw MeloError.message("per-question memory must ride on the newest message, not the instructions (turn: \(turns.last?.contains(fact.text) == true), instructions: \(prompts.last?.contains(fact.text) == true))") }
            actual.updatePreferences { p in p.memoryFacts = p.memoryFacts?.map { var f = $0; f.status = "forgotten"; f.userEdited = true; return f } }
            actual.selectAgent("melo", chatID: customChat)
            actual.send("我不喜欢咖啡", chatID: customChat); try await finish()
            guard prompts.last?.contains("CUSTOM_ROLE_REQUEST") == false, turns.last?.contains("User dislikes 咖啡") == false,
                  actual.preferences.memoryFacts?.first?.status == "forgotten" else { throw MeloError.message("old conversation role switch or forgotten memory resurrection") }
            let otherChat = actual.newChat(agentID: custom.id)!
            actual.updatePreferences { p in p.memoryFacts = p.memoryFacts?.map { var f = $0; f.status = "active"; return f } }
            actual.send("你好", chatID: customChat); try await finish()
            guard turns.last?.contains("User dislikes 咖啡") == false,
                  actual.preferences.memoryUsage?[actual.chats.first(where: { $0.id == customChat })!.messages.last!.id]?.isEmpty == true else { throw MeloError.message("greeting retrieved memory or recorded an unused fact") }
            actual.send("好", chatID: customChat); try await finish()
            guard turns.last?.contains("User dislikes 咖啡") == true else { throw MeloError.message("task continuation lost memory") }
            actual.updatePreferences { p in p.memoryFacts = p.memoryFacts?.map { var f = $0; f.mergedInto = "promoted:winner"; return f } }
            actual.send("推荐饮料", chatID: customChat); try await finish()
            guard turns.last?.contains("User dislikes 咖啡") == false else { throw MeloError.message("merged memory was recalled") }
            actual.updatePreferences { p in p.memoryFacts = p.memoryFacts?.map { var f = $0; f.mergedInto = nil; return f } }
            actual.send("推荐饮料", chatID: otherChat); try await finish()
            guard prompts.last?.contains("CUSTOM_ROLE_REQUEST") == true, turns.last?.contains("User dislikes 咖啡") == false else { throw MeloError.message("private memory crossed conversation boundary") }
            let reload = ChatStore(directory: actualRoot)
            guard reload.preferences.agents.first(where: { $0.id == custom.id }) == custom,
                  reload.agent(for: customChat).id == "melo", reload.agent(for: otherChat).id == custom.id else { throw MeloError.message("role selection or advanced fields lost on restart") }
            let note = KnowledgeNote(id: "large", title: "Large", content: String(repeating: "x", count: 24001))
            actual.updatePreferences { $0.knowledge = [note]; $0.chatKnowledge = [customChat: ["large"]] }
            actual.send("阅读选用资料", chatID: customChat); try await finish()
            guard let excerpt = turns.last, excerpt.contains("资料：Large"), !excerpt.contains(note.content), prompts.last?.contains("资料：Large") == false,
                  actual.preferences.knowledge?.first?.content == note.content else { throw MeloError.message("long knowledge was not excerpted or its original changed") }
            result["knowledgeBudget"] = "long knowledge is excerpted at transport; full original remains stored"
            result["requestContext"] = "actual send transport observes selected role, advanced fields, scoped memory; forgotten extraction stays forgotten; restart preserves selections"
            result["recallAlignment"] = "greeting has no injected memory or usage receipt; task continuation keeps memory; merged facts are excluded"
            let journalRoot = root.appendingPathComponent("recovery")
            try FileManager.default.createDirectory(at: journalRoot, withIntermediateDirectories: true)
            let preferences = MobilePreferences(), snapshot = SyncSnapshot(chats: store.chats)
            let decode: (Data) throws -> Any = { try JSONSerialization.jsonObject(with: $0) }
            let journal: [String: Any] = ["snapshot":try decode(JSONEncoder().encode(snapshot)), "preferences":try decode(JSONEncoder().encode(preferences)), "records":[]]
            try BackgroundReplyStorage.write(JSONSerialization.data(withJSONObject: journal), to: journalRoot.appendingPathComponent("pending-sync.json"))
            let recovered = ChatStore(directory: journalRoot)
            guard recovered.storageReady, recovered.chats.first?.id == chatID, !FileManager.default.fileExists(atPath: journalRoot.appendingPathComponent("pending-sync.json").path) else { throw MeloError.message("sync journal recovery failed") }
            result["recovery"] = "pending sync journal restored chats, preferences and execution records together"
            result["passed"] = true
        } catch { result["error"] = error.localizedDescription }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? BackgroundReplyStorage.write(data, to: support.appendingPathComponent("conversation-verification.json")) }
    }
}
#endif
