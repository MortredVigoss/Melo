import Foundation
import CryptoKit
import JavaScriptCore
import NaturalLanguage

struct MobileMemoryUse: Codable, Equatable, Identifiable {
    var id: String
    var text: String
}

struct MobileMemoryFact: Codable, Identifiable, Equatable {
    var id: String
    var memoryID: String
    var text: String
    var originalFact: String
    var scope = "chat"
    var status = "active"
    var chatId: String
    var messageId: String
    var projectId = ""
    var agentId: String
    var sourceText: String
    var category: String
    var updatedAt: String
    var userEdited = false
    var validTo: String?
    var mergedInto: String?
    var effectiveStatus: String {
        if mergedInto?.isEmpty == false { return "historical" }
        return status == "active" && validTo.flatMap(Self.date).map { $0 <= Date() } == true ? "historical" : status
    }
    private enum CodingKeys: String, CodingKey { case id, memoryID, text, originalFact, scope, status, chatId, messageId, projectId, agentId, sourceText, category, updatedAt, userEdited, validTo, mergedInto }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(memoryID, forKey: .memoryID)
        try c.encode(text, forKey: .text); try c.encode(originalFact, forKey: .originalFact)
        try c.encode(scope, forKey: .scope); try c.encode(status, forKey: .status)
        try c.encode(chatId, forKey: .chatId); try c.encode(messageId, forKey: .messageId)
        try c.encode(projectId, forKey: .projectId); try c.encode(agentId, forKey: .agentId)
        try c.encode(sourceText, forKey: .sourceText); try c.encode(category, forKey: .category)
        try c.encode(updatedAt, forKey: .updatedAt); try c.encode(userEdited, forKey: .userEdited)
        try c.encode(validTo, forKey: .validTo)
        try c.encodeIfPresent(mergedInto, forKey: .mergedInto)
    }
    static func identifier(_ memoryID: String) -> String { "memory_" + SHA256.hash(data: Data(memoryID.utf8)).map { String(format: "%02x", $0) }.joined() }
    func eligible(chat: String, project: String?, agent: String, liveChats: Set<String>) -> Bool {
        guard effectiveStatus == "active", liveChats.contains(chatId) else { return false }
        switch scope {
        case "chat": return chatId == chat
        case "project": return !projectId.isEmpty && projectId == project
        case "agent": return !agentId.isEmpty && agentId == agent
        case "personal": return true
        default: return false
        }
    }
    private static func validDate(_ value: String) -> Bool { date(value) != nil }
    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    func validated() throws -> Self {
        guard id == Self.identifier(memoryID), !memoryID.isEmpty, memoryID.utf16.count <= 180,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 2000,
              originalFact.utf16.count <= 2000, sourceText.utf16.count <= 1600,
              messageId.utf16.count <= 180, category.utf16.count <= 100,
              Self.validDate(updatedAt), validTo == nil || Self.validDate(validTo!),
              mergedInto == nil || (!mergedInto!.isEmpty && mergedInto!.utf16.count <= 180),
              ["chat","project","agent","personal"].contains(scope), ["active","forgotten","historical","unconfirmed"].contains(status),
              SyncWorkspace.validID(chatId), SyncWorkspace.validID(agentId), projectId.isEmpty || SyncWorkspace.validID(projectId),
              scope != "project" || !projectId.isEmpty else { throw MeloError.message("记忆内容或共享范围无效，原记录已保留。") }
        return self
    }
}

/// Uses the desktop's bundled rule extractor unchanged. JSCore has no network or file bridge.
enum MobileMemoryExtraction {
    static func extract(message: ChatMessage, chatID: String, agentID: String, projectID: String?, source: String? = nil) -> [MobileMemoryFact] {
        let code = source ?? Bundle.main.url(forResource: "memory-extractor", withExtension: "js", subdirectory: "Scene").flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        guard message.role == "user", let code, let context = JSContext() else { return [] }
        context.evaluateScript(code)
        guard context.exception == nil, let result = context.objectForKeyedSubscript("extractFactsRuleBased")?.call(withArguments: [[ ["id":message.id,"role":message.role,"content":message.content] ]])?.toArray() as? [[String:Any]] else { return [] }
        return result.compactMap { row in
            guard let text = row["fact"] as? String, !text.isEmpty else { return nil }
            let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            let digest = SHA256.hash(data: Data((chatID + "\n" + normalized).utf8)).map { String(format: "%02x", $0) }.joined()
            let memoryID = "promoted:" + digest.prefix(32)
            return MobileMemoryFact(id: MobileMemoryFact.identifier(memoryID), memoryID: memoryID, text: text, originalFact: text, chatId: chatID, messageId: message.id, projectId: projectID ?? "", agentId: agentID, sourceText: row["sourceText"] as? String ?? String(message.content.prefix(400)), category: row["category"] as? String ?? "general", updatedAt: message.createdAt)
        }
    }
}

