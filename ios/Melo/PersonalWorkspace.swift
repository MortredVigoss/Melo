import SwiftUI
import UniformTypeIdentifiers

struct ProjectsView: View {
    @EnvironmentObject var store: ChatStore
    let open: (String) -> Void
    @State private var editing: PersonalProject?
    @State private var tasks = false
    @State private var showArchived = false
    @State private var showDeleted = false
    @State private var deleting: PersonalProject?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeading(eyebrow: "PROJECTS", title: "项目", detail: "把同一个目标的对话放在一起，后续讨论继续沿用项目目标。")
                Button { editing = PersonalProject(name: "", goal: "") } label: { Label("新建项目", systemImage: "plus").frame(maxWidth: .infinity).padding(15) }.buttonStyle(.bordered)
                Toggle("查看已归档项目", isOn: $showArchived).font(.caption)
                Toggle("已删除项目", isOn: $showDeleted).font(.caption)
                if (store.preferences.projects ?? []).isEmpty { Text("例如：旅行计划、学习一门语言、开发一个产品。项目不是另一种 Agent，而是一组相关工作的容器。").font(.subheadline).foregroundStyle(.secondary).meloPanel() }
                ForEach((store.preferences.projects ?? []).filter { showDeleted ? $0.deletedAt != nil : $0.deletedAt == nil && ($0.archived == true) == showArchived }) { project in
                    VStack(alignment: .leading, spacing: 14) {
                        HStack { Text(project.name).font(.title3); Spacer(); if project.deletedAt == nil { Button("查看") { editing = project }.font(.caption) } }
                        if !project.contextGoal.isEmpty { Text(project.contextGoal).font(.subheadline).foregroundStyle(.secondary) }
                        let chats = store.chats.filter { store.preferences.chatProjects?[$0.id] == project.id }
                        Text("\(chats.count) 段对话 · \(project.knowledgeIds?.count ?? 0) 份共享知识\(project.archived == true ? " · " + CapabilityCopy.localized("已归档") : "")").font(.caption).foregroundStyle(meloGold)
                        ForEach(chats) { chat in Button { open(chat.id) } label: { Label(chat.title, systemImage: "bubble.left").font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 5) } }
                        if project.archived != true { Button { if let id = store.newChat(projectID: project.id) { open(id) } } label: { Label("在项目中开始对话", systemImage: "plus.bubble") }.font(.subheadline) }
                        if project.deletedAt != nil {
                            Text("项目已删除；对话、知识、图片和原文件夹保留。").font(.caption)
                            Text("原项目记忆保留在旧范围，旧审批不会恢复。").font(.caption)
                            Button("恢复为新项目") { store.restoreProject(project.id) }.font(.caption)
                        } else {
                        Button("删除项目", role: .destructive) { deleting = project }.font(.caption)
                        Button(LocalizedStringKey(project.archived == true ? "恢复项目" : "归档项目")) { store.updatePreferences { p in if let index = p.projects?.firstIndex(where: { $0.id == project.id }) { p.projects?[index].archived = project.archived != true } } }.font(.caption)
                        }
                    }.meloPanel()
                }
                DisclosureGroup("桌面任务与接力（\(store.taskCheckpoints.count)）", isExpanded: $tasks) {
                    TaskHandoffView(open: open).frame(minHeight: 280, maxHeight: 500)
                }.font(.subheadline).meloPanel()
                Text("归档保留对话与知识，可随时恢复。配置同步服务后，项目与共享知识会一起同步。").font(.caption).foregroundStyle(.secondary)
            }.padding(20)
        }.sheet(item: $editing) { project in ProjectEditor(project: project) }
        .confirmationDialog("确认删除项目", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("确认删除项目", role: .destructive) { if let project = deleting { store.deleteProject(project.id) }; deleting = nil }
            Button("取消", role: .cancel) { deleting = nil }
        } message: { Text("对话将解除项目归属，知识、图片与外部文件夹保留；项目记忆隔离保存，待审批失效。") }
    }
}
struct ProjectEditor: View {
    @EnvironmentObject var store: ChatStore
    let project: PersonalProject
    var body: some View {
        EditableDocument("项目设置", value: project, isNew: store.preferences.projects?.contains { $0.id == project.id } != true, read: { store.preferences.projects?.first { $0.id == project.id } }, commit: { value in
            guard store.preferences.projects?.first(where: { $0.id == value.id })?.deletedAt == nil else { throw MeloError.message("项目已删除，请从删除记录恢复。") }
            guard !value.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.goal.count <= 12000, (value.instructions?.count ?? 0) <= 12000 else { throw MeloError.message("请填写项目名称，目标与要求各不超过 12000 字。") }
            guard store.updatePreferences({ p in var items = p.projects ?? []; if let i = items.firstIndex(where: { $0.id == value.id }) { items[i] = value } else { items.append(value) }; p.projects = items }, reportFailure: false) else { throw MeloError.message("保存失败，草稿已保留。") }
            return value
        }) { value in
            TextField("项目名称", text: value.name)
            Section("目标与背景") { TextEditor(text: value.goal).frame(minHeight: 140) }
            Section("项目要求") { TextEditor(text: Binding(get: { value.wrappedValue.instructions ?? "" }, set: { value.wrappedValue.instructions = $0 })).frame(minHeight: 120) }
            Section("项目共享知识") {
                ForEach((store.preferences.knowledge ?? []).filter { $0.deleted != true && $0.kind != "result" }) { note in
                    Toggle(note.title, isOn: Binding(get: { value.wrappedValue.knowledgeIds?.contains(note.id) == true }, set: { enabled in
                        var ids = value.wrappedValue.knowledgeIds ?? []; if enabled { ids.insert(note.id) } else { ids.remove(note.id) }; value.wrappedValue.knowledgeIds = ids
                    }))
                }
                Text("知识按问题与上下文预算选取相关片段，全文保留。").font(.caption)
            }
        }
    }
}
struct KnowledgeView: View {
    @EnvironmentObject var store: ChatStore
    @State private var editing: KnowledgeNote?
    @State private var query = ""
    @State private var tab = 0
    @State private var importing = false
    @State private var showDeleted = false
    private var notes: [KnowledgeNote] { KnowledgeCollection.items(store.preferences.knowledge ?? [], results: tab == 2, deleted: showDeleted, query: query) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PageHeading(eyebrow: "KNOWLEDGE", title: InterfaceTerm.knowledge.key, detail: "保存反复用到的背景、要求和参考文字，在对话里主动选用。")
                Picker("知识分类", selection: $tab) { Text(LocalizedStringKey(InterfaceTerm.knowledge.key)).tag(0); Text("记忆").tag(1); Text(LocalizedStringKey(InterfaceTerm.artifacts.key)).tag(2) }.pickerStyle(.segmented).accessibilityIdentifier("knowledge.category")
                if tab == 1 { MemoryFactsView() } else {
                if tab == 0 { HStack { Button { editing = KnowledgeNote(title: "", content: "") } label: { Label("添加知识", systemImage: "plus") }; Spacer(); Button("导入文件") { importing = true } }.font(.subheadline).padding(.vertical, 8) }
                TextField(tab == 2 ? "搜索成果" : "搜索知识", text: $query).meloInput()
                Toggle(tab == 2 ? "查看已删除成果" : "查看已删除知识", isOn: $showDeleted).font(.caption)
                if notes.isEmpty { Text(LocalizedStringKey(query.isEmpty ? (tab == 2 ? "同步后的成果会显示在这里，不会自动用作知识。" : "把个人偏好、工作规范、产品说明或学习笔记保存在这里。之后在对话的“项目与知识”中选择，模型才能使用。") : "没有匹配的知识。")).font(.subheadline).foregroundStyle(.secondary).meloPanel() }
                ForEach(notes) { note in
                    VStack(alignment: .leading, spacing: 10) {
                        Button { editing = note } label: { VStack(alignment: .leading, spacing: 9) { Text(note.title).font(.headline); Text(note.content).font(.subheadline).foregroundStyle(.secondary).lineLimit(3) }.frame(maxWidth: .infinity, alignment: .leading) }.buttonStyle(.plain)
                        if tab == 2 { Text(note.language ?? "text").font(.caption).foregroundStyle(meloGold) }
                        Button(note.deleted == true ? (tab == 2 ? "恢复成果" : "恢复知识") : (tab == 2 ? "删除成果" : "删除知识"), role: note.deleted == true ? nil : .destructive) { store.updatePreferences { p in if let index = p.knowledge?.firstIndex(where: { $0.id == note.id }) { p.knowledge?[index].deleted = note.deleted != true; p.knowledge?[index].updatedAt = timestamp() } } }.font(.caption)
                    }.meloPanel()
                }
                Text("删除后立即停止用于新请求；配置同步服务后，知识和删除状态一起同步。电脑本地文件不会自动上传。").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(20)
        }.sheet(item: $editing) { note in
            if note.kind == "result" { ResultDetail(note: note) } else { KnowledgeEditor(note: note) }
        }
        .sheet(isPresented: $importing) { LocalFilesView() }
    }
}
struct ResultDetail: View {
    @Environment(\.dismiss) private var dismiss
    let note: KnowledgeNote
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(note.title).font(.title3.weight(.semibold))
                    Label("成果", systemImage: "doc.text").foregroundStyle(meloGold)
                    Text(note.language ?? "text").font(.caption).foregroundStyle(.secondary)
                    Text(note.content).font(.system(.subheadline, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.padding(20)
            }.navigationTitle(LocalizedStringKey(InterfaceTerm.artifacts.key)).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }; ToolbarItem(placement: .primaryAction) { ShareLink(item: note.content) } }
        }.presentationBackground(MeloTheme.dialog)
    }
}
struct KnowledgeEditor: View {
    @EnvironmentObject var store: ChatStore
    let note: KnowledgeNote
    var body: some View {
        EditableDocument("知识", value: note, isNew: store.preferences.knowledge?.contains { $0.id == note.id } != true, read: { store.preferences.knowledge?.first { $0.id == note.id } }, commit: { value in
            var value = value
            guard !value.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !value.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.content.count <= 12000 else { throw MeloError.message("请填写标题与正文，正文不超过 12000 字。") }
            value.updatedAt = timestamp()
            guard store.updatePreferences({ p in var items = p.knowledge ?? []; if let i = items.firstIndex(where: { $0.id == value.id }) { items[i] = value } else { items.append(value) }; p.knowledge = items }, reportFailure: false) else { throw MeloError.message("保存失败，草稿已保留。") }
            return value
        }) { value in
            TextField("知识标题", text: value.title)
            Section("知识正文") { TextEditor(text: value.content).frame(minHeight: 300); Text("\(value.wrappedValue.content.count) / 12,000 字").font(.caption).foregroundStyle(.secondary) }
        }
    }
}
