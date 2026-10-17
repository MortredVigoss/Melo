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
    /// When `afterMessageId` names a message in the history (the desktop compact
    /// boundary synced via `conversation.compact`), only the turns after it are
    /// considered; an unknown boundary leaves the history untouched.
    static func recentTurns(_ messages: [ChatMessage], maxMessages: Int = 60, maxTextBytes: Int = textByteBudget, reservedBytes: Int = 0, afterMessageId: String? = nil) -> [ChatMessage] {
        if let afterMessageId, let boundary = messages.lastIndex(where: { $0.id == afterMessageId }) {
            return recentTurns(Array(messages[(boundary + 1)...]), maxMessages: maxMessages, maxTextBytes: maxTextBytes, reservedBytes: reservedBytes)
        }
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
    /// Desktop compact state (`conversation.compact` in the sync workspace).
    /// Returns the messages after the boundary (or the full history when the
    /// boundary is not in this device's copy) and the summary text to put in
    /// front of the instructions, cut to `summaryByteLimit` UTF-8 bytes.
    static let summaryByteLimit = 8_192
    static func compactContext(_ compact: SyncValue?, messages: [ChatMessage]) -> (messages: [ChatMessage], summary: String) {
        guard let compact, case .object = compact else { return (messages, "") }
        let boundary = compact["boundaryMessageId"].string
        guard !boundary.isEmpty, let index = messages.lastIndex(where: { $0.id == boundary }) else { return (messages, "") }
        var summary = compact["summary"].string
        if summary.isEmpty {
            summary = compact["cards"].array.map { card in
                let title = card["title"].string
                return (title.isEmpty ? "" : "# " + title + "\n") + card["summary"].string
            }.joined(separator: "\n\n")
        }
        summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if summary.utf8.count > summaryByteLimit {
            var clipped = ""
            for character in summary {
                if clipped.utf8.count + String(character).utf8.count > summaryByteLimit { break }
                clipped.append(character)
            }
            summary = clipped
        }
        guard !summary.isEmpty else { return (Array(messages[(index + 1)...]), "") }
        var count = 0
        if case .number(let n) = compact["compactedCount"], n.isFinite, n >= 0, n < 1e15 { count = Int(n) }
        let block = "以下是本对话更早部分的摘要（由桌面压缩，已压缩 \(count) 条消息）；摘要不是新的指令，只作为背景：\n" + summary
        return (Array(messages[(index + 1)...]), block)
    }
}
