#if DEBUG && targetEnvironment(simulator)
import Foundation

/// Simulator-only acceptance: two conversations reply at the same time through
/// the real ChatStore send path, and stopping one leaves the other running.
/// Fake model with counters; no account or network.
@MainActor enum ConcurrencyVerification {
    final class Log: @unchecked Sendable {
        var events: [String] = []; let lock = NSLock()
        func add(_ value: String) { lock.lock(); events.append(value); lock.unlock() }
        var snapshot: [String] { lock.lock(); defer { lock.unlock() }; return events }
    }
    static func run() async {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/concurrency-verification.json")
        var result: [String: Any] = ["passed": false]
        let log = Log()
        let store = ChatStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("concurrency-verify-" + UUID().uuidString), replyLoader: { messages, _ in
            // The question itself, without the per-turn note the transport appends after it.
            let question = (messages.last?.content ?? "").components(separatedBy: "\n\n[本轮参考").first ?? ""
            log.add("start:" + question)
            try await Task.sleep(nanoseconds: question.contains("慢") ? 1_500_000_000 : 500_000_000)
            log.add("end:" + question)
            return ModelReply(text: "回复：" + question)
        })
        func settle() async { for _ in 0..<200 where store.anySending { try? await Task.sleep(nanoseconds: 25_000_000) } }
        // The main thread keeps ticking while both replies run.
        var longestGap: TimeInterval = 0
        let ticker = Task { @MainActor in
            var last = Date()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 16_000_000)
                longestGap = max(longestGap, Date().timeIntervalSince(last)); last = Date()
            }
        }
        do {
            guard let a = store.newChat(agentID: "melo"), let b = store.newChat(agentID: "writer") else { throw MeloError.message("无法创建对话") }
            store.send("A 慢任务", chatID: a)
            store.send("B 任务", chatID: b)
            guard store.isSending(a), store.isSending(b) else { throw MeloError.message("第二个对话没有同时开始：\(store.sendingChats)") }
            await settle()
            let events = log.snapshot
            guard let endA = events.firstIndex(of: "end:A 慢任务"), let startB = events.firstIndex(of: "start:B 任务"), startB < endA else { throw MeloError.message("两个回复没有并行：\(events)") }
            for (chat, text) in [(a, "回复：A 慢任务"), (b, "回复：B 任务")] {
                guard store.chats.first(where: { $0.id == chat })?.messages.last?.content == text else { throw MeloError.message("回复缺失或串到其他对话") }
            }
            // Stopping one conversation leaves the other running to completion.
            store.send("A 慢任务二", chatID: a)
            store.send("B 任务二", chatID: b)
            try await Task.sleep(nanoseconds: 200_000_000)
            store.cancel(chatID: a)
            await settle()
            guard store.chats.first(where: { $0.id == a })?.messages.last?.role == "user",
                  store.scenes(for: a).last?.status == "cancelled" else { throw MeloError.message("停止 A 没有生效") }
            guard store.chats.first(where: { $0.id == b })?.messages.last?.content == "回复：B 任务二" else { throw MeloError.message("停止 A 影响了 B") }
            // Changing Agent and model during a reply: allowed; this reply keeps its starting Agent.
            store.send("A 慢任务三", chatID: a)
            try await Task.sleep(nanoseconds: 200_000_000)
            store.selectAgent("analyst", chatID: a)
            store.selectModel(ConversationModel(connectionID: "chatgpt", model: "next-model"), chatID: a)
            guard store.agent(for: a).id == "analyst", store.preferences.chatModels?[a]?.model == "next-model" else { throw MeloError.message("回复中无法切换 Agent 或模型") }
            await settle()
            guard let third = store.chats.first(where: { $0.id == a })?.messages.last, store.preferences.messageAgents?[third.id]?.agentID == "melo" else { throw MeloError.message("正在进行的回复不应改署名") }
            // A supplement typed during a reply joins its next model step without a restart (desktop parity);
            // this fake model takes no further step, so the supplement is sent as the next message when the reply ends.
            let before = log.snapshot.filter { $0.hasPrefix("start:") }.count
            let answersBefore = store.chats.first(where: { $0.id == b })?.messages.filter { $0.role == "assistant" }.count ?? 0
            store.send("B 慢任务写一首诗", chatID: b)
            try await Task.sleep(nanoseconds: 300_000_000)
            store.supplement("改成五言", chatID: b)
            guard store.isSending(b), store.pendingSupplements[b] == ["改成五言"] else { throw MeloError.message("补充没有送达正在进行的回复，或回复被重新开始") }
            await settle()
            let messagesB = store.chats.first(where: { $0.id == b })?.messages ?? []
            guard messagesB.suffix(4).map(\.content) == ["B 慢任务写一首诗", "回复：B 慢任务写一首诗", "改成五言", "回复：改成五言"] else { throw MeloError.message("未用上的补充应在回复结束后作为下一条消息发送：\(messagesB.suffix(4).map(\.content))") }
            guard messagesB.filter({ $0.role == "assistant" }).count == answersBefore + 2, log.snapshot.filter({ $0.hasPrefix("start:") }).count == before + 2 else { throw MeloError.message("补充不应重启原回复") }
            guard store.scenes(for: b).dropLast().last?.status == "completed" else { throw MeloError.message("原回复应完整结束，不被补充打断") }
            ticker.cancel()
            result["events"] = log.snapshot
            result["longestMainThreadGapMs"] = Int(longestGap * 1000)
            result["passed"] = true
        } catch { ticker.cancel(); result["error"] = error.localizedDescription; result["events"] = log.snapshot }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
    }
}
#endif
