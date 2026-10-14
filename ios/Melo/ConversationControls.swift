import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct AgentAvatar: View {
    let agent: AgentProfile
    var size: CGFloat = 36
    var body: some View {
        Group {
            if let data = agent.avatarData, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFill() }
            else { Image(systemName: agent.symbol).font(.system(size: size * 0.44)).foregroundStyle(meloGold).frame(width: size, height: size).background(meloGold.opacity(0.1)) }
        }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size * 0.3)).accessibilityHidden(true)
    }
}
struct AvatarPicker: View {
    @Binding var agent: AgentProfile
    @State private var selection: PhotosPickerItem?
    @State private var importing = false
    @State private var error: String?
    var body: some View {
        HStack(spacing: 18) {
            AgentAvatar(agent: agent, size: 68)
            VStack(alignment: .leading, spacing: 12) {
                PhotosPicker("从照片上传头像", selection: $selection, matching: .images)
                Button("从文件选择图片") { importing = true }
                if agent.avatarData != nil { Button("恢复默认图标") { agent.avatarData = nil } }
            }.font(.subheadline)
        }.onChange(of: selection) { _, item in Task { do { if let data = try await item?.loadTransferable(type: Data.self) { try setAvatar(data) } } catch { self.error = error.localizedDescription } } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
            do { let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; try setAvatar(Data(contentsOf: url)) } catch { self.error = error.localizedDescription }
        }
        .alert("头像未更新", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("知道了") { error = nil } } message: { Text(error ?? "") }
    }
    private func setAvatar(_ data: Data) throws {
        guard data.count <= 20 * 1024 * 1024, let source = UIImage(data: data), source.size.width > 0, source.size.height > 0 else { throw MeloError.message("请选择 20 MB 以内的有效图片。") }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: format).image { _ in
            let scale = max(256 / source.size.width, 256 / source.size.height)
            let size = CGSize(width: source.size.width * scale, height: source.size.height * scale)
            source.draw(in: CGRect(x: (256 - size.width) / 2, y: (256 - size.height) / 2, width: size.width, height: size.height))
        }
        guard let encoded = image.jpegData(compressionQuality: 0.82) else { throw MeloError.message("图片转换失败。") }
        agent.avatarData = encoded
    }
}
struct ConversationControls: View {
    @EnvironmentObject var store: ChatStore
    @EnvironmentObject var account: ChatGPTAccount
    let chatID: String
    var settings: () -> Void
    @State private var connections: [LLMConnection] = []
    @State private var context = false
    @AppStorage("chatgptModel") private var defaultGPT = ""
    @AppStorage("modelName") private var defaultAPI = ""
    @AppStorage("modelAuthMode") private var defaultMode = "chatgpt"
    private var current: ConversationModel? { store.preferences.chatModels?[chatID] }
    private var modelLabel: String { current?.model ?? store.agent(for: chatID).model.flatMap { $0.isEmpty ? nil : $0 } ?? (defaultMode == "chatgpt" ? defaultGPT : defaultAPI) }
    private var models: [String] { Array(Set(account.models.map(\.slug) + [defaultGPT, current?.connectionID == "chatgpt" ? current?.model ?? "" : ""])).filter { !$0.isEmpty }.sorted() }
    private var usesChatGPT: Bool { current.map { $0.connectionID == "chatgpt" } ?? (defaultMode == "chatgpt") }
    private var capability: String {
        if usesChatGPT { return account.signedIn ? "ChatGPT · 文字与网页检索" : "ChatGPT 尚未登录 · 请先配置连接" }
        if let current, LLMConnection.resolve(current, in: connections)?.key.isEmpty != false { return "\(current.name ?? "所选连接")尚未配置 · 请先连接或重新选择" }
        return "API · 文字对话 · 本机尚未接入联网和电脑工具"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                Menu {
                    ForEach(store.preferences.agents) { agent in
                        Button { store.selectAgent(agent.id, chatID: chatID) } label: { Label(agent.name, systemImage: store.agent(for: chatID).id == agent.id ? "checkmark" : agent.symbol) }
                    }
                    Text("切换只影响之后的回复；历史消息保持原角色。")
                } label: { HStack(spacing: 6) { AgentAvatar(agent: store.agent(for: chatID), size: 22); Text("角色 · " + store.agent(for: chatID).name); Image(systemName: "chevron.down").font(.system(size: 9)) }.font(.caption).padding(9).background(MeloTheme.inset, in: Capsule()) }.accessibilityLabel("选择对话角色")
                Menu {
                    Button { store.selectModel(nil, chatID: chatID) } label: { Label("沿用角色或系统默认", systemImage: current == nil ? "checkmark" : "gearshape") }
                    if account.signedIn {
                        Section("ChatGPT") {
                            ForEach(models, id: \.self) { model in Button { store.selectModel(.init(connectionID: "chatgpt", model: model), chatID: chatID) } label: { Label(model, systemImage: current?.connectionID == "chatgpt" && current?.model == model ? "checkmark" : "cpu") } }
                        }
                    }
                    Section("已配置的 API") {
                        ForEach(connections.filter { !$0.key.isEmpty }) { connection in
                            ForEach(availableModels(connection), id: \.self) { model in
                                apiModelButton(connection, model: model)
                            }
                        }
                    }
                    Button("管理连接与模型列表", systemImage: "slider.horizontal.3", action: settings)
                } label: { Label(modelLabel.isEmpty ? "选择模型" : modelLabel, systemImage: "cpu").font(.caption).lineLimit(1).padding(11).background(MeloTheme.inset, in: Capsule()) }.accessibilityLabel("选择对话模型")
                Button { context = true } label: { Label("项目与资料\(store.knowledge(for: chatID).isEmpty ? "" : " · \(store.knowledge(for: chatID).count)")", systemImage: "paperclip").font(.caption).padding(11).background(MeloTheme.inset, in: Capsule()) }
            }.padding(.horizontal, 16).padding(.vertical, 6)
        }.disabled(store.sendingID == chatID).onAppear { load() }.onChange(of: defaultMode) { _, _ in load() }.onReceive(NotificationCenter.default.publisher(for: Notification.Name("MeloConnectionsChanged"))) { _ in load() }
        .task { if account.signedIn && account.models.isEmpty { await account.loadModels() } }
        .sheet(isPresented: $context) { ConversationContextPicker(chatID: chatID) }
        Text(capability).font(.caption2).foregroundStyle(MeloTheme.soft).padding(.horizontal, 18).padding(.bottom, 3)
        }
    }
    private func availableModels(_ connection: LLMConnection) -> [String] {
        Array(Set((connection.models ?? []) + [connection.model])).filter { !$0.isEmpty }.sorted()
    }
    private func choose(_ connection: LLMConnection, model: String) {
        let selection = ConversationModel(connectionID: connection.id, model: model, name: connection.name, baseURL: connection.baseURL, apiProtocol: connection.apiProtocol)
        store.selectModel(selection, chatID: chatID)
    }
    private func apiModelButton(_ connection: LLMConnection, model: String) -> some View {
        let selected = current?.connectionID == connection.id && current?.model == model
        return Button { choose(connection, model: model) } label: {
            Label(connection.name + " · " + model, systemImage: selected ? "checkmark" : "cpu")
        }
    }
    private func load() { do { connections = try LLMConnection.saved() } catch { store.error = "模型连接读取失败，原配置已保留。" } }
}
struct ConversationContextPicker: View {
    @EnvironmentObject var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    let chatID: String
    var body: some View {
        NavigationStack {
            Form {
                Section("放入项目") {
                    Picker("项目", selection: Binding(get: { store.preferences.chatProjects?[chatID] ?? "" }, set: { id in store.updatePreferences { if $0.chatProjects == nil { $0.chatProjects = [:] }; $0.chatProjects?[chatID] = id.isEmpty ? nil : id } })) {
                        Text("独立对话").tag("")
                        ForEach((store.preferences.projects ?? []).filter { $0.archived != true || $0.id == store.preferences.chatProjects?[chatID] }) { Text($0.name + ($0.archived == true ? "（已归档）" : "")).tag($0.id) }
                    }
                }
                Section("本次对话可用的知识资料") {
                    if (store.preferences.knowledge ?? []).isEmpty { Text("先在知识分支添加资料，再在这里选用。").foregroundStyle(.secondary) }
                    ForEach((store.preferences.knowledge ?? []).filter { $0.deleted != true }) { note in
                        if store.project(for: chatID)?.knowledgeIds?.contains(note.id) == true {
                            Label("\(note.title) · 项目共享", systemImage: "checkmark.circle.fill").foregroundStyle(.secondary)
                        } else {
                        Toggle(note.title, isOn: Binding(get: { store.preferences.chatKnowledge?[chatID]?.contains(note.id) == true }, set: { enabled in store.updatePreferences { if $0.chatKnowledge == nil { $0.chatKnowledge = [:] }; var ids = $0.chatKnowledge?[chatID] ?? []; if enabled { ids.insert(note.id) } else { ids.remove(note.id) }; let inherited = ($0.projects ?? []).first { $0.id == store.preferences.chatProjects?[chatID] }?.knowledgeIds ?? []; let selected = ($0.knowledge ?? []).filter { $0.deleted != true && ids.union(inherited).contains($0.id) }; guard selected.count <= 8 && selected.reduce(0, { $0 + $1.content.count }) <= 24000 else { store.error = "最多选用 8 份、合计 24000 字资料。"; return }; $0.chatKnowledge?[chatID] = ids } }))
                        }
                    }
                    Text("项目共享与本对话选中的资料会随下一次消息发送，合计最多 8 份、24000 字。已删除资料不会加入。").font(.caption).foregroundStyle(.secondary)
                }
            }.navigationTitle("项目与资料").toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.presentationBackground(MeloTheme.dialog)
    }
}
