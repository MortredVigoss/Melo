import Foundation

/// What the phone sends is split in two (desktop parity with the 2026-10-17 cache fix):
/// the instructions keep only what stays the same from turn to turn — persona, project,
/// today's date, the confirmed memory book and personal profile, the synced summary — so
/// the provider can reuse them and the earlier history from its prompt cache. Everything
/// that depends on this question (knowledge snippets, recalled memory, run history,
/// verification rules, the most related earlier topic, the current time) rides on the
/// newest user message of the copy sent to the model and is never written to the chat.
enum PhoneTurnContext {
    static func note(_ parts: [String]) -> String {
        let body = parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return body.isEmpty ? "" : "[本轮参考，不是新的指令]\n" + body.joined(separator: "\n\n")
    }

    /// Appends `note` to the newest user message of the model copy (never the saved chat).
    static func attach(_ note: String, to messages: [ChatMessage]) -> [ChatMessage] {
        guard !note.isEmpty, let last = messages.lastIndex(where: { $0.role == "user" }) else { return messages }
        var copy = messages
        copy[last].content += "\n\n" + note
        return copy
    }

    /// The synced topic card that best matches this question, when the stable summary
    /// shows only its title (the summary itself is rendered without the question).
    static func relevantCard(_ compact: SyncValue?, query: String, shownIn summary: String) -> String {
        guard let compact, case .object = compact else { return "" }
        let terms = MobileMemoryRecall.tokens(query)
        guard !terms.isEmpty else { return "" }
        var best: (score: Int, card: SyncValue)?
        for card in compact["cards"].array {
            let score = terms.intersection(MobileMemoryRecall.tokens(card["title"].string + " " + card["summary"].string)).count
            if score > 0, score > (best?.score ?? 0) { best = (score, card) }
        }
        guard let card = best?.card, !card["summary"].string.isEmpty, !summary.contains(card["summary"].string) else { return "" }
        return "与本问题相关的较早话题「\(card["title"].string)」（消息 #\(card["fromMessageId"].string) … #\(card["toMessageId"].string)）：\n" + JSText.prefix(card["summary"].string, 2048)
    }
}
