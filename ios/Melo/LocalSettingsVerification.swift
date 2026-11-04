#if DEBUG && targetEnvironment(simulator)
import Foundation
@MainActor enum LocalSettingsVerification {
    // Explicit QA launch on a fresh simulator. Refuse to modify an existing account.
    static func connections(reopened: Bool) {
        let defaults = UserDefaults.standard
        var result: [String:Any] = ["passed": false, "reopened": reopened]
        do {
            if !reopened {
                guard try LLMConnection.saved().isEmpty, Secrets.read("modelKey").isEmpty,
                      defaults.string(forKey:"activeLLMConnection") == nil else { throw MeloError.message("Requires a fresh QA simulator.") }
                let preset = LLMConnection.presets[0]
                for n in 1...5 {
                    var profile = LLMConnection.newProfile(preset, alongside:try LLMConnection.saved())
                    profile.name = "QA Account " + String(n); profile.model = "shared-model"; profile.key = "test-only-" + String(n)
                    try profile.save()
                }
                guard (defaults.string(forKey:"modelAuthMode") ?? "chatgpt") == "chatgpt" else { throw MeloError.message("Adding a key changed the default.") }
                for n in [5,2] {
                    guard let choice = try LLMConnection.saved().first(where: { $0.name == "QA Account " + String(n) }) else { throw MeloError.message("Missing saved profile.") }
                    try choice.save(activate:true)
                    guard Secrets.read("modelKey") == "test-only-" + String(n) else { throw MeloError.message("Wrong active credential.") }
                }
            }
            let accounts = try LLMConnection.saved()
            guard accounts.count == 5, Set(accounts.map(\.id)).count == 5,
                  accounts.first(where: { $0.id == defaults.string(forKey:"activeLLMConnection") })?.name == "QA Account 2",
                  defaults.string(forKey:"modelAuthMode") == "api",
                  let third = accounts.first(where: { $0.name == "QA Account 3" }) else { throw MeloError.message("Saved connection selection changed.") }
            let choice = ConversationModel(connectionID:third.id, model:third.model, baseURL:third.baseURL, apiProtocol:third.apiProtocol)
            guard LLMConnection.resolve(choice,in:accounts)?.key == "test-only-3", Secrets.read("modelKey") == "test-only-2" else { throw MeloError.message("Conversation credential mismatch.") }
            guard LLMConnection.resolve(choice,in:accounts.filter { $0.id != third.id }) == nil else { throw MeloError.message("Missing account fell back to a different key.") }
            result["passed"] = true; result["saved"] = accounts.count; result["global"] = "QA Account 2"; result["chat"] = third.name
        } catch { result["error"] = error.localizedDescription }
        let support = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        try? FileManager.default.createDirectory(at:support,withIntermediateDirectories:true)
        if let data = try? JSONSerialization.data(withJSONObject:result) { try? data.write(to:support.appendingPathComponent("connections-verification.json"),options:.atomic) }
    }
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
