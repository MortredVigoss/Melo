import SwiftUI

struct EditStatus: View {
    let editing: Bool
    let dirty: Bool
    let saving: Bool
    let saved: Bool
    let error: String?
    var color: Color { error != nil ? .red : saving ? .blue : saved && !editing ? .green : dirty ? meloGold : .secondary }
    var body: some View {
        Label(error.map { "未保存 · \($0)" } ?? (saving ? "正在保存…" : saved && !editing ? "已保存" : editing ? (dirty ? "有未保存的修改" : "尚未修改") : "只读 · 点编辑后修改"), systemImage: error != nil ? "exclamationmark.circle" : saved && !editing ? "checkmark.circle.fill" : editing ? "pencil.circle" : "lock")
            .font(.caption).foregroundStyle(color).accessibilityAddTraits(.updatesFrequently)
    }
}

/// A settings card owns a local draft; only the explicit Save action calls commit.
struct EditableSection<Value: Equatable & Codable, Fields: View>: View {
    let title: String
    let secureDraft: Bool
    let read: () -> Value
    let commit: (Value) async throws -> Value
    let fields: (Binding<Value>, Bool) -> Fields
    @State private var edit: EditDraft<Value>
    @State private var discard = false
    @State private var draftError: String?
    init(_ title: String, secureDraft: Bool = false, read: @escaping () -> Value, commit: @escaping (Value) async throws -> Value, @ViewBuilder fields: @escaping (Binding<Value>, Bool) -> Fields) {
        self.title = title; self.read = read; self.commit = commit; self.fields = fields
        self.secureDraft = secureDraft
        do {
            var restored = try EditDraftStorage.shared.restore(EditDraft<Value>.self, key: title, secure: secureDraft) ?? EditDraft(read())
            restored.resume(); _edit = State(initialValue: restored)
        } catch {
            _edit = State(initialValue: EditDraft(read()))
            _draftError = State(initialValue: "无法恢复上次草稿，已保存设置未改变。")
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(LocalizedStringKey(title)).font(.headline); Spacer()
                if edit.editing {
                    Button("取消") { if edit.dirty { discard = true } else { edit.cancel() } }.disabled(edit.saving)
                    Button(edit.saving ? "保存中…" : edit.error == nil ? "保存" : "重试保存") { save() }
                        .buttonStyle(.borderedProminent).tint(edit.saving ? .blue : edit.canSave ? meloGold : .gray)
                        .foregroundStyle(.black).disabled(!edit.canSave)
                } else { Button("编辑") { edit.begin(read()) }.tint(meloGold) }
            }.font(.subheadline)
            EditStatus(editing: edit.editing, dirty: edit.dirty, saving: edit.saving, saved: edit.saved, error: edit.error)
            if edit.hasConflict {
                Text("未修改的字段跟随最新值；同一字段有冲突时保留你的修改。合并后请检查并保存。").font(.caption).foregroundStyle(.secondary)
                Button("合并最新内容，保留我的修改") { edit.rebase(current: read()); preserveDraft() }
            }
            if let draftError { Text(draftError).font(.caption).foregroundStyle(.red) }
            fields(Binding(get: { edit.value }, set: { if edit.editing && !edit.saving { edit.value = $0 } }), edit.editing)
                .disabled(!edit.editing || edit.saving)
        }.onAppear { edit.refresh(read()) }
        .onChange(of: edit) { _, _ in preserveDraft() }
        .onDisappear { preserveDraft() }
        .confirmationDialog("放弃未保存的修改？", isPresented: $discard, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) { edit.cancel(); edit.refresh(read()) }
            Button("继续编辑", role: .cancel) {}
        }
    }
    private func save() {
        guard edit.start(current: read()) else { return }
        let value = edit.value
        Task { do { let persisted = try await commit(value); edit.finish(persisted) } catch { edit.fail(error.localizedDescription) }; preserveDraft() }
    }
    private func preserveDraft() {
        do {
            if edit.editing && edit.dirty { try EditDraftStorage.shared.save(edit, key: title, secure: secureDraft) }
            else { try EditDraftStorage.shared.remove(key: title, secure: secureDraft) }
            draftError = nil
        } catch { draftError = "草稿暂时只保留在本次运行中，请勿退出；可继续编辑或重试保存。" }
    }
}
