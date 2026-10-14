import SwiftUI

struct HistoryView: View {
    @EnvironmentObject var store: ChatStore
    var selectedID: String? = nil
    let open: (String) -> Void
    @State private var search = ""
    @State private var filter = 0
    @State private var renameID: String?
    @State private var deleteID: String?
    @State private var title = ""
    @FocusState private var searchFocused: Bool
    private var filtered: [Conversation] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.chats.filter { chat in
            let archived = store.preferences.archivedChats.contains(chat.id)
            let matches = filter == 2 ? archived : !archived && (filter != 1 || store.preferences.pinnedChats.contains(chat.id))
            return matches && (query.isEmpty || chat.title.localizedCaseInsensitiveContains(query) || chat.messages.contains { $0.content.localizedCaseInsensitiveContains(query) })
        }.sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
    }
    private func dateGroup(_ value: String) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "更早" }
        if Calendar.current.isDateInToday(date) { return "今天" }
        if Calendar.current.isDateInYesterday(date) { return "昨天" }
        return date > Date().addingTimeInterval(-7 * 86400) ? "近七天" : "更早"
    }
    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Text("对话记录").font(.title3.weight(.medium)); Spacer()
                Button { searchFocused = false; if let id = store.newChat() { open(id) } } label: { Label("新对话", systemImage: "square.and.pencil").font(.subheadline).frame(minHeight: 44) }.accessibilityIdentifier("history.new")
            }
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索标题或内容", text: $search).font(.subheadline).focused($searchFocused).submitLabel(.search).onSubmit { searchFocused = false }.accessibilityIdentifier("history.search")
                if !search.isEmpty { Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.accessibilityLabel("清除搜索") }
                if searchFocused { Button("完成") { searchFocused = false }.font(.caption) }
            }.padding(12).background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
            Picker("对话筛选", selection: $filter) { Text("全部").tag(0); Text("已置顶").tag(1); Text("已归档").tag(2) }.pickerStyle(.segmented)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if filtered.isEmpty { ContentUnavailableView(search.isEmpty ? "这里还没有对话" : "没有匹配的对话", systemImage: "bubble.left.and.text.bubble.right", description: Text("新建对话，或调整搜索与筛选。")) }
                    ForEach(Array(filtered.enumerated()), id: \.element.id) { index, chat in
                        if index == 0 || dateGroup(filtered[index - 1].updatedAt) != dateGroup(chat.updatedAt) { Text(dateGroup(chat.updatedAt)).font(.caption.weight(.medium)).foregroundStyle(meloGold).padding(.top, 8) }
                        row(chat)
                    }
                }.padding(.vertical, 4)
            }.scrollDismissesKeyboard(.interactively).refreshable { await store.sync() }
                .simultaneousGesture(TapGesture().onEnded { searchFocused = false })
            HStack {
                Text("\(filtered.count) 段对话 · 按最近更新排序").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button { searchFocused = false; Task { await store.sync() } } label: { Label(store.syncing ? "同步中" : "同步", systemImage: "arrow.triangle.2.circlepath").font(.caption).frame(minHeight: 40) }.disabled(store.syncing)
            }
            Text(store.syncStatus).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(.horizontal, 16).padding(.bottom, 12)
        .alert("重命名对话", isPresented: Binding(get: { renameID != nil }, set: { if !$0 { renameID = nil } })) {
            TextField("标题", text: $title)
            Button("保存") { if let id = renameID { store.rename(id, to: title) }; renameID = nil }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("取消", role: .cancel) { renameID = nil }
        }
        .alert("删除这段对话？", isPresented: Binding(get: { deleteID != nil }, set: { if !$0 { deleteID = nil } })) {
            Button("删除", role: .destructive) { if let id = deleteID, store.deleteConversation(id) { store.composerDrafts[id] = nil }; deleteID = nil }
            Button("取消", role: .cancel) { deleteID = nil }
        } message: { Text("同步后也会从其他设备删除，无法撤销。仅想从列表收起时，请使用归档。") }
    }
    private func row(_ chat: Conversation) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 4) {
                Button { searchFocused = false; open(chat.id) } label: {
                    ConversationRow(chat: chat, agent: store.agent(for: chat.id), pinned: store.preferences.pinnedChats.contains(chat.id))
                }.buttonStyle(.plain).accessibilityAddTraits(chat.id == selectedID ? .isSelected : [])
                    .accessibilityIdentifier("history.chat.\(chat.id)")
                Menu { actions(chat) } label: { Image(systemName: "ellipsis").frame(width: 40, height: 44) }.accessibilityLabel("\(chat.title)的操作")
            }
            HStack(spacing: 12) {
                if chat.id == selectedID { Label("当前对话", systemImage: "checkmark.circle.fill").foregroundStyle(meloAccent) }
                if let draft = store.composerDrafts[chat.id], !draft.text.isEmpty || !draft.imagePlan.references.isEmpty { Label("草稿", systemImage: "pencil").foregroundStyle(meloGold) }
            }.font(.caption2).padding(.horizontal, 12).padding(.bottom, chat.id == selectedID ? 8 : 0)
        }.background(chat.id == selectedID ? meloAccent.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 16))
            .overlay { RoundedRectangle(cornerRadius: 16).stroke(chat.id == selectedID ? meloAccent.opacity(0.35) : .clear, lineWidth: 1) }
            .contextMenu { actions(chat) }
    }
    @ViewBuilder private func actions(_ chat: Conversation) -> some View {
        Button("重命名", systemImage: "pencil") { searchFocused = false; renameID = chat.id; title = chat.title }
        Button(store.preferences.pinnedChats.contains(chat.id) ? "取消置顶" : "置顶", systemImage: "pin") { store.updatePreferences { if $0.pinnedChats.contains(chat.id) { $0.pinnedChats.remove(chat.id) } else { $0.pinnedChats.insert(chat.id) } } }
        Button(store.preferences.archivedChats.contains(chat.id) ? "取消归档" : "归档", systemImage: "archivebox") { store.updatePreferences { if $0.archivedChats.contains(chat.id) { $0.archivedChats.remove(chat.id) } else { $0.archivedChats.insert(chat.id) } } }
        Button("删除对话", systemImage: "trash", role: .destructive) { searchFocused = false; deleteID = chat.id }.disabled(store.sendingID == chat.id)
    }
}
