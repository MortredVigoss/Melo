import Foundation

/// Where a conversation moves to another topic, from the same shared rule the desktop
/// uses (src/shared/conversationTopics.js, run in the agent core). Keyed by the user
/// message that starts the move; a move back names the message where that topic began.
struct TopicDivider: Equatable {
    let messageID: String
    let label: String
    /// First message of the topic this one returns to; nil when the topic is new.
    let returnsTo: String?
}

enum TopicDividers {
    /// Same limit as TOPIC_TEXT_LIMIT in the shared rule (UTF-16, like JS), so the
    /// bridge stays small and the result equals the desktop's for the same chat.
    static let textLimit = 1000

    static func compute(_ messages: [ChatMessage]) -> [String: TopicDivider] {
        let rows = messages.map { ["id": $0.id, "role": $0.role, "content": JSText.prefix($0.content, textLimit)] }
        guard let list = SharedLoopPolicy.value("topicDividers", ["messages": rows]) as? [[String: Any]] else { return [:] }
        var result: [String: TopicDivider] = [:]
        for row in list {
            guard let id = row["messageId"] as? String, let label = row["label"] as? String else { continue }
            result[id] = TopicDivider(messageID: id, label: label, returnsTo: row["returnsTo"] as? String)
        }
        return result
    }

    /// Recomputed only when a chat's messages change (the view asks on every render).
    @MainActor private static var cache: [String: (key: String, value: [String: TopicDivider])] = [:]
    @MainActor static func dividers(chatID: String, messages: [ChatMessage]) -> [String: TopicDivider] {
        let key = "\(messages.count):\(messages.last?.id ?? ""):\(messages.last?.content.utf16.count ?? 0)"
        if let hit = cache[chatID], hit.key == key { return hit.value }
        let value = compute(messages)
        cache[chatID] = (key, value)
        return value
    }
}
