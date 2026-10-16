#if DEBUG && targetEnvironment(simulator)
import UIKit
import AVFoundation

// Disposable simulator data and injected transports; no real accounts or chats.
@MainActor enum SyncAuditVerification {
    static var running = false
    static func run() async {
        guard !running else { return }; running = true
        let parent = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let root = parent.appendingPathComponent("SyncAudit-" + UUID().uuidString)
        var result: [String: Any] = ["passed": false]
        func check(_ condition: Bool, _ message: String) throws {
            if !condition { throw MeloError.message(message) }
        }
        func waitFor(_ condition: () -> Bool) async throws {
            for _ in 0..<150 { if condition() { return }; try await Task.sleep(for: .milliseconds(20)) }
            throw MeloError.message("Timed out waiting for fixture state")
        }
        do {
            var syncCalls = 0, sentMessageCounts: [Int] = []
            let gate = AuditGate()
            let store = ChatStore(directory: root.appendingPathComponent("slow"), replyLoader: { _, _ in
                try await Task.sleep(for: .milliseconds(20))
                return ModelReply(text: "完整回答", sources: [])
            }, syncLoader: { payload in
                syncCalls += 1
                let snapshot = try JSONDecoder().decode(SyncSnapshot.self, from: payload)
                sentMessageCounts.append(snapshot.chats.reduce(0) { $0 + $1.messages.count })
                if syncCalls == 1 { await gate.wait() }
                try Task.checkCancellation()
                return payload
            })
            let id = store.newChat()!
            store.send("第一条", chatID: id)
            try await waitFor { syncCalls == 1 && !store.anySending }
            try check(store.syncing, "Slow sync fixture did not stay pending")
            store.send("第二条", chatID: id)
            try await waitFor { store.chats.first?.messages.count == 4 && !store.anySending }
            try check(syncCalls == 1, "Automatic sync overlapped")
            store.cancel() // must not cancel a finished reply's separate sync
            gate.release()
            try await waitFor { syncCalls == 2 && !store.syncing }
            try check(sentMessageCounts == [2,4] && store.error == nil, "Coalesced sync lost second reply or cancellation escaped")
            result["slowSync"] = "passed: second send, cancellation isolation, coalesced resync"

            // Delete while an older upload is in flight, then receive that old
            // snapshot. The durable tombstone must still win after a cold reload.
            let deletionGate = AuditGate()
            var deletionCalls = 0
            let deleting = ChatStore(directory: root.appendingPathComponent("deletion"), syncLoader: { payload in
                deletionCalls += 1
                if deletionCalls == 1 { await deletionGate.wait() }
                return payload
            })
            let doomed = deleting.newChat()!
            let manual = Task { await deleting.sync() }
            try await waitFor { deletionCalls == 1 }
            try check(deleting.deleteConversation(doomed), "Local deletion failed")
            deletionGate.release(); await manual.value
            try await waitFor { deletionCalls == 2 && !deleting.syncing }
            let restored = ChatStore(directory: root.appendingPathComponent("deletion"))
            try check(restored.chats.isEmpty && restored.deletedChats.contains { $0.id == doomed }, "Deletion resurrected on sync/reload")
            let stale = PortableArchive(snapshot: .init(chats: [.init(id: doomed)]))
            try restored.importLocalArchive(stale)
            try check(restored.chats.isEmpty, "Archive import resurrected deleted chat")
            result["deletion"] = "passed: in-flight stale response, follow-up sync, reload, archive import"

            // Exercise production deletion, asset sharing and recovery after the
            // journal is durable but execution-record persistence fails.
            let cleanupRoot = root.appendingPathComponent("asset-cleanup")
            let cleanup = ChatStore(directory: cleanupRoot, replyLoader: { _, _ in ModelReply(text: "完成", sources: []) }, syncLoader: { $0 })
            let sourceID = cleanup.newChat()!, keptID = cleanup.newChat()!
            cleanup.send("我喜欢茶", chatID: sourceID)
            try await waitFor { !cleanup.anySending && !cleanup.scenes(for: sourceID).isEmpty && !cleanup.syncing }
            let sourceMessage = cleanup.chats.first { $0.id == sourceID }!.messages.last!.id
            cleanup.send("保留这段", chatID: keptID)
            try await waitFor { !cleanup.anySending && !cleanup.scenes(for: keptID).isEmpty && !cleanup.syncing }
            let keptMessage = cleanup.chats.first { $0.id == keptID }!.messages.last!.id
            let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { c in UIColor.purple.setFill(); c.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
            let exclusive = try cleanup.importImage(png), shared = try cleanup.importImage(png)
            try cleanup.imageLibrary.bind([exclusive, shared], to: sourceMessage)
            try cleanup.imageLibrary.bind([shared], to: keptMessage)
            let actualScene = cleanupRoot.appendingPathComponent("execution-records.json")
            try FileManager.default.removeItem(at: actualScene)
            try FileManager.default.createDirectory(at: actualScene, withIntermediateDirectories: false)
            try check(!cleanup.deleteConversation(sourceID), "Injected persistence failure was ignored")
            try check(FileManager.default.fileExists(atPath: cleanupRoot.appendingPathComponent("pending-sync.json").path), "Recovery journal missing after partial commit")
            try check(cleanup.imageLibrary.images(for: sourceMessage).count == 2, "Assets removed before record commit")
            try FileManager.default.removeItem(at: actualScene)
            let recovered = ChatStore(directory: cleanupRoot)
            try check(recovered.chats.allSatisfy { $0.id != sourceID } && recovered.scenes(for: sourceID).isEmpty, "Recovery retained deleted chat or scene")
            try check(!recovered.scenes(for: keptID).isEmpty && recovered.imageLibrary.images(for: keptMessage) == [shared], "Recovery damaged other chat")
            try check(recovered.imageLibrary.index.assets[exclusive.id] == nil && !FileManager.default.fileExists(atPath: try recovered.imageLibrary.url(exclusive).path), "Deleted exclusive image remained")
            try check(!(try recovered.imageLibrary.data(shared)).isEmpty, "Shared image file was deleted")
            result["deletionCleanup"] = "passed: real send/scene, shared images, partial write failure, restart journal replay"

            let failing = ChatStore(directory: root.appendingPathComponent("failed-sync"), replyLoader: { _, _ in ModelReply(text: "回答", sources: []) }, syncLoader: { _ in throw URLError(.timedOut) })
            let failingID = failing.newChat()!
            failing.send("问题", chatID: failingID)
            try await waitFor { failing.syncStatus.contains("同步未完成") }
            try check(!failing.anySending && failing.error == nil && failing.chats.first?.messages.count == 2, "Auto-sync error contaminated completed reply")
            await failing.sync()
            try check(failing.error != nil, "Manual sync hid its error")
            result["syncErrors"] = "passed: automatic status only, manual error retained"

            let bounded = ChatStore(directory: root.appendingPathComponent("budget"), replyLoader: { _, _ in throw MeloError.message("Unexpected transport call") })
            let boundedID = bounded.newChat()!
            bounded.send(String(repeating: "汉", count: 20000), chatID: boundedID)
            try check(!bounded.anySending && bounded.chats.first?.messages.isEmpty == true && bounded.error?.contains("太长") == true, "Oversized draft was sent or persisted as a failed turn")
            result["inputBudget"] = "passed: preflight before network/persistence"

            for (kind, expected) in [(AVAudioSession.InterruptionType.began, true), (.ended, false)] {
                let event = Notification(name: AVAudioSession.interruptionNotification, userInfo: [AVAudioSessionInterruptionTypeKey: kind.rawValue])
                try check(SystemSpeechInput.interruptionBegan(event) == expected, "Wrong audio interruption phase")
            }
            try check(!SystemSpeechInput.interruptionBegan(Notification(name: AVAudioSession.interruptionNotification)), "Missing phase treated as began")
            result["audioInterruption"] = "passed: began only; ended and missing ignored"
            result["passed"] = true
        } catch { result["error"] = error.localizedDescription }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys,.prettyPrinted]) {
            try? data.write(to: parent.appendingPathComponent("sync-audit-verification.json"), options: .atomic)
        }
    }
}
@MainActor private final class AuditGate {
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { continuation = $0 } }
    func release() { continuation?.resume(); continuation = nil }
}
#endif
