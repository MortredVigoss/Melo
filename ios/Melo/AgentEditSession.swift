import Foundation

/// A draft never mutates the saved role until persistence succeeds.
struct AgentEditSession: Codable, Equatable {
    private(set) var original: AgentProfile
    var draft: AgentProfile
    private(set) var isEditing: Bool
    private(set) var isNew: Bool
    private(set) var didSave = false
    private(set) var error: String?
    private(set) var conflict: Bool?
    var hasConflict: Bool { conflict == true }

    init(agent: AgentProfile, isNew: Bool = false) {
        original = agent; draft = agent; self.isNew = isNew; isEditing = isNew
    }
    var hasChanges: Bool { draft != original }
    var needsDiscardConfirmation: Bool { isEditing && hasChanges }
    var canSave: Bool {
        isEditing && (isNew || hasChanges)
        && !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    mutating func begin(current: AgentProfile) {
        original = current; draft = current; isEditing = true; didSave = false; error = nil; conflict = nil
    }
    mutating func cancel() {
        draft = original; isEditing = false; error = nil; conflict = nil
    }
    mutating func refresh(_ current: AgentProfile) {
        guard !isEditing else { return }
        original = current; draft = current
    }
    mutating func rebase(current: AgentProfile) {
        guard isEditing, current.id == original.id else { return }
        do {
            draft = try DraftMerge.rebase(draft, original: original, current: current)
            original = current; conflict = nil; error = nil; didSave = false
        } catch { self.error = "无法合并，草稿仍已保留。" }
    }
    mutating func keepAsNew() {
        guard isEditing, hasConflict else { return }
        draft.id = UUID().uuidString; original = draft; isNew = true; conflict = nil; error = nil
    }
    @discardableResult mutating func save(current: AgentProfile?, persist: (AgentProfile) -> Bool) -> Bool {
        guard canSave else { return false }
        guard isNew ? current == nil : current == original else {
            conflict = true
            error = current == nil ? "Agent已删除，草稿已保留，可存为新Agent。" : "Agent已在其他地方更新。可合并最新内容后检查并保存，草稿不会丢失。"
            return false
        }
        guard persist(draft) else {
            error = "保存失败，修改仍在这里，请重试。"
            return false
        }
        original = draft; isNew = false; isEditing = false; didSave = true; error = nil; conflict = nil
        return true
    }
}

struct ConversationDraft: Codable, Equatable {
    var text = ""
    var imagePlan = ImageTaskPlan()
}
