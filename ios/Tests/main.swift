import Foundation
let date = "2026-10-06T12:00:00.000Z"
let a = ChatMessage(id: "a", role: "user", content: "hello", createdAt: date)
let b = ChatMessage(id: "b", role: "assistant", content: "reply", createdAt: date)
let left = Conversation(id: "chat", title: "Test", createdAt: date, updatedAt: date, messages: [a])
let right = Conversation(id: "chat", title: "Test", createdAt: date, updatedAt: date, messages: [b])
let merged = try merge([left], [right])
assert(merged[0].messages.count == 2)
let retry = try merge(merged, [left])
assert(retry == merged)
let reverse = try merge([right], [left])
assert(reverse == merged)
let roundTrip = try JSONDecoder().decode(SyncSnapshot.self, from: JSONEncoder().encode(SyncSnapshot(chats: merged)))
assert(roundTrip.chats == merged)
var conflict = right
conflict.messages = [ChatMessage(id: "a", role: "user", content: "changed", createdAt: date)]
do { _ = try merge([left], [conflict]); fatalError("Conflict accepted") } catch {}
do { _ = try merge([], [left, left]); fatalError("Duplicate accepted") } catch {}
print("Swift sync tests passed: offline merge, idempotence, convergence, persistence, conflicts, validation")
let deleted = [DeletedChat(id: "chat", deletedAt: date)]
let withoutChat = try merge([left], [conflict], deletedChats: deleted)
assert(withoutChat.isEmpty, "Deletion wins even over stale conflicting messages")
let persistedDeletion = try JSONDecoder().decode(SyncSnapshot.self, from: JSONEncoder().encode(SyncSnapshot(chats: [], deletedChats: deleted)))
assert(persistedDeletion.deletedChats == deleted)
let mergedDeletion = try mergeDeletedChats(deleted, deleted)
assert(mergedDeletion == deleted)
do { try requireDeletionAcknowledgement(deleted, nil); fatalError("Legacy service swallowed deletion") } catch {}
try requireDeletionAcknowledgement(deleted, deleted)
do { _ = try mergeDeletedChats([], [.init(id: "../bad", deletedAt: date)]); fatalError("Bad tombstone") } catch {}
do { _ = try mergeDeletedChats([], [.init(id: "chat", deletedAt: "invalid")]); fatalError("Bad deletion date") } catch {}
var legacyWorkspace = SyncWorkspace(records: [.init(kind: "message", id: "reminder:old", versions: [.init(clock: ["desktop":1], value: .object(["chatId":.string("chat")]))])])
_ = try legacyWorkspace.validated()
assert(legacyWorkspace.excluding(deleted).records.isEmpty)
legacyWorkspace.records[0].kind = "project"
do { _ = try legacyWorkspace.validated(); fatalError("Legacy message exception leaked into project IDs") } catch {}
let checkpoint = TaskCheckpoint(id: "task", title: "Task", status: "blocked", owner: "builder", checkpoint: "verify changes", revision: 1, sourceDevice: "desktop", updatedAt: date, chatId: nil, needsApproval: true)
let taskRoundTrip = try JSONDecoder().decode(SyncSnapshot.self, from: JSONEncoder().encode(SyncSnapshot(chats: [], tasks: [checkpoint], handoffs: [])))
assert(taskRoundTrip.tasks == [checkpoint])
let mergedCheckpoint = try mergeTaskCheckpoints([checkpoint], [checkpoint])
assert(mergedCheckpoint == [checkpoint])
var conflictingCheckpoint = checkpoint
conflictingCheckpoint.status = "done"
do { _ = try mergeTaskCheckpoints([checkpoint], [conflictingCheckpoint]); fatalError("Task conflict accepted") } catch {}
let handoff = TaskHandoff(taskId: checkpoint.id, fromDevice: "phone", revision: checkpoint.revision)
let mergedHandoffs = try mergeHandoffs([handoff], [handoff])
assert(mergedHandoffs.count == 1)
print("Swift task handoff tests passed: checkpoint persistence, conflict rejection and request idempotence")
assert(checkpoint.canRequestHandoff)
assert(checkpoint.handoffLabel(requests: [handoff], receipts: []).contains("待确认送达"))
assert(checkpoint.handoffLabel(requests: [handoff], receipts: [handoff.id]).contains("等待桌面确认"))
var newerCheckpoint = checkpoint; newerCheckpoint.revision += 1
assert(newerCheckpoint.handoffLabel(requests: [handoff], receipts: [handoff.id]) == "尚未请求接力")
for state in ["running", "review", "done"] {
    var task = checkpoint; task.status = state
    assert(!task.canRequestHandoff, "Running, review and completed tasks must not offer repeated execution")
    if state == "running" { assert(task.statusLabel.contains("确认权限")) }
}
var invalidCheckpoint = checkpoint; invalidCheckpoint.revision = 0
do { _ = try mergeTaskCheckpoints([], [invalidCheckpoint]); fatalError("Invalid revision accepted") } catch {}
invalidCheckpoint = checkpoint; invalidCheckpoint.status = "anything"
do { _ = try mergeTaskCheckpoints([], [invalidCheckpoint]); fatalError("Invalid task state accepted") } catch {}
print("Task presentation passed: waiting permission, queued versus delivered, revision scope and valid resumable states")
