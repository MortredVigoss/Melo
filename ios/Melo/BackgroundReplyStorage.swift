import Foundation

enum BackgroundReplyStorage {
    /// Still encrypted; available after first unlock so an active reply can save
    /// when the screen locks. Credentials remain separate in the Keychain.
    static func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func prepare(_ urls: [URL]) throws {
        for url in urls where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        }
    }
}

/// Device-local only. A different conversation, user turn, Agent or account
/// must never inherit an interrupted reply's observations.
struct ReplyCheckpoint: Codable {
    var runID: String
    var chatID: String
    var questionID: String
    var binding: String
    var supportsContinuation: Bool
    var cursor = PhoneReplyCursor()
    var automatic = false
    var attempts = 0
    var supplements: [String] = []
    var canContinue: Bool { supportsContinuation && cursor.inFlightEffect == nil }
}
