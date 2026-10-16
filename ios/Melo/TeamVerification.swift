#if DEBUG && targetEnvironment(simulator)
import Foundation

/// Simulator-only acceptance of phone teams through the real ChatStore send
/// path, with a counting fake model (no account, no network). Also seeds a
/// preview store so the team sheet can be inspected with synced-style Agents.
@MainActor enum TeamVerification {
    final class Calls: @unchecked Sendable { var list: [String] = []; let lock = NSLock(); func add(_ v: String) { lock.lock(); list.append(v); lock.unlock() } }

    static func agents() -> [AgentProfile] {
        var lead = AgentProfile(id: "main", name: "主 Agent", subtitle: "发起与汇总", symbol: "sparkles", instructions: "负责统筹。")
        lead.collaboration = .object(["canDelegate": .bool(true), "delegateTargets": .array([.string("research"), .string("reviewer")]), "maxDelegationDepth": .number(1), "maxIterations": .number(8), "maxTokens": .number(32000), "timeoutMs": .number(180000)])
        let research = AgentProfile(id: "research", name: "调研员", subtitle: "查找资料", symbol: "magnifyingglass", instructions: "查找可靠资料。")
        let reviewer = AgentProfile(id: "reviewer", name: "复核员", subtitle: "检查结论", symbol: "checkmark.seal", instructions: "检查结论是否有依据。")
        return [lead, research, reviewer] + AgentProfile.defaults
    }

    static func store(calls: Calls, root: URL) -> ChatStore {
        ChatStore(directory: root, replyLoader: { messages, system in
            let who = system.components(separatedBy: "\n").first?.replacingOccurrences(of: "当前 Agent 名称：", with: "") ?? "?"
            if system.contains(AgentTeam.summaryInstruction) {
                calls.add("汇总:" + who)
                return ModelReply(text: "团队汇总：调研员找到了资料，复核员确认了结论。")
            }
            calls.add("成员:" + who + (messages.first?.content.contains("前序交接记录") == true ? "+交接" : ""))
            return ModelReply(text: #"{"conclusion":"\#(who) 的结论","evidence":["来源 A"],"changedFiles":[],"unfinished":[]}"#)
        })
    }

    static func previewStore() -> ChatStore {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("team-preview-" + UUID().uuidString)
        let store = store(calls: Calls(), root: root)
        store.updatePreferences { $0.agents = agents() }
        if let chat = store.newChat(agentID: "main") { store.selectedConversationID = chat }
        return store
    }

    static func run() async {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/team-verification.json")
        var result: [String: Any] = ["passed": false]
        let calls = Calls()
        let store = store(calls: calls, root: FileManager.default.temporaryDirectory.appendingPathComponent("team-verify-" + UUID().uuidString))
        store.updatePreferences { $0.agents = agents() }
        func settle() async { for _ in 0..<200 where store.anySending { try? await Task.sleep(nanoseconds: 50_000_000) } }
        do {
            guard let chat = store.newChat(agentID: "main") else { throw MeloError.message("无法创建对话") }
            // An unchosen member is refused before any request or message.
            var refusal = ""
            store.armTeam(PhoneTeamPlan(templateID: "research-build-review", members: ["research", "writer"]), chatID: chat)
            store.send("整理发布说明", chatID: chat, onPreflightFailure: { refusal = $0 })
            guard refusal.contains("writer"), calls.list.isEmpty, store.chats.first(where: { $0.id == chat })?.messages.isEmpty == true else { throw MeloError.message("未授权成员没有被拒绝：\(refusal)") }
            result["refusal"] = refusal
            // Tick order reviewer → research; the lead writes the reply.
            store.armTeam(PhoneTeamPlan(templateID: "research-build-review", members: ["reviewer", "research"]), chatID: chat)
            store.send("整理发布说明", chatID: chat)
            guard store.pendingTeams[chat] == nil else { throw MeloError.message("团队没有在发送后取消") }
            await settle()
            let expected = ["成员:复核员", "成员:调研员+交接", "汇总:主 Agent"]
            guard calls.list == expected else { throw MeloError.message("调用顺序不对：\(calls.list)") }
            guard let reply = store.chats.first(where: { $0.id == chat })?.messages.last, reply.role == "assistant", reply.content.hasPrefix("团队汇总：") else { throw MeloError.message("回复不是主 Agent 汇总") }
            guard store.preferences.messageAgents?[reply.id]?.agentID == "main" else { throw MeloError.message("回复没有归属发起者") }
            let stages = store.execution(for: reply.id)?.pipeline?.map { "\($0.id)=\($0.status)" } ?? []
            for stage in ["team=completed", "team:reviewer:1=completed", "team:research:1=completed", "team:summary=completed"] where !stages.contains(stage) { throw MeloError.message("执行记录缺少 \(stage)：\(stages)") }
            // The next message is a normal reply again.
            store.send("谢谢", chatID: chat); await settle()
            guard calls.list.count == 4, !calls.list[3].hasPrefix("汇总") else { throw MeloError.message("普通消息不应走团队：\(calls.list)") }
            result["calls"] = calls.list; result["stages"] = stages; result["reply"] = reply.content; result["passed"] = true
        } catch { result["error"] = error.localizedDescription }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
    }
}
#endif
