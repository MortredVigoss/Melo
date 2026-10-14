import Foundation

/// Shared with the desktop's edit/save contract: the draft is never the stored value.
struct EditDraft<Value: Equatable>: Equatable {
    private(set) var original: Value
    var value: Value
    private(set) var editing = false
    private(set) var saving = false
    private(set) var saved = false
    private(set) var error: String?
    private(set) var conflict: Bool?
    var hasConflict: Bool { conflict == true }
    private(set) var revision = 0
    init(_ value: Value) { original = value; self.value = value }
    var dirty: Bool { value != original }
    var canSave: Bool { editing && !saving && dirty }
    mutating func begin(_ current: Value) {
        guard !saving else { return }; revision += 1
        original = current; value = current; editing = true; saved = false; error = nil; conflict = nil
    }
    mutating func cancel() {
        guard !saving else { return }; revision += 1
        value = original; editing = false; error = nil; conflict = nil
    }
    mutating func start(current: Value, allowUnchanged: Bool = false) -> Bool {
        guard canSave || (allowUnchanged && editing && !saving) else { return false }
        guard current == original else { markConflict(); return false }
        saving = true; error = nil; conflict = nil; return true
    }
    mutating func finish(_ persisted: Value) {
        original = persisted; value = persisted; saving = false; editing = false; saved = true; error = nil; conflict = nil; revision += 1
    }
    mutating func fail(_ message: String) { saving = false; error = message; conflict = nil }
    mutating func markConflict() {
        saving = false; conflict = true
        error = "内容已在其他地方更新。草稿已保留，可合并最新内容后检查并保存。"
    }
    mutating func rebase(current: Value) where Value: Codable {
        guard editing && !saving else { return }
        do {
            value = try DraftMerge.rebase(value, original: original, current: current)
            original = current; conflict = nil; error = nil; saved = false; revision += 1
        } catch { fail("无法合并，草稿仍已保留。") }
    }
    mutating func refresh(_ current: Value) { if !editing && !saving && current != original { original = current; value = current; saved = false } }
    mutating func resume() {
        if saving { saving = false; error = "上次保存未确认完成，请核对后重试。" }
    }
}

extension EditDraft: Codable where Value: Codable {}
