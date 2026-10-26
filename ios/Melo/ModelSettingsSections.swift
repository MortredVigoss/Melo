import SwiftUI

struct ModelSettingsValue: Equatable, Codable {
    var authMode: String
    var model: String
    var webSearch: Bool
    static func read() -> Self {
        let d = UserDefaults.standard
        return .init(authMode: d.string(forKey: "modelAuthMode") ?? "chatgpt", model: d.string(forKey: "chatgptModel") ?? "", webSearch: d.object(forKey: "webSearchEnabled") as? Bool ?? true)
    }
}
struct ModelSettingsSection: View {
    @EnvironmentObject var account: ChatGPTAccount
    @AppStorage("modelAuthMode") private var authMode = "chatgpt"
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            EditableSection("模型服务", read: ModelSettingsValue.read, commit: { value in
                guard ["chatgpt", "api"].contains(value.authMode) else { throw MeloError.message("连接方式无效。") }
                if value.authMode == "chatgpt" {
                    guard !value.model.isEmpty else { throw MeloError.message("请选择对话模型后保存。") }
                    guard account.models.isEmpty || account.models.contains(where: { $0.slug == value.model }) else { throw MeloError.message("该模型已不在当前账号列表，请重新选择。") }
                }
                UserDefaults.standard.set(value.authMode, forKey: "modelAuthMode")
                UserDefaults.standard.set(value.model, forKey: "chatgptModel")
                UserDefaults.standard.set(value.webSearch, forKey: "webSearchEnabled")
                return value
            }) { value, _ in
                Picker("连接方式", selection: value.authMode) { Text("Codex 登录").tag("chatgpt"); Text("其他模型平台").tag("api") }.pickerStyle(.segmented)
                if value.wrappedValue.authMode == "chatgpt" {
                    Picker("对话模型", selection: value.model) {
                        if !account.models.contains(where: { $0.slug == value.wrappedValue.model }) { Text(value.wrappedValue.model.isEmpty ? "尚未选择" : value.wrappedValue.model).tag(value.wrappedValue.model) }
                        ForEach(account.models) { Text($0.display_name).tag($0.slug) }
                    }
                    Toggle("联网搜索", isOn: value.webSearch)
                }
            }
            SmartRoutingSettings()
            if authMode == "api" { LLMConnectionsView() }
            else {
                Button { Task { await account.loadModels() } } label: { Label("刷新可用模型", systemImage: "arrow.clockwise") }.disabled(!account.signedIn || account.busy)
                Text("实时检索取决于所选模型与账号权限；登录不会自动导入对话记录。").font(.caption).foregroundStyle(.secondary)
            }
        }.textInputAutocapitalization(.never).autocorrectionDisabled().meloPanel()
    }
}
struct SyncSettingsValue: Equatable, Codable {
    var endpoint: String
    var token: String
    static func read() -> Self { .init(endpoint: UserDefaults.standard.string(forKey: "syncEndpoint") ?? "", token: Secrets.read("syncToken")) }
    func save() throws {
        if !endpoint.isEmpty { _ = try Network.endpoint(endpoint); guard token.count >= 32 else { throw MeloError.message("同步密钥至少需要 32 个字符。") } }
        // URL stays unchanged when Keychain refuses the new key.
        try Secrets.write(token, key: "syncToken")
        UserDefaults.standard.set(endpoint, forKey: "syncEndpoint")
    }
}
struct SyncSettingsSection: View {
    @EnvironmentObject var store: ChatStore
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            EditableSection("同步服务配置", secureDraft: true, read: SyncSettingsValue.read, commit: { value in try value.save(); return value }) { value, editing in
                if editing {
                    TextField("私人同步服务地址（HTTPS）", text: value.endpoint).keyboardType(.URL).meloInput()
                    SecureField("同步密钥", text: value.token).meloInput()
                } else {
                    Text(value.wrappedValue.endpoint.isEmpty ? "尚未配置服务地址" : value.wrappedValue.endpoint).font(.caption).textSelection(.enabled)
                    Text(value.wrappedValue.token.isEmpty ? "尚未配置同步密钥" : "同步密钥已保存到钥匙串").font(.caption).foregroundStyle(.secondary)
                }
            }
            Button { Task { await store.sync() } } label: { Label(store.syncing ? "正在同步…" : "使用已保存配置同步", systemImage: "icloud") }.disabled(store.syncing)
        }.padding(.top, 12)
    }
}
