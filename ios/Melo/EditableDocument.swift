import SwiftUI

struct EditableDocument<Value: Equatable & Codable, Fields: View>: View {
    let title: String
    let read: () -> Value?
    let commit: (Value) throws -> Value
    let fields: (Binding<Value>) -> Fields
    @Environment(\.dismiss) private var dismiss
    @State private var edit: EditDraft<Value>
    @State private var isNew: Bool
    @State private var discard = false
    @FocusState private var focused: Bool
    private var canSave: Bool { edit.editing && !edit.saving && (isNew || edit.dirty) }
    init(_ title: String, value: Value, isNew: Bool, read: @escaping () -> Value?, commit: @escaping (Value) throws -> Value, @ViewBuilder fields: @escaping (Binding<Value>) -> Fields) {
        self.title = title; self.read = read; self.commit = commit; self.fields = fields
        var draft = EditDraft(value); if isNew { draft.begin(value) }
        _edit = State(initialValue: draft); _isNew = State(initialValue: isNew)
    }
    var body: some View {
        NavigationStack {
            MeloForm {
                EditStatus(editing: edit.editing, dirty: edit.dirty, saving: edit.saving, saved: edit.saved, error: edit.error)
                if edit.hasConflict, let current = read() {
                    Text("合并后保留你的修改，未修改的字段跟随最新值。请检查后再保存。").font(.caption)
                    Button("合并最新内容，保留我的修改") { edit.rebase(current: current) }
                }
                fields(Binding(get: { edit.value }, set: { if edit.editing { edit.value = $0 } })).disabled(!edit.editing).focused($focused)
            }.scrollDismissesKeyboard(.interactively)
                .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(edit.editing ? "取消" : "完成") {
                            focused = false
                            if edit.editing && edit.dirty { discard = true }
                            else if edit.editing && !isNew { edit.cancel(); if let value = read() { edit.refresh(value) } }
                            else { dismiss() }
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if edit.editing {
                            Button("保存") { save() }.buttonStyle(.borderedProminent).tint(canSave ? meloGold : .gray).foregroundStyle(.black).disabled(!canSave)
                        } else { Button("编辑") { if let value = read() { edit.begin(value) } else { edit.fail("这项知识已不存在。") } } }
                    }
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("收起键盘") { focused = false } }
                }
                .confirmationDialog("放弃未保存的修改？", isPresented: $discard, titleVisibility: .visible) {
                    Button("放弃修改", role: .destructive) { if isNew { dismiss() } else { edit.cancel(); if let value = read() { edit.refresh(value) } } }
                    Button("继续编辑", role: .cancel) {}
                }
        }.interactiveDismissDisabled(edit.editing && edit.dirty).presentationBackground(MeloTheme.dialog)
    }
    private func save() {
        focused = false
        guard isNew ? read() == nil : read() == edit.original else { edit.markConflict(); return }
        guard edit.start(current: edit.original, allowUnchanged: isNew) else { return }
        do { edit.finish(try commit(edit.value)); isNew = false } catch { edit.fail(error.localizedDescription) }
    }
}
