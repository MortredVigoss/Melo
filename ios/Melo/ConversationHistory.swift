import Foundation

enum ConversationHistory {
    // UTF-8 bytes conservatively budget multilingual text without assuming an
    // English chars/token ratio. Model windows differ; HTTP errors stay explicit.
    static let textByteBudget = 48_000
    static let instructionReserve = 2_048
    static func validateCurrentInput(_ text: String, instructions: String = "") throws {
        guard text.utf8.count + instructions.utf8.count + instructionReserve <= textByteBudget else {
            throw MeloError.message("本次输入或所选资料太长，请缩短内容、减少引用资料或分段发送；原内容已保留。")
        }
    }
    /// Keep contiguous recent user turns. The newest turn stays whole even if it
    /// alone exceeds the soft message limit; this never edits persisted history.
    static func recentTurns(_ messages: [ChatMessage], maxMessages: Int = 60, maxTextBytes: Int = textByteBudget, reservedBytes: Int = 0) -> [ChatMessage] {
        guard maxMessages > 0, let latestUser = messages.lastIndex(where: { $0.role == "user" }) else { return [] }
        var start = latestUser
        var used = messages[latestUser...].reduce(0) { $0 + $1.content.utf8.count + 64 }
        let budget = max(0, maxTextBytes - reservedBytes - instructionReserve)
        for index in messages.indices.reversed() where index < latestUser && messages[index].role == "user" {
            let cost = messages[index..<start].reduce(0) { $0 + $1.content.utf8.count + 64 }
            guard messages.count - index <= maxMessages, used + cost <= budget else { break }
            start = index; used += cost
        }
        return Array(messages[start...])
    }
}
