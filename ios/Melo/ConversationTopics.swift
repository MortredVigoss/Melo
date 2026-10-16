import Foundation
import JavaScriptCore

/// Topics inside one conversation, from the same rule file the desktop uses
/// (src/shared/conversationTopics.js, bundled as Scene/conversation-topics.js),
/// so the same messages split into the same topics on both devices.
struct TopicSegmentation: Equatable {
    struct Topic: Equatable { let id: String; let label: String }
    var byMessage: [String: String] = [:]
    var topics: [Topic] = []
    func topic(of messageID: String) -> Topic? { byMessage[messageID].flatMap { id in topics.first { $0.id == id } } }
}

struct TopicDivider: Equatable {
    let label: String
    /// The first message of the topic this one returns to (nil when the topic is new).
    let returnsTo: String?
}

/// What one turn needs about topics (see topicContextForTurn in the shared file).
struct TopicTurnContext: Equatable {
    var text = ""
    var returned = false
    var currentLabel = ""
}

final class ConversationTopics {
    private let context: JSContext

    init?(source: String? = nil) {
        let code = source ?? Bundle.main.url(forResource: "conversation-topics", withExtension: "js", subdirectory: "Scene").flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        guard let code, let context = JSContext() else { return nil }
        context.evaluateScript(code)
        guard context.exception == nil else { return nil }
        self.context = context
    }

    private func rows(_ messages: [ChatMessage]) -> [[String: String]] {
        messages.map { ["id": $0.id, "role": $0.role, "content": $0.content] }
    }
    private func call(_ name: String, _ arguments: [Any]) -> JSValue? {
        let value = context.objectForKeyedSubscript(name)?.call(withArguments: arguments)
        return context.exception == nil ? value : nil
    }

    func segment(_ messages: [ChatMessage]) -> TopicSegmentation {
        guard let result = call("segmentConversationTopics", [rows(messages)]),
              let byMessage = result.objectForKeyedSubscript("byMessage")?.toDictionary() as? [String: String],
              let topics = result.objectForKeyedSubscript("topics")?.toArray() as? [[String: Any]] else { return TopicSegmentation() }
        return TopicSegmentation(byMessage: byMessage, topics: topics.compactMap { row in
            guard let id = row["id"] as? String, let label = row["label"] as? String else { return nil }
            return .init(id: id, label: label)
        })
    }

    func turnContext(_ messages: [ChatMessage], windowStart: Int, budgetChars: Int) -> TopicTurnContext {
        guard let result = call("topicContextForTurn", [rows(messages), windowStart, budgetChars]) else { return TopicTurnContext() }
        return TopicTurnContext(text: result.objectForKeyedSubscript("text")?.toString() ?? "",
                                returned: result.objectForKeyedSubscript("returned")?.toBool() ?? false,
                                currentLabel: result.objectForKeyedSubscript("currentLabel")?.toString() ?? "")
    }

    /// The summary request for turns that left the window, plus its system prompt.
    func foldRequest(_ messages: [ChatMessage], previousSummary: String, maxChars: Int) -> (system: String, user: String)? {
        guard let user = call("foldSummaryRequest", [rows(messages), previousSummary, maxChars])?.toString(),
              let system = context.evaluateScript("FOLD_SUMMARY_SYSTEM")?.toString(), context.exception == nil else { return nil }
        return (system, user)
    }
}

/// A summary of the turns that no longer fit the phone's recent window, kept on this
/// device only (each device folds its own copy, like the desktop's compact summary).
struct FoldedSummary: Codable, Equatable {
    var summary: String
    var throughMessageID: String
    var updatedAt: String
}

enum ConversationFolding {
    /// Index of the first message the next request will still send verbatim.
    static func windowStart(_ messages: [ChatMessage], reservedBytes: Int) -> Int {
        messages.count - ConversationHistory.recentTurns(messages, reservedBytes: reservedBytes).count
    }
    /// Messages that left the window and are not yet in the summary (nil when nothing to fold).
    static func pending(_ messages: [ChatMessage], reservedBytes: Int, folded: FoldedSummary?) -> ArraySlice<ChatMessage>? {
        let end = windowStart(messages, reservedBytes: reservedBytes)
        let start = folded.flatMap { summary in messages.firstIndex { $0.id == summary.throughMessageID }.map { $0 + 1 } } ?? 0
        guard end > start else { return nil }
        return messages[start..<end]
    }
    static func instructions(_ folded: FoldedSummary?) -> String {
        guard let folded, !folded.summary.isEmpty else { return "" }
        return "\n\n以下是本对话较早部分的摘要（按话题整理，原文仍保存在对话记录中），只作参考：\n" + folded.summary
    }
}
