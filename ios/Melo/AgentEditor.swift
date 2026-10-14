import SwiftUI

struct AgentEditor: View {
    @EnvironmentObject var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @State private var session: AgentEditSession
    private let draftKey: String
    @State private var draftError: String?
    @State private var confirmDiscard = false
    @FocusState private var fieldFocused: Bool

    init(agent: AgentProfile, isNew: Bool = false) {
        draftKey = isNew ? "newRole" : "role-" + agent.id
        do {
            _session = State(initialValue: try EditDraftStorage.shared.restore(AgentEditSession.self, key: draftKey) ?? AgentEditSession(agent: agent, isNew: isNew))
        } catch {
            _session = State(initialValue: AgentEditSession(agent: agent, isNew: isNew))
            _draftError = State(initialValue: "无法恢复上次草稿，已保存角色未改变。")
        }
    }
    private var current: AgentProfile? { store.preferences.agents.first { $0.id == session.draft.id } }
    private var draft: Binding<AgentProfile> {
        Binding(get: { session.draft }, set: { if session.isEditing { session.draft = $0 } })
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(statusText, systemImage: statusIcon)
                        .font(.subheadline.weight(.medium)).foregroundStyle(statusColor)
                        .accessibilityIdentifier("role.status")
                    if let error = session.error { Text(error).font(.caption).foregroundStyle(.red) }
                    if session.hasConflict {
                        if let current {
                            Text("未修改的字段跟随最新值；同一字段有冲突时保留你的修改。合并后请检查并保存。").font(.caption).foregroundStyle(.secondary)
                            Button("合并最新内容，保留我的修改") { session.rebase(current: current); _ = preserveDraft() }.accessibilityIdentifier("role.mergeDraft")
                        } else {
                            Button("保留草稿，改为创建新角色") { session.keepAsNew(); _ = preserveDraft() }
                        }
                    }
                    if let draftError { Text(draftError).font(.caption).foregroundStyle(.red) }
                    if session.needsDiscardConfirmation || session.isNew {
                        Button("暂存草稿并关闭") { fieldFocused = false; if preserveDraft() { dismiss() } }
                            .accessibilityIdentifier("role.keepDraft")
                    }
                }
                if session.isEditing { editableFields } else { details }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(session.isNew ? "创建角色" : "角色详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(session.isEditing ? "取消" : "完成") {
                        fieldFocused = false
                        if session.needsDiscardConfirmation || session.isNew { confirmDiscard = true }
                        else if session.isEditing && !session.isNew { session.cancel() }
                        else { dismiss() }
                    }.accessibilityIdentifier("role.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if session.isEditing {
                        Button { save() } label: { Text("保存").fontWeight(.semibold) }
                            .buttonStyle(.borderedProminent).tint(session.canSave ? meloAccent : .gray)
                            .disabled(!session.canSave).accessibilityIdentifier("role.save")
                    } else {
                        Button { if let current { session.begin(current: current) } } label: { Text("编辑") }
                            .tint(meloAccent).accessibilityIdentifier("role.edit")
                    }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer(); Button("收起键盘", systemImage: "keyboard.chevron.compact.down") { fieldFocused = false }
                }
            }
            .confirmationDialog("放弃未保存的修改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("放弃修改", role: .destructive) {
                    let wasNew = session.isNew
                    session.cancel(); _ = preserveDraft()
                    if wasNew { dismiss() } else if let current { session.refresh(current) }
                }
                Button("继续编辑", role: .cancel) {}
            } message: { Text("已保存的角色不会改变。") }
        }
        .interactiveDismissDisabled(session.needsDiscardConfirmation)
        .onChange(of: current) { _, value in if let value { session.refresh(value) } }
        .onChange(of: session) { _, _ in _ = preserveDraft() }
        .onDisappear { _ = preserveDraft() }
    }
    @ViewBuilder private var details: some View {
        Section {
            HStack(spacing: 16) { AgentAvatar(agent: session.draft, size: 64); VStack(alignment: .leading, spacing: 6) { Text(session.draft.name).font(.title3.weight(.semibold)); Text(session.draft.subtitle.isEmpty ? "未填写介绍" : session.draft.subtitle).foregroundStyle(.secondary) } }
        }
        Section("思考与回复方式") { Text(session.draft.instructions).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        if [session.draft.identity, session.draft.soul, session.draft.systemPrompt, session.draft.mood, session.draft.model].contains(where: { $0?.isEmpty == false }) {
            Section("更多角色设定") {
                detail("身份", session.draft.identity); detail("性格", session.draft.soul)
                detail("系统要求", session.draft.systemPrompt); detail("语气", session.draft.mood); detail("默认模型", session.draft.model)
            }
        }
    }
    @ViewBuilder private func detail(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty { VStack(alignment: .leading, spacing: 6) { Text(title).font(.caption).foregroundStyle(.secondary); Text(value).textSelection(.enabled) } }
    }
    @ViewBuilder private var editableFields: some View {
        Section("头像") { AvatarPicker(agent: draft) }
        Section("角色身份") {
            TextField("角色名称", text: draft.name).focused($fieldFocused).accessibilityIdentifier("role.name")
            TextField("一句话介绍", text: draft.subtitle).focused($fieldFocused)
        }
        Section("思考与回复方式") {
            TextEditor(text: draft.instructions).frame(minHeight: 180).focused($fieldFocused).accessibilityIdentifier("role.instructions")
            Text("保存后，对已绑定此角色的对话下一轮生效。").font(.caption).foregroundStyle(.secondary)
        }
        Section("高级角色设定") {
            TextField("身份", text: optional(\.identity), axis: .vertical).lineLimit(2...5)
            TextField("性格与风格", text: optional(\.soul), axis: .vertical).lineLimit(2...6)
            TextField("系统要求", text: optional(\.systemPrompt), axis: .vertical).lineLimit(2...6)
            TextField("语气", text: optional(\.mood))
            TextField("默认模型 ID（留空沿用系统）", text: optional(\.model)).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
        Section("图标") {
            Picker("选择图标", selection: draft.symbol) {
                ForEach(Array(Set(["sparkles", "pencil.line", "chart.xyaxis.line", "person.crop.square", "book", "lightbulb", session.draft.symbol])).sorted(), id: \.self) { Image(systemName: $0).tag($0) }
            }.pickerStyle(.segmented)
        }
    }
    private func optional(_ key: WritableKeyPath<AgentProfile, String?>) -> Binding<String> {
        Binding(get: { session.draft[keyPath: key] ?? "" }, set: { if session.isEditing { session.draft[keyPath: key] = $0 } })
    }
    private var statusText: String {
        if session.error != nil { return "未保存 · 请处理后重试" }
        if !session.isEditing { return session.didSave ? "已保存" : "查看模式 · 点编辑后修改" }
        return session.hasChanges || session.isNew ? "有未保存的修改" : "尚未修改"
    }
    private var statusIcon: String { session.error != nil ? "exclamationmark.circle" : session.isEditing ? "pencil.circle" : session.didSave ? "checkmark.circle.fill" : "lock" }
    private var statusColor: Color { session.error != nil ? .red : session.isEditing ? (session.hasChanges || session.isNew ? meloGold : .secondary) : session.didSave ? .green : .secondary }
    private func save() {
        fieldFocused = false
        session.save(current: current) { value in
            store.updatePreferences({ preferences in
                if let index = preferences.agents.firstIndex(where: { $0.id == value.id }) { preferences.agents[index] = value }
                else { preferences.agents.append(value) }
            }, reportFailure: false)
        }
    }
    @discardableResult private func preserveDraft() -> Bool {
        do {
            if session.isEditing && (session.needsDiscardConfirmation || session.isNew) { try EditDraftStorage.shared.save(session, key: draftKey) }
            else { try EditDraftStorage.shared.remove(key: draftKey) }
            draftError = nil; return true
        } catch { draftError = "草稿尚未写入本机，请保持编辑页面并重试。"; return false }
    }
}
