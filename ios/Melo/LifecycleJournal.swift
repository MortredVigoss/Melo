import Foundation

struct LifecycleEvent: Codable, Identifiable {
    var id = UUID().uuidString
    var time = timestamp()
    var session: String
    var kind: String
    var requestActive: Bool
}
/// Local bounded breadcrumbs, not a crash detector. No prompts, URLs or account data.
final class LifecycleJournal {
    let file: URL
    let session = UUID().uuidString
    private(set) var events: [LifecycleEvent] = []
    private(set) var error: String?
    init(file: URL) {
        self.file = file
        if let bytes = try? Data(contentsOf: file), bytes.count < 128 * 1024,
           let saved = try? JSONDecoder().decode([LifecycleEvent].self, from: bytes) { events = Array(saved.suffix(80)) }
    }
    func record(_ kind: String, requestActive: Bool) {
        guard ["launch", "active", "inactive", "background", "termination-callback", "request-start", "request-end", "memory-warning"].contains(kind) else { return }
        var next = events; next.append(LifecycleEvent(session: session, kind: kind, requestActive: requestActive)); next = Array(next.suffix(80))
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(next)
            #if os(iOS)
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: file, options: .atomic)
            #endif
            events = next; error = nil
        } catch { self.error = "本机运行记录暂时无法保存。" }
    }
}
