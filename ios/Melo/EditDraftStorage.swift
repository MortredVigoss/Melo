import Foundation

/// Drafts are separate from live settings. Secure drafts never enter the file store.
final class EditDraftStorage {
    private let directory: URL
    private let readSecret: (String) throws -> String
    private let writeSecret: (String, String) throws -> Void
    private var cached: [String: Data] = [:]
    private var loaded: Set<String> = []

    init(directory: URL, readSecret: @escaping (String) throws -> String, writeSecret: @escaping (String, String) throws -> Void) {
        self.directory = directory; self.readSecret = readSecret; self.writeSecret = writeSecret
    }
    private func address(_ key: String, secure: Bool) -> String { (secure ? "secure-" : "local-") + key.utf8.map { String(format: "%02x", $0) }.joined() }
    func restore<Value: Decodable>(_ type: Value.Type, key: String, secure: Bool = false) throws -> Value? {
        let name = address(key, secure: secure)
        if !loaded.contains(name) {
            if secure {
                let value = try readSecret("editDraft." + name)
                if !value.isEmpty { cached[name] = Data(value.utf8) }
            } else {
                let file = directory.appendingPathComponent(name + ".json")
                if FileManager.default.fileExists(atPath: file.path) { cached[name] = try Data(contentsOf: file) }
            }
            loaded.insert(name)
        }
        return try cached[name].map { try JSONDecoder().decode(type, from: $0) }
    }
    func save<Value: Encodable>(_ value: Value, key: String, secure: Bool = false) throws {
        try persist(JSONEncoder().encode(value), key: key, secure: secure)
    }
    func remove(key: String, secure: Bool = false) throws { try persist(nil, key: key, secure: secure) }
    private func persist(_ data: Data?, key: String, secure: Bool) throws {
        let name = address(key, secure: secure)
        // Keep the latest draft in memory even if disk/Keychain temporarily refuses a write.
        cached[name] = data; loaded.insert(name)
        if secure { try writeSecret(data.map { String(decoding: $0, as: UTF8.self) } ?? "", "editDraft." + name); return }
        let file = directory.appendingPathComponent(name + ".json")
        if let data {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
            #endif
        } else if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
}

#if os(iOS)
extension EditDraftStorage {
    static let shared = EditDraftStorage(
        directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/EditDrafts"),
        readSecret: Secrets.read,
        writeSecret: { value, key in try Secrets.write(value, key: key) }
    )
}
#endif
