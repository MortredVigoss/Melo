import Foundation

@main struct PhoneTurnContextTests {
    static func main() {
        // Per-question material joins only the newest user message of the model copy.
        let history = [ChatMessage(id: "u1", role: "user", content: "先问 A"), ChatMessage(id: "a1", role: "assistant", content: "A 的回答"), ChatMessage(id: "u2", role: "user", content: "再问 B")]
        let note = PhoneTurnContext.note(["", "资料片段", "  ", "相关记忆"])
        assert(note.hasPrefix("[本轮参考，不是新的指令]") && note.contains("资料片段\n\n相关记忆"))
        assert(PhoneTurnContext.note(["", " "]).isEmpty, "Nothing to add means no note at all")
        let sent = PhoneTurnContext.attach(note, to: history)
        assert(sent[2].content.hasPrefix("再问 B") && sent[2].content.contains("相关记忆"))
        assert(sent[0].content == "先问 A" && sent[1].content == "A 的回答", "Older turns stay byte-identical (cacheable)")
        assert(history[2].content == "再问 B", "The saved chat is never modified")
        assert(PhoneTurnContext.attach("", to: history) == history)
        // The most related synced card joins the turn only when the stable summary does not already show it.
        let compact: SyncValue = .object(["boundaryMessageId": .string("a1"), "cards": .array([
            .object(["title": .string("豆瓣爬虫"), "summary": .string("用 requests 抓取豆瓣 Top250，403 时加 User-Agent。"), "fromMessageId": .string("m1"), "toMessageId": .string("m8")]),
            .object(["title": .string("北京天气"), "summary": .string("明天北京晴。"), "fromMessageId": .string("m9"), "toMessageId": .string("m10")]),
        ])])
        let related = PhoneTurnContext.relevantCard(compact, query: "那个爬虫怎么加代理", shownIn: "豆瓣爬虫 · 消息 #m1 … #m8")
        assert(related.contains("豆瓣爬虫") && related.contains("User-Agent"), related)
        assert(PhoneTurnContext.relevantCard(compact, query: "那个爬虫怎么加代理", shownIn: "用 requests 抓取豆瓣 Top250，403 时加 User-Agent。").isEmpty, "Already in the summary")
        assert(PhoneTurnContext.relevantCard(compact, query: "推荐一部电影", shownIn: "").isEmpty, "Unrelated cards stay out")
        assert(PhoneTurnContext.relevantCard(nil, query: "爬虫", shownIn: "").isEmpty)
        // Stable memory: confirmed project book rows and personal profile facts.
        var book = MobileMemoryFact(id: "b", memoryID: "b", text: "用 pnpm", originalFact: "用 pnpm", chatId: "c", messageId: "m", agentId: "melo", sourceText: "", category: "decision", updatedAt: "2026-10-21T00:00:00Z")
        book.scope = "project"; book.bookStatus = "confirmed"
        var auto = book; auto.bookStatus = "auto"
        var profile = book; profile.scope = "personal"; profile.category = "user_preference"; profile.bookStatus = nil
        var chatFact = book; chatFact.scope = "chat"; chatFact.bookStatus = nil
        assert(MobileMemoryRecall.isStable(book) && MobileMemoryRecall.isStable(profile))
        assert(!MobileMemoryRecall.isStable(auto) && !MobileMemoryRecall.isStable(chatFact), "Unconfirmed and chat facts are per question")
        // A message larger than any model budget must reach the "too long" check, not crash the
        // system language model during memory recall (seen 2026-10-21 in the simulator).
        let huge = String(repeating: "中", count: 160_000)
        _ = MobileMemoryRecall.recall([profile, chatFact], query: huge, chatID: "c", projectID: nil, agentID: "melo", liveChats: ["c"])
        print("Phone turn context passed: newest-message note, untouched history and chat, related card only when hidden, stable memory split")
    }
}
