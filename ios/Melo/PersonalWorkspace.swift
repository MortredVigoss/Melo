import SwiftUI
import UniformTypeIdentifiers

struct ProjectsView: View {
    @EnvironmentObject var store: ChatStore
    let open: (String) -> Void
    @State private var editing: PersonalProject?
    @State private var tasks = false
    @State private var showArchived = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeading(eyebrow: "PROJECTS", title: "项目", detail: "把同一个目标的对话放在一起，后续讨论继续沿用项目目标。")
                Button { editing = PersonalProject(name: "", goal: "") } label: { Label("新建项目", systemImage: "plus").frame(maxWidth: .infinity).padding(15) }.buttonStyle(.bordered)
                Toggle("查看已归档项目", isOn: $showArchived).font(.caption)
                if (store.preferences.projects ?? []).isEmpty { Text("例如：旅行计划、学习一门语言、开发一个产品。项目不是另一种 Agent，而是一组相关工作的容器。").font(.subheadline).foregroundStyle(.secondary).meloPanel() }
                ForEach((store.preferences.projects ?? []).filter { ($0.archived == true) == showArchived }) { project in
                    VStack(alignment: .leading, spacing: 14) {
                        HStack { Text(project.name).font(.title3); Spacer(); Button("查看") { editing = project }.font(.caption) }
                        if !project.goal.isEmpty { Text(project.goal).font(.subheadline).foregroundStyle(.secondary) }
                        let chats = store.chats.filter { store.preferences.chatProjects?[$0.id] == project.id }
                        Text("\(chats.count) 段对话 · \(project.knowledgeIds?.count ?? 0) 份共享资料\(project.archived == true ? " · 已归档" : "")").font(.caption).foregroundStyle(meloGold)
                        ForEach(chats) { chat in Button { open(chat.id) } label: { Label(chat.title, systemImage: "bubble.left").font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 5) } }
                        if project.archived != true { Button { if let id = store.newChat(projectID: project.id) { open(id) } } label: { Label("在项目中开始对话", systemImage: "plus.bubble") }.font(.subheadline) }
                        Button(project.archived == true ? "恢复项目" : "归档项目") { store.updatePreferences { p in if let index = p.projects?.firstIndex(where: { $0.id == project.id }) { p.projects?[index].archived = project.archived != true } } }.font(.caption)
                    }.meloPanel()
                }
                DisclosureGroup("桌面任务与接力（\(store.taskCheckpoints.count)）", isExpanded: $tasks) {
                    TaskHandoffView(open: open).frame(minHeight: 280, maxHeight: 500)
                }.font(.subheadline).meloPanel()
                Text("归档保留对话与资料，可随时恢复。配置同步服务后，项目与共享资料会一起同步。").font(.caption).foregroundStyle(.secondary)
            }.padding(20)
        }.sheet(item: $editing) { project in ProjectEditor(project: project) }
    }
}
struct ProjectEditor: View {
    @EnvironmentObject var store: ChatStore
    let project: PersonalProject
    var body: some View {
        EditableDocument("项目设置", value: project, isNew: store.preferences.projects?.contains { $0.id == project.id } != true, read: { store.preferences.projects?.first { $0.id == project.id } }, commit: { value in
            guard !value.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.goal.count <= 12000, (value.instructions?.count ?? 0) <= 12000 else { throw MeloError.message("请填写项目名称，目标与要求各不超过 12000 字。") }
            let notes = (store.preferences.knowledge ?? []).filter { value.knowledgeIds?.contains($0.id) == true && $0.deleted != true }
            guard notes.count <= 8, notes.reduce(0, { $0 + $1.content.count }) <= 24000 else { throw MeloError.message("项目资料最多 8 份、合计 24000 字。") }
            guard store.updatePreferences({ p in var items = p.projects ?? []; if let i = items.firstIndex(where: { $0.id == value.id }) { items[i] = value } else { items.append(value) }; p.projects = items }, reportFailure: false) else { throw MeloError.message("保存失败，草稿已保留。") }
            return value
        }) { value in
            TextField("项目名称", text: value.name)
            Section("目标与背景") { TextEditor(text: value.goal).frame(minHeight: 140) }
            Section("项目要求") { TextEditor(text: Binding(get: { value.wrappedValue.instructions ?? "" }, set: { value.wrappedValue.instructions = $0 })).frame(minHeight: 120) }
            Section("项目共享资料") {
                ForEach((store.preferences.knowledge ?? []).filter { $0.deleted != true }) { note in
                    Toggle(note.title, isOn: Binding(get: { value.wrappedValue.knowledgeIds?.contains(note.id) == true }, set: { enabled in
                        var ids = value.wrappedValue.knowledgeIds ?? []; if enabled { ids.insert(note.id) } else { ids.remove(note.id) }; value.wrappedValue.knowledgeIds = ids
                    }))
                }
                Text("最多 8 份、24000 字；保存后用于项目内对话。").font(.caption)
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
    private var notes: [KnowledgeNote] { (store.preferences.knowledge ?? []).filter { ($0.deleted == true) == showDeleted && (query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.content.localizedCaseInsensitiveContains(query)) } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PageHeading(eyebrow: "KNOWLEDGE", title: "知识资料", detail: "保存反复用到的背景、要求和参考文字，在对话里主动选用。")
                Picker("知识分类", selection: $tab) { Text("资料").tag(0); Text("记忆").tag(1) }.pickerStyle(.segmented)
                if tab == 1 { MemoryFactsView() } else {
                HStack { Button { editing = KnowledgeNote(title: "", content: "") } label: { Label("添加资料", systemImage: "plus") }; Spacer(); Button("导入文字文件") { importing = true } }.font(.subheadline).padding(.vertical, 8)
                TextField("搜索资料", text: $query).meloInput()
                Toggle("查看已删除资料", isOn: $showDeleted).font(.caption)
                if notes.isEmpty { Text(query.isEmpty ? "把个人偏好、工作规范、产品说明或学习笔记保存在这里。之后在对话的“项目与资料”中选择，模型才能使用。" : "没有匹配的资料。").font(.subheadline).foregroundStyle(.secondary).meloPanel() }
                ForEach(notes) { note in
                    VStack(alignment: .leading, spacing: 10) {
                        Button { editing = note } label: { VStack(alignment: .leading, spacing: 9) { Text(note.title).font(.headline); Text(note.content).font(.subheadline).foregroundStyle(.secondary).lineLimit(3) }.frame(maxWidth: .infinity, alignment: .leading) }.buttonStyle(.plain)
                        Button(note.deleted == true ? "恢复资料" : "删除资料", role: note.deleted == true ? nil : .destructive) { store.updatePreferences { p in if let index = p.knowledge?.firstIndex(where: { $0.id == note.id }) { p.knowledge?[index].deleted = note.deleted != true; p.knowledge?[index].updatedAt = timestamp() } } }.font(.caption)
                    }.meloPanel()
                }
                Text("删除后立即停止用于新请求；配置同步服务后，资料和删除状态一起同步。电脑本地文件不会自动上传。").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(20)
        }.sheet(item: $editing) { note in KnowledgeEditor(note: note) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText, .utf8PlainText, UTType(filenameExtension: "md") ?? .plainText]) { result in
            do { let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; let data = try Data(contentsOf: url); guard data.count <= 60000, let text = String(data: data, encoding: .utf8), text.count <= 12000 else { throw MeloError.message("请选择 12,000 字以内的 UTF-8 文字资料。") }; editing = KnowledgeNote(title: url.deletingPathExtension().lastPathComponent, content: text) } catch { store.error = error.localizedDescription }
        }
    }
}
struct KnowledgeEditor: View {
    @EnvironmentObject var store: ChatStore
    let note: KnowledgeNote
    var body: some View {
        EditableDocument("知识资料", value: note, isNew: store.preferences.knowledge?.contains { $0.id == note.id } != true, read: { store.preferences.knowledge?.first { $0.id == note.id } }, commit: { value in
            var value = value
            guard !value.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !value.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.content.count <= 12000 else { throw MeloError.message("请填写标题与正文，正文不超过 12000 字。") }
            value.updatedAt = timestamp()
            guard store.updatePreferences({ p in var items = p.knowledge ?? []; if let i = items.firstIndex(where: { $0.id == value.id }) { items[i] = value } else { items.append(value) }; p.knowledge = items }, reportFailure: false) else { throw MeloError.message("保存失败，草稿已保留。") }
            return value
        }) { value in
            TextField("资料标题", text: value.title)
            Section("资料正文") { TextEditor(text: value.content).frame(minHeight: 300); Text("\(value.wrappedValue.content.count) / 12,000 字").font(.caption).foregroundStyle(.secondary) }
        }
    }
}
