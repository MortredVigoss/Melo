#if DEBUG && targetEnvironment(simulator)
import Foundation
@MainActor enum LocalSettingsVerification {
    static func run() async {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let root = support.appendingPathComponent("LocalSettingsVerification-" + UUID().uuidString)
        var result: [String: Any] = ["passed": false]
        do {
            let source = ChatStore(directory: root.appendingPathComponent("source"))
            guard let id = source.newChat(), let index = source.chats.firstIndex(where: { $0.id == id }) else { throw MeloError.message("create failed") }
            source.chats[index].messages = [ChatMessage(role: "user", content: "fixture import")]
            try source.save()
            let data = try source.exportLocalArchive()
            let archive = try JSONDecoder().decode(PortableArchive.self, from: data)
            try archive.validate()
            let destination = ChatStore(directory: root.appendingPathComponent("destination"))
            try destination.importLocalArchive(archive); try destination.importLocalArchive(archive)
            guard destination.chats.count == 1, destination.chats[0].messages.count == 1 else { throw MeloError.message("import not idempotent") }
            let reloaded = ChatStore(directory: root.appendingPathComponent("destination"))
            guard reloaded.chats[0].messages[0].content == "fixture import", reloaded.preferences.agents.count == source.preferences.agents.count else { throw MeloError.message("import did not persist") }
            var invalid = archive; invalid.format = "other"
            do { try destination.importLocalArchive(invalid); throw MeloError.message("invalid import accepted") } catch { if error.localizedDescription == "invalid import accepted" { throw error } }
            result["passed"] = true; result["checks"] = ["export", "preview validation", "merge twice", "restart persistence", "bad format rejected"]
        } catch { result["error"] = error.localizedDescription }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? BackgroundReplyStorage.write(data,to:support.appendingPathComponent("local-settings-verification.json")) }
    }
}
#endif
