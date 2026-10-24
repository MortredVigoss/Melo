import Foundation

struct ChatMessage: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var role: String
    var content: String
    var createdAt: String = timestamp()
}
struct Conversation: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var title: String = "新对话"
    var createdAt: String = timestamp()
    var updatedAt: String = timestamp()
    var messages: [ChatMessage] = []
}
struct SyncSnapshot: Codable {
    var version = 1
    var chats: [Conversation] = []
    var tasks: [TaskCheckpoint]? = nil
    var handoffs: [TaskHandoff]? = nil
    var workspace: SyncWorkspace? = nil
    var deletedChats: [DeletedChat]? = nil
    func validated() throws -> SyncSnapshot {
        try SyncWireContract.validate(JSONDecoder().decode(SyncValue.self, from: JSONEncoder().encode(self)), definition: "snapshot")
        _ = try mergeDeletedChats(deletedChats ?? [], [])
        _ = try mergeTaskCheckpoints(tasks ?? [], [])
        _ = try mergeHandoffs(handoffs ?? [], [])
        _ = try workspace?.validated()
        var ids = Set<String>()
        for chat in chats {
            guard ids.insert(chat.id).inserted else { throw MeloError.message("同步对话标识重复。") }
            try validateSyncDate(chat.createdAt); try validateSyncDate(chat.updatedAt)
            var messages = Set<String>()
            for message in chat.messages {
                guard messages.insert(message.id).inserted else { throw MeloError.message("同步消息标识重复。") }
                try validateSyncDate(message.createdAt)
            }
        }
        return self
    }
}
func validateSyncDate(_ value: String) throws {
    let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard fractional.date(from: value) != nil || ISO8601DateFormatter().date(from: value) != nil else { throw MeloError.message("同步时间格式无效，原数据已保留。") }
}
func timestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}
enum MeloError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return String(localized: String.LocalizationValue(text)) }; return nil }
}
struct DeletedChat: Codable, Equatable {
    var id: String
    var deletedAt: String
}
func mergeDeletedChats(_ local: [DeletedChat], _ remote: [DeletedChat]) throws -> [DeletedChat] {
    var result: [String: DeletedChat] = [:]
    let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    for var row in local + remote {
        guard SyncWorkspace.validID(row.id), let date = fractional.date(from: row.deletedAt) ?? plain.date(from: row.deletedAt) else { throw MeloError.message("同步删除记录格式无效，原数据已保留。") }
        row.deletedAt = fractional.string(from: date)
        if let old = result[row.id], old.deletedAt >= row.deletedAt { continue }
        result[row.id] = row
    }
    return result.values.sorted { $0.id < $1.id }
}
func requireDeletionAcknowledgement(_ sent: [DeletedChat], _ returned: [DeletedChat]?) throws {
    let rows = try mergeDeletedChats([], returned ?? [])
    guard sent.allSatisfy({ sent in rows.contains { $0.id == sent.id && $0.deletedAt >= sent.deletedAt } }) else {
        throw MeloError.message("同步服务未确认删除记录，请先更新同步服务；本地删除已保留。")
    }
}
func merge(_ local: [Conversation], _ remote: [Conversation], deletedChats: [DeletedChat] = []) throws -> [Conversation] {
    let deleted = Set(try mergeDeletedChats([], deletedChats).map(\.id))
    var result: [String: Conversation] = [:]
    for chat in local where !deleted.contains(chat.id) {
        guard result[chat.id] == nil else { throw MeloError.message("本地对话 ID 重复，原记录已保留。") }
        result[chat.id] = chat
    }
    var remoteIDs = Set<String>()
    for incoming in remote {
        if deleted.contains(incoming.id) { continue }
        guard remoteIDs.insert(incoming.id).inserted else { throw MeloError.message("同步数据有重复对话，已停止合并。") }
        var remoteMessageIDs = Set<String>()
        for message in incoming.messages {
            guard remoteMessageIDs.insert(message.id).inserted, ["user", "assistant"].contains(message.role) else { throw MeloError.message("同步消息格式无效。") }
        }
        guard var existing = result[incoming.id] else { result[incoming.id] = incoming; continue }
        var messages = Dictionary(uniqueKeysWithValues: existing.messages.map { ($0.id, $0) })
        for message in incoming.messages {
            if let old = messages[message.id], old != message { throw MeloError.message("同一消息出现不同内容，已保留本地记录并停止同步。") }
            messages[message.id] = message
        }
        if incoming.updatedAt > existing.updatedAt || (incoming.updatedAt == existing.updatedAt && incoming.title > existing.title) { existing.title = incoming.title; existing.updatedAt = incoming.updatedAt }
        existing.createdAt = min(existing.createdAt, incoming.createdAt)
        existing.messages = messages.values.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
        result[existing.id] = existing
    }
    return result.values.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
}

struct TaskCheckpoint: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var status: String
    var owner: String
    var checkpoint: String
    var revision: Int
    var sourceDevice: String
    var updatedAt: String
    var chatId: String?
    var needsApproval: Bool
    var statusLabel: String { needsApproval && status == "running" ? "等待执行设备确认权限" : ["todo":"待执行", "running":"执行中", "blocked":"需要修复", "review":"待验收", "done":"已完成"][status] ?? "未知状态" }
    var canRequestHandoff: Bool { ["todo", "blocked"].contains(status) }
    func handoffLabel(requests: [TaskHandoff], receipts: Set<String>) -> String {
        let matches = requests.filter { $0.taskId == id && $0.revision == revision }
        if matches.contains(where: { receipts.contains($0.id) }) { return "同步服务已接收 · 等待桌面确认" }
        return matches.isEmpty ? "尚未请求接力" : "请求保存在手机 · 待确认送达"
    }
}
struct TaskHandoff: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString
    var taskId: String
    var fromDevice: String
    var requestedAt: String = timestamp()
    var revision: Int
}
func mergeTaskCheckpoints(_ local: [TaskCheckpoint], _ remote: [TaskCheckpoint]) throws -> [TaskCheckpoint] {
    var result: [String: TaskCheckpoint] = [:]
    for task in local + remote {
        try SyncWireContract.validate(JSONDecoder().decode(SyncValue.self, from: JSONEncoder().encode(task)), definition: "task")
        try validateSyncDate(task.updatedAt)
        guard task.revision > 0, !task.id.isEmpty, !task.sourceDevice.isEmpty,
              ["todo", "running", "blocked", "review", "done"].contains(task.status) else { throw MeloError.message("任务检查点格式无效，原记录已保留。") }
        if let old = result[task.id] {
            guard old.sourceDevice == task.sourceDevice, old.revision != task.revision || old == task else { throw MeloError.message("任务检查点冲突，原记录已保留。") }
            if old.revision > task.revision { continue }
        }
        result[task.id] = task
    }
    return result.values.sorted { $0.updatedAt > $1.updatedAt }
}
func mergeHandoffs(_ local: [TaskHandoff], _ remote: [TaskHandoff]) throws -> [TaskHandoff] {
    var result: [String: TaskHandoff] = [:]
    for request in local + remote {
        try SyncWireContract.validate(JSONDecoder().decode(SyncValue.self, from: JSONEncoder().encode(request)), definition: "handoff")
        try validateSyncDate(request.requestedAt)
        if let old = result[request.id], old != request { throw MeloError.message("接力请求冲突，原记录已保留。") }
        result[request.id] = request
    }
    return result.values.sorted { $0.id < $1.id }
}