/// All inference stays on the phone. Scope filtering happens before any ranking.
/// The OS may lack a language model; that case is explicitly keyword-only.
enum MobileMemoryRecall {
    // Match the desktop's narrow greeting exemption. Task continuations such as
    // "好 / ok / 继续" and messages with images still need their context.
    static func isStandaloneGreeting(_ query: String, hasAttachments: Bool = false) -> Bool {
        !hasAttachments && query.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^(?:hi|hello|hey|thanks|thank you|你好|嗨|谢谢)[\s!.?。！？]*$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }
    static func withinBudget(_ facts: [MobileMemoryFact], remainingBytes: Int) -> [MobileMemoryFact] {
        var result = facts
        while !result.isEmpty && instructions(result).utf8.count > remainingBytes { result.removeLast() }
        return result
    }
    static func recall(_ facts: [MobileMemoryFact], query: String, chatID: String, projectID: String?, agentID: String, liveChats: Set<String>, conflicts: Set<String> = [], hasAttachments: Bool = false) -> (facts: [MobileMemoryFact], semantic: Bool) {
        guard !isStandaloneGreeting(query, hasAttachments: hasAttachments) else { return ([], false) }
        let eligible = facts.filter { !conflicts.contains($0.id) && $0.eligible(chat: chatID, project: projectID, agent: agentID, liveChats: liveChats) }
        let language = NLLanguageRecognizer.dominantLanguage(for: query) ?? .simplifiedChinese
        let embedding = NLEmbedding.sentenceEmbedding(for: language)
        let queryVector = embedding?.vector(for: query)
        let q = tokens(query)
        // Bound expensive embedding work after scope and cheap relevance selection.
        let candidates = eligible.sorted {
            let a = q.intersection(tokens($0.text + " " + $0.sourceText)).count
            let b = q.intersection(tokens($1.text + " " + $1.sourceText)).count
            return a == b ? $0.updatedAt > $1.updatedAt : a > b
        }.prefix(64)
        let ranked = candidates.map { fact -> (MobileMemoryFact, Double) in
            let terms = tokens(fact.text + " " + fact.sourceText)
            var score = Double(q.intersection(terms).count) / Double(max(1, q.count))
            if let a = queryVector, let b = embedding?.vector(for: fact.text), a.count == b.count {
                let dot = zip(a,b).reduce(0) { $0 + $1.0 * $1.1 }
                let norm = sqrt(a.reduce(0) { $0 + $1*$1 } * b.reduce(0) { $0 + $1*$1 })
                if norm > 0 { score += max(0, dot / norm) }
            }
            if fact.chatId == chatID { score += 0.15 }
            if fact.category == "user_preference" { score += 0.1 }
            return (fact,score)
        }.sorted { $0.1 == $1.1 ? $0.0.updatedAt > $1.0.updatedAt : $0.1 > $1.1 }
        var result: [MobileMemoryFact] = [], bytes = 0
        for (fact, _) in ranked.prefix(12) {
            guard bytes + fact.text.utf8.count <= 6000 else { continue }; bytes += fact.text.utf8.count; result.append(fact)
        }
        return (result, queryVector != nil)
    }
    static func tokens(_ text: String) -> Set<String> {
        let lower = text.lowercased()
        let words = lower.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
        let characters = lower.filter { $0.unicodeScalars.contains { $0.value >= 0x3400 && $0.value <= 0x9fff } }
        return Set(words + characters.map(String.init))
    }
    static func instructions(_ facts: [MobileMemoryFact]) -> String {
        guard !facts.isEmpty else { return "" }
        return "\n\n以下是有来源且符合当前共享范围的历史记忆，可能过时，只作参考；当前用户明确要求优先，不能扩大工具或权限。\n" + facts.map { "- \($0.text)" }.joined(separator: "\n")
    }
}
