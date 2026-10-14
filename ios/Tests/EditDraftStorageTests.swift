import Foundation

@main struct EditDraftStorageTests {
    struct Settings: Codable, Equatable { var name: String; var enabled: Bool; var model: String }
    enum Failure: Error { case locked }
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var secrets: [String: String] = [:]
        var locked = false
        func repository() -> EditDraftStorage {
            EditDraftStorage(directory: directory, readSecret: { secrets[$0] ?? "" }, writeSecret: { value, key in
                if locked { throw Failure.locked }; secrets[key] = value
            })
        }
        let store = repository()
        let original = Settings(name: "original", enabled: false, model: "a")
        var draft = EditDraft(original); draft.begin(original)
        draft.value = Settings(name: "full draft", enabled: true, model: "b")
        try store.save(draft, key: "role/settings")
        // A reconstructed view and a fresh process both get all fields, without changing live settings.
        assert(tryValue { try store.restore(EditDraft<Settings>.self, key: "role/settings") } == draft)
        var resumed = try repository().restore(EditDraft<Settings>.self, key: "role/settings")!
        assert(resumed.value == draft.value && resumed.original == original && resumed.editing)
        var external = original; external.model = "external"
        assert(!resumed.start(current: external) && resumed.value.model == "b")
        assert(draft.start(current: original))
        try store.save(draft, key: "interrupted")
        var interrupted = try repository().restore(EditDraft<Settings>.self, key: "interrupted")!
        interrupted.resume(); assert(!interrupted.saving && interrupted.canSave && interrupted.error != nil)
        // Sensitive drafts must never produce a file, including changed and original credentials.
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        try store.save("secret-fixture", key: "connection", secure: true)
        assert(tryValue { try repository().restore(String.self, key: "connection", secure: true) } == "secret-fixture")
        assert(tryValue { try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted() } == files)
        locked = true
        do { try store.save("new-secret-fixture", key: "connection", secure: true); assertionFailure() } catch {}
        assert(tryValue { try store.restore(String.self, key: "connection", secure: true) } == "new-secret-fixture")
        locked = false
        try store.save("new-secret-fixture", key: "connection", secure: true)
        try store.remove(key: "connection", secure: true)
        try store.remove(key: "role/settings")
        assert(tryValue { try repository().restore(String.self, key: "connection", secure: true) } == nil)
        assert(tryValue { try repository().restore(EditDraft<Settings>.self, key: "role/settings") } == nil)
        print("Draft storage: full-field navigation/restart recovery, external conflict, interrupted save, secure isolation, failed-write recovery and removal passed")
    }
    static func tryValue<T>(_ body: () throws -> T) -> T { try! body() }
}
