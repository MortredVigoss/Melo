#if DEBUG && targetEnvironment(simulator)
import Foundation

@MainActor enum InteractionVerification {
    static func run() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = support.appendingPathComponent("InteractionVerification-" + UUID().uuidString)
        var result: [String: Any] = ["passed": false]
        do {
            let store = ChatStore(directory: directory)
            let before = store.preferences.agents[0]
            var session = AgentEditSession(agent: before)
            session.begin(current: before); session.draft.name = "已保存角色"
            guard session.save(current: before, persist: { value in store.updatePreferences { $0.agents[0] = value } }) else { throw MeloError.message("save failed") }
            let reloaded = ChatStore(directory: directory)
            guard reloaded.preferences.agents[0].name == "已保存角色" else { throw MeloError.message("role not durable") }
            session.begin(current: session.original); session.draft.name = "不能丢的草稿"
            store.storageReady = false
            guard !session.save(current: session.original, persist: { value in store.updatePreferences { $0.agents[0] = value } }),
                  session.isEditing, session.draft.name == "不能丢的草稿", store.preferences.agents[0].name == "已保存角色" else { throw MeloError.message("failed save lost draft or mutated stored role") }
            store.storageReady = true
            let a = store.newChat()!, b = store.newChat()!
            let ref = ImageReference(id: UUID().uuidString)
            store.composerDrafts[a] = ConversationDraft(text: "第一段草稿", imagePlan: ImageTaskPlan(action: .edit, references: [ref]))
            store.composerDrafts[b] = ConversationDraft(text: "第二段草稿")
            guard store.composerDrafts[a]?.text == "第一段草稿", store.composerDrafts[a]?.imagePlan.references == [ref], store.composerDrafts[b]?.imagePlan.references.isEmpty == true else { throw MeloError.message("drafts leaked between chats") }
            store.flushDrafts()
            let draftsReloaded = ChatStore(directory: directory)
            guard draftsReloaded.composerDrafts[a] == store.composerDrafts[a], draftsReloaded.composerDrafts[b] == store.composerDrafts[b] else { throw MeloError.message("drafts lost on restart") }
            result["draftRestart"] = true
            var preflight: String?
            draftsReloaded.updatePreferences { $0.chatAgents[a] = "missing-agent" }
            draftsReloaded.error = nil
            draftsReloaded.send("do not publish global error", chatID: a, onPreflightFailure: { preflight = $0 })
            guard preflight != nil, draftsReloaded.error == nil, draftsReloaded.sendingID == nil else { throw MeloError.message("preflight escaped to global alert") }
            result["localFailure"] = true
            result["passed"] = true
            result["checks"] = ["role persisted and reloaded", "failed storage preserves draft and saved role", "per-conversation text and image drafts isolated"]
        } catch { result["error"] = error.localizedDescription }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: support.appendingPathComponent("interaction-verification.json")) }
    }
    static func seedReview(_ store: ChatStore) {
        guard let index = store.chats.firstIndex(where: { $0.id == "interaction-qa-b" }), !store.chats[index].messages.contains(where: { $0.id == "qa-image-review" }) else { return }
        do {
            let image = try store.importImage(ImageWorkflowVerification.fixture(true), title: "视觉检查夹具")
            let message = ChatMessage(id: "qa-image-review", role: "assistant", content: "图片检查测试夹具；非模型生成。")
            try store.imageLibrary.bind([image], to: message.id)
            store.chats[index].messages.append(message); try store.save()
        } catch { store.error = error.localizedDescription }
    }
    static func seed(_ store: ChatStore) {
        guard !store.chats.contains(where: { $0.id == "interaction-qa-a" }) else { return }
        let messages = (0..<12).map { ChatMessage(role: $0 % 2 == 0 ? "user" : "assistant", content: "界面验收第 \($0 + 1) 条消息。\n滚动内容应始终留在消息区域，不能穿过透明标题栏。") }
        store.chats = [Conversation(id: "interaction-qa-a", title: "键盘与草稿测试", messages: messages), Conversation(id: "interaction-qa-b", title: "历史切换测试", messages: [ChatMessage(role: "user", content: "这是另一段历史对话")])]
        try? store.save()
        store.updatePreferences { $0.agents.append(AgentProfile(id: "qa-role", name: "测试角色", subtitle: "仅用于本轮隔离验收", symbol: "sparkles", instructions: "保留角色原始内容。")) }
    }
}
#endif
