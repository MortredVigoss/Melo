import Foundation
@main struct LifecycleJournalTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("events.json"), journal = LifecycleJournal(file: root.appendingPathComponent("events.json"))
        journal.record("launch", requestActive: false)
        let firstSession = journal.session
        for _ in 0..<100 { journal.record("active", requestActive: true) }
        assert(journal.events.count == 80)
        journal.record("untrusted arbitrary error / token", requestActive: true)
        assert(!journal.events.contains { $0.kind.contains("token") })
        let reload = LifecycleJournal(file: file)
        assert(reload.events.count == 80 && reload.events.last?.session == firstSession && reload.session != firstSession)
        reload.record("launch", requestActive: false)
        assert(reload.events.last?.session == reload.session && reload.events.count == 80)
        let broken = root.appendingPathComponent("file-as-directory")
        try Data().write(to: broken)
        let failure = LifecycleJournal(file: broken.appendingPathComponent("events.json"))
        failure.record("launch", requestActive: false)
        assert(failure.error != nil && failure.events.isEmpty)
        print("Lifecycle journal passed: bounded, persistent, separate sessions, enum events, safe write failure")
    }
}
