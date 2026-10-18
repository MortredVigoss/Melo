import Foundation
@main struct MemoryFactsTests {
    static func main() throws {
        let source = try String(contentsOfFile: "src/memory/offline/extractor.js", encoding: .utf8).replacingOccurrences(of: "export function extractFactsRuleBased", with: "function extractFactsRuleBased")
        let message = ChatMessage(role: "user", content: "我不喜欢咖啡。我喜欢看电影。")
        let facts = MobileMemoryExtraction.extract(message: message, chatID: "chat-a", agentID: "melo", projectID: nil, source: source)
        assert(facts.contains { $0.text == "User dislikes 咖啡" })
        assert(facts.allSatisfy { $0.scope == "chat" && $0.messageId == message.id })
        assert(MobileMemoryExtraction.extract(message: .init(role: "assistant", content: "我喜欢咖啡"), chatID: "chat-a", agentID: "melo", projectID: nil, source: source).isEmpty)
        var fact = facts[0]; _ = try fact.validated()
        let live: Set<String> = ["chat-a", "chat-b"]
        for greeting in ["你好", " hi! ", "谢谢。", "THANK YOU"] {
            let recalled = MobileMemoryRecall.recall([fact], query: greeting, chatID: "chat-a", projectID: nil, agentID: "melo", liveChats: live)
            assert(recalled.facts.isEmpty && !recalled.semantic)
            assert(!MobileMemoryRecall.isStandaloneGreeting(greeting, hasAttachments: true))
        }
        for followup in ["好", "ok", "继续", "你好，推荐饮料", "什么是 hi"] { assert(!MobileMemoryRecall.isStandaloneGreeting(followup)) }
        var merged = fact; merged.mergedInto = "promoted:winner"
        assert(merged.effectiveStatus == "historical" && !merged.eligible(chat: "chat-a", project: nil, agent: "melo", liveChats: live))
        let decodedMerged = try JSONDecoder().decode(MobileMemoryFact.self, from: JSONEncoder().encode(merged))
        assert(decodedMerged.mergedInto == merged.mergedInto)
        assert(!fact.eligible(chat: "chat-b", project: nil, agent: "melo", liveChats: live))
        fact.scope = "personal"; assert(fact.eligible(chat: "chat-b", project: nil, agent: "melo", liveChats: live))
        fact.status = "forgotten"; assert(!fact.eligible(chat: "chat-a", project: nil, agent: "melo", liveChats: live))
        fact.status = "active"; assert(!fact.eligible(chat: "chat-b", project: nil, agent: "melo", liveChats: ["chat-b"]))
        assert(MobileMemoryRecall.recall([fact], query: "咖啡", chatID: "chat-a", projectID: nil, agentID: "melo", liveChats: live, conflicts: [fact.id]).facts.isEmpty)
        assert(MobileMemoryRecall.withinBudget([fact], remainingBytes: 0).isEmpty)
        assert(MobileMemoryRecall.withinBudget([fact], remainingBytes: MobileMemoryRecall.instructions([fact]).utf8.count) == [fact])
        fact.validTo = "2099-01-01T00:00:00.000Z"
        var edited = try JSONDecoder().decode(MobileMemoryFact.self, from: JSONEncoder().encode(fact)); edited.text = "edited"
        assert(edited.validTo == fact.validTo && edited.eligible(chat: "chat-a", project: nil, agent: "melo", liveChats: live))
        edited.validTo = "2000-01-01T00:00:00.000Z"
        assert(edited.effectiveStatus == "historical" && !edited.eligible(chat: "chat-a", project: nil, agent: "melo", liveChats: live))
        var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fact)) as! [String: Any]; legacy.removeValue(forKey: "validTo")
        let old = try JSONDecoder().decode(MobileMemoryFact.self, from: JSONSerialization.data(withJSONObject: legacy)); assert(old.validTo == nil)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as! [String: Any]; assert(json["validTo"] is NSNull)
        // Audit I6: project-book fields round-trip; absent fields stay absent (never encoded as null).
        var book = fact; book.scope = "project"; book.projectId = "proj"; book.section = "decision"; book.bookStatus = "user"
        let bookJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(book)) as! [String: Any]
        assert(bookJSON["section"] as? String == "decision" && bookJSON["bookStatus"] as? String == "user")
        let bookBack = try JSONDecoder().decode(MobileMemoryFact.self, from: JSONEncoder().encode(book))
        let validatedBook = try bookBack.validated()
        assert(bookBack == book && validatedBook == book)
        let plainJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fact)) as! [String: Any]
        assert(plainJSON["section"] == nil && plainJSON["bookStatus"] == nil && plainJSON["mergedInto"] == nil)
        var badStatus = book; badStatus.bookStatus = "pending"
        do { _ = try badStatus.validated(); fatalError("Invalid bookStatus accepted") } catch {}
        var invalid = fact; invalid.updatedAt = "invalid"
        do { _ = try invalid.validated(); fatalError("Invalid date accepted") } catch {}
        var workspace = SyncWorkspace(); workspace.put(kind: "memory", id: fact.id, value: try JSONDecoder().decode(SyncValue.self, from: JSONEncoder().encode(fact)), device: "phone")
        _ = try workspace.validated(); assert(workspace.excluding([.init(id: "chat-a", deletedAt: timestamp())]).records.isEmpty)
        print("Memory facts: desktop extraction, negative preference, source, scope, inactive/deleted/conflict exclusion and sync passed")
    }
}
