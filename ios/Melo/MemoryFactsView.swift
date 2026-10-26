import SwiftUI

struct MemoryFactsView: View {
    @EnvironmentObject var store: ChatStore
    @State private var query = ""
    @State private var showInactive = false
    @State private var selected: MobileMemoryFact?
    private var facts: [MobileMemoryFact] {
        (store.preferences.memoryFacts ?? []).filter { ($0.effectiveStatus != "active") == showInactive && (query.isEmpty || ($0.text + $0.sourceText).localizedCaseInsensitiveContains(query)) }.sorted { $0.updatedAt > $1.updatedAt }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("长期记忆").font(.title3)
            Text("沿用桌面的事实提取规则。自动记忆默认仅用于原对话；跨对话共享需明确修改范围，停用或删除来源对话后不再用于回复，已共享的记忆也适用。").font(.caption).foregroundStyle(.secondary)
            TextField("搜索记忆或来源", text: $query).meloInput()
            Toggle("查看停用与历史记忆", isOn: $showInactive)
            if facts.isEmpty { Text("这里还没有记忆。新对话中的偏好和明确决定会保留来源；已有知识不会被伪造为个人记忆。").font(.subheadline).foregroundStyle(.secondary).padding(.vertical) }
            ForEach(facts) { fact in
                Button { selected = fact } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(fact.text).foregroundStyle(MeloTheme.text)
                        Text("\(scopeName(fact.scope)) · \(statusName(fact.effectiveStatus))").font(.caption).foregroundStyle(meloGold)
                        Text(sourceName(fact)).font(.caption2).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(14).background(MeloTheme.inset, in: RoundedRectangle(cornerRadius: 16))
                }.buttonStyle(.plain)
            }
            Text(store.preferences.memorySemanticLastUsed == true ? "最近召回：系统本机语义模型 + 关键词；无需外部服务。" : "未使用系统语义模型时按关键词召回；语言模型不可用不会联网下载或阻断对话。").font(.caption2).foregroundStyle(.secondary)
            let receipts = (store.preferences.memoryUsage ?? [:]).filter { !$0.value.isEmpty }.sorted { $0.key < $1.key }
            if !receipts.isEmpty {
                DisclosureGroup("已用于回复的记忆（当时内容）") {
                    ForEach(store.chats.flatMap(\.messages).filter { store.preferences.memoryUsage?[$0.id]?.isEmpty == false }.suffix(10).reversed()) { message in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(message.content).lineLimit(2).font(.caption)
                            ForEach(store.preferences.memoryUsage?[message.id] ?? []) { used in Text(used.text).font(.caption2).foregroundStyle(.secondary) }
                        }.padding(.vertical, 8)
                    }
                }
            }
        }.sheet(item: $selected) { fact in
            EditableDocument("记忆详情", value: fact, isNew: false, read: { store.preferences.memoryFacts?.first { $0.id == fact.id } }, commit: { value in
                var value = try value.validated()
                guard value.mergedInto?.isEmpty != false else { throw MeloError.message("此记录已合并到另一条记忆，请修改合并后的记录。") }
                guard value.isProjectSource ? (store.preferences.projects ?? []).contains(where: { $0.id == value.projectId }) : store.chats.contains(where: { $0.id == value.chatId }) else { throw MeloError.message("来源对话已删除或尚未同步，不能恢复或扩大共享范围。") }
                guard !(store.preferences.workspaceSync?.conflicts.contains { $0.kind == "memory" && $0.id == value.id } ?? false), !(store.preferences.projectMemorySync?.conflicts.contains { $0.id == value.id } ?? false) else { throw MeloError.message("记忆存在同步冲突，请先在系统页选择版本。") }
                let prior = store.preferences.memoryFacts?.first { $0.id == value.id }
                value.userEdited = true; value.updatedAt = timestamp()
                if value.status != prior?.status {
                    value.validTo = value.status == "active" ? nil : value.updatedAt
                }
                guard store.updatePreferences({ p in if let index = p.memoryFacts?.firstIndex(where: { $0.id == value.id }) { p.memoryFacts?[index] = value } }, reportFailure: false) else { throw MeloError.message("保存失败，修改已保留。") }
                return value
            }) { value in
                if fact.mergedInto?.isEmpty == false { Text("此记录已合并，仅保留来源供查阅，不再用于回复。请修改合并后的记忆。").font(.caption).foregroundStyle(.secondary) }
                Section("记忆内容") { TextEditor(text: value.text).frame(minHeight: 140) }.disabled(fact.mergedInto?.isEmpty == false)
                Section("用于哪些对话") {
                    Picker("共享范围", selection: value.scope) {
                        if !fact.isProjectSource { Text("仅原对话").tag("chat") }
                        if !fact.projectId.isEmpty { Text("同项目").tag("project") }
                        Text("同Agent").tag("agent"); Text("我的全部本机对话").tag("personal")
                    }
                    Picker("状态", selection: value.status) { Text("启用").tag("active"); Text("停用").tag("forgotten"); if !["active","forgotten"].contains(fact.status) { Text(statusName(fact.effectiveStatus)).tag(fact.status) } }
                }
                .disabled(fact.mergedInto?.isEmpty == false)
                if fact.scope == "project" {
                    Section("项目记忆本") {
                        Picker("类别", selection: Binding(get: { value.wrappedValue.section ?? "convention" }, set: { value.wrappedValue.section = $0 })) {
                            ForEach(MobileMemoryFact.bookSections, id: \.self) { section in Text(["goal":"目标", "convention":"约定", "decision":"决定", "progress":"进展", "todo":"待办", "file":"文件"][section] ?? section).tag(section) }
                        }
                    }
                }
                Section("原始来源") {
                    Text(sourceName(fact))
                    Text(fact.sourceText).textSelection(.enabled).font(.subheadline)
                    Text("\(fact.category) · \(fact.updatedAt)").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    private func sourceName(_ fact: MobileMemoryFact) -> String {
        if fact.isProjectSource { return "项目 · " + ((store.preferences.projects ?? []).first { $0.id == fact.projectId }?.name ?? "来源项目未同步") }
        return store.chats.first { $0.id == fact.chatId }?.title ?? "来源对话已删除或未同步"
    }
    private func scopeName(_ scope: String) -> String { ["chat":"原对话", "project":"同项目", "agent":"同Agent", "personal":"本机共享"][scope] ?? "原对话" }
    private func statusName(_ status: String) -> String { ["active":"启用", "forgotten":"停用", "historical":"历史", "unconfirmed":"待确认"][status] ?? status }
}
