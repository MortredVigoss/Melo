#if DEBUG && targetEnvironment(simulator)
import UIKit

/// Explicit simulator-only acceptance entry. Never touches device accounts or
/// real chat storage; exercises ChatStore with a cancellable fixture transport.
@MainActor enum ReplyBackgroundVerification {
    static var running = false
    static func run() async {
        guard !running else { return }; running = true
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("BackgroundVerification-" + UUID().uuidString)
        let report = root.deletingLastPathComponent().appendingPathComponent("background-verification.json")
        var result: [String: Any] = ["passed": false, "directory": root.path]
        func save() { if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) { try? BackgroundReplyStorage.write(data, to: report) } }
        do {
            let scheduler = VerificationScheduler()
            var requests = 0, effects = 0, cancellations = 0
            let directory = root.appendingPathComponent("expiry")
            let store = ChatStore(directory: directory, background: ReplyBackgroundLifetime(scheduler: scheduler), replyLoader: { _, _ in
                requests += 1
                do { try await Task.sleep(for: .milliseconds(120)) }
                catch { cancellations += 1; throw error }
                effects += 1
                return ModelReply(text: "完整回答", sources: [], searched: false)
            })
            let chatID = store.newChat()!
            store.send("后台测试", chatID: chatID)
            try await waitUntil { requests == 1 }
            scheduler.expiration?()
            try await waitUntil { store.sendingID == nil }
            guard requests == 1, effects == 0, cancellations == 1, store.sendingID == nil,
                  store.scenes(for: chatID).last?.status == "interrupted", store.chats.first?.messages.count == 1,
                  store.interruptionNotice(for: chatID) != nil else { throw VerificationError.failed("expiry or cancellation") }
            let reloaded = ChatStore(directory: directory, background: ReplyBackgroundLifetime(scheduler: VerificationScheduler()))
            guard reloaded.chats.first?.messages.count == 1, reloaded.interruptionNotice(for: chatID) != nil else { throw VerificationError.failed("restart recovery") }
            store.send("", chatID: chatID, retry: true)
            try await waitUntil { store.sendingID == nil }
            guard requests == 2, effects == 1, store.chats.first?.messages.count == 2, store.scenes(for: chatID).last?.status == "completed" else { throw VerificationError.failed("retry duplicated question or lost reply") }
            store.send("手动停止", chatID: chatID)
            try await waitUntil { requests == 3 }; store.cancel()
            try await waitUntil { store.sendingID == nil }
            guard cancellations == 2, effects == 1, store.scenes(for: chatID).last?.status == "cancelled" else { throw VerificationError.failed("manual cancel") }
            // Existing records retain bytes while their file protection migrates.
            let legacy = root.appendingPathComponent("legacy.json"), bytes = Data("{\"keep\":true}".utf8)
            try bytes.write(to: legacy, options: [.atomic, .completeFileProtection])
            try BackgroundReplyStorage.prepare([legacy])
            guard try Data(contentsOf: legacy) == bytes else { throw VerificationError.failed("storage migration changed data") }
            let protection = try FileManager.default.attributesOfItem(atPath: legacy.path)[.protectionKey] as? FileProtectionType
            if let protection, protection != .completeUntilFirstUserAuthentication { throw VerificationError.failed("lock-screen file protection") }
            result["lockScreenProtection"] = protection == nil ? "Simulator does not expose protection attributes; real-device lock test pending" : "completeUntilFirstUserAuthentication"
            result["storeRegression"] = "passed: expiry/reload/retry/manual cancel/storage migration bytes preserved"
            result["requests"] = requests; result["completedEffects"] = effects; result["cancelledRequests"] = cancellations

            // A real iOS allowance, with a delayed transport. Switch to Settings
            // after the ready marker to test suspension without a debugger.
            var sawBackground = false
            var completedWhileBackground = false
            let realDirectory = root.appendingPathComponent("real-allowance")
            let real = ChatStore(directory: realDirectory, replyLoader: { _, _ in
                try await Task.sleep(for: .seconds(12))
                completedWhileBackground = UIApplication.shared.applicationState == .background
                return ModelReply(text: "后台完整回答", sources: [], searched: false)
            })
            let observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { sawBackground = true; real.enteredBackground() }
            }
            defer { NotificationCenter.default.removeObserver(observer) }
            let realChatID = real.newChat()!
            real.send("切换应用仍继续", chatID: realChatID)
            try await Task.sleep(for: .milliseconds(150))
            result["backgroundProtection"] = real.replyBackgroundStatus
            result["phase"] = "ready-to-background"; save()
            try await Task.sleep(for: .seconds(15))
            let snapshot = try JSONDecoder().decode(SyncSnapshot.self, from: Data(contentsOf: realDirectory.appendingPathComponent("conversations.json")))
            guard sawBackground, completedWhileBackground, snapshot.chats.first?.messages.last?.content == "后台完整回答",
                  snapshot.chats.first?.messages.count == 2, real.scenes(for: realChatID).last?.status == "completed" else { throw VerificationError.failed("real background allowance completion") }
            result["phase"] = "complete"; result["sawBackground"] = sawBackground
            result["completedWhileBackground"] = completedWhileBackground
            result["replyPersisted"] = true; result["passed"] = true
        } catch { result["failure"] = error.localizedDescription }
        save()
    }
    // Wait for observable completion, not a timer that races the renderer/main actor.
    private static func waitUntil(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !predicate() {
            guard ContinuousClock.now < deadline else { throw VerificationError.failed("fixture state timed out") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
    enum VerificationError: LocalizedError {
        case failed(String)
        var errorDescription: String? { if case let .failed(message) = self { return message }; return nil }
    }
}
@MainActor private final class VerificationScheduler: ReplyBackgroundScheduling {
    var expiration: (() -> Void)?
    func beginShort(expiration: @escaping () -> Void) -> Int? { self.expiration = expiration; return 1 }
    func endShort(_ id: Int) { expiration = nil }
    func requestContinued(id: String, launch: @escaping (ReplyBackgroundLease) -> Void) -> Bool { false }
    func cancelPending(id: String) {}
}
#endif
