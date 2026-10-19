import SwiftUI
import AuthenticationServices
import CryptoKit

struct LLMConnection: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var baseURL: String
    var model = ""
    var key = ""
    var apiProtocol = "chat-completions"
    var probe: ConnectionProbe?
    var models: [String]?
    var contextWindows: [String: Int]?
    static let presets: [LLMConnection] = [
        .init(id: "openai", name: "OpenAI API", baseURL: "https://api.openai.com/v1"),
        .init(id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com"),
        .init(id: "doubao", name: "豆包 · 火山方舟", baseURL: "https://ark.cn-beijing.volces.com/api/v3"),
        .init(id: "gemini", name: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai"),
        .init(id: "anthropic", name: "Anthropic Claude", baseURL: "https://api.anthropic.com/v1", apiProtocol: "anthropic"),
        .init(id: "kimi", name: "Kimi · Moonshot", baseURL: "https://api.moonshot.cn/v1"),
        .init(id: "qwen", name: "通义千问 · 百炼", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        .init(id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1"),
        .init(id: "custom", name: "自定义兼容服务", baseURL: "")
    ]
    func endpoint() throws -> String {
        let url = try Network.endpoint(baseURL)
        guard url.query == nil else { throw MeloError.message("服务地址不能包含查询参数。") }
        var base = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        for suffix in ["/chat/completions", "/messages"] where base.hasSuffix(suffix) { base = String(base.dropLast(suffix.count)) }
        return base + (apiProtocol == "anthropic" ? "/messages" : "/chat/completions")
    }
    static func saved() throws -> [LLMConnection] {
        let raw = Secrets.read("llmConnections")
        return raw.isEmpty ? [] : try JSONDecoder().decode([LLMConnection].self, from: Data(raw.utf8))
    }
    static func resolve(_ selection: ConversationModel, in connections: [LLMConnection]) -> LLMConnection? {
        guard let baseURL = selection.baseURL, !baseURL.isEmpty else { return connections.first { $0.id == selection.connectionID } }
        let matches = connections.filter { WorkspaceProjection.base($0.baseURL) == WorkspaceProjection.base(baseURL) && $0.apiProtocol == (selection.apiProtocol ?? "chat-completions") }
        return matches.first { $0.id == selection.connectionID } ?? (matches.count == 1 ? matches[0] : nil)
    }
    func save(activate: Bool = false) throws {
        let endpoint = try endpoint()
        var profiles = try Self.saved()
        if profiles.isEmpty, let oldEndpoint = UserDefaults.standard.string(forKey: "modelEndpoint"), !oldEndpoint.isEmpty {
            profiles.append(.init(id: "existing", name: "原有 API 连接", baseURL: oldEndpoint, model: UserDefaults.standard.string(forKey: "modelName") ?? "", key: Secrets.read("modelKey"), apiProtocol: UserDefaults.standard.string(forKey: "modelProtocol") ?? "chat-completions"))
        }
        profiles.removeAll { $0.id == id }; profiles.append(self)
        if activate {
            guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !key.isEmpty else { throw MeloError.message("请填写模型 ID 和密钥，或完成登录。") }
        }
        try Secrets.write(String(decoding: JSONEncoder().encode(profiles), as: UTF8.self), key: "llmConnections")
        NotificationCenter.default.post(name: Notification.Name("MeloConnectionsChanged"), object: nil)
        if activate {
            try Secrets.write(key, key: "modelKey")
            let defaults = UserDefaults.standard
            defaults.set(endpoint, forKey: "modelEndpoint"); defaults.set(model, forKey: "modelName"); defaults.set(apiProtocol, forKey: "modelProtocol")
            defaults.set(contextWindows?[model], forKey: "modelContextWindow"); defaults.set(id, forKey: "activeLLMConnection"); defaults.set("api", forKey: "modelAuthMode")
        }
    }
}

private struct ConnectionEditCheckpoint: Codable, Equatable {
    var draft: LLMConnection
    var original: LLMConnection
    var storedOriginal: LLMConnection?
    var key: String
    var clearKey: Bool
    var editing: Bool
}

struct LLMConnectionsView: View {
    @EnvironmentObject var store: ChatStore
    @StateObject private var oauth = OpenRouterLogin()
    @State private var selected = "openai"
    @State private var draft = LLMConnection.presets[0]
    @State private var profiles: [LLMConnection] = []
    @State private var key = ""
    @State private var clearKey = false
    @State private var models: [String] = []
    @State private var status = ""
    @State private var busy = false
    @State private var editing = false
    @State private var saved = false
    @State private var saveError: String?
    @State private var original = LLMConnection.presets[0]
    @State private var storedOriginal: LLMConnection?
    @State private var draftError: String?
    @State private var confirmDiscard = false
    private var checkpoint: ConnectionEditCheckpoint { .init(draft: draft, original: original, storedOriginal: storedOriginal, key: key, clearKey: clearKey, editing: editing) }
    private var dirty: Bool { draft != original || !key.isEmpty || clearKey }
    private var currentProbe: ConnectionProbe? { (try? prepared())?.probe }
    private var options: [LLMConnection] { profiles + LLMConnection.presets.filter { p in !profiles.contains { $0.id == p.id } } }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("模型平台", selection: $selected) { ForEach(options) { Text($0.name).tag($0.id) } }.disabled(editing).onChange(of: selected) { _, id in if id != draft.id { select(id) } }
            HStack {
                EditStatus(editing: editing, dirty: dirty, saving: busy, saved: saved, error: saveError)
                Spacer()
                if editing {
                    Button("取消") { if dirty { confirmDiscard = true } else { select(selected) } }
                    Button("保存") { runSave() }.buttonStyle(.borderedProminent).tint(dirty ? meloGold : .gray).foregroundStyle(.black).disabled(!dirty)
                } else { Button("编辑") { editing = true; saved = false; saveError = nil } }
            }
            if let draftError { Text(draftError).font(.caption).foregroundStyle(.red) }
            Group {
            TextField("服务 Base URL（HTTPS）", text: $draft.baseURL).keyboardType(.URL).meloInput()
            if selected == "custom" { Picker("接口格式", selection: $draft.apiProtocol) { Text("Chat Completions").tag("chat-completions"); Text("Anthropic Messages").tag("anthropic") } }
            TextField(selected == "doubao" ? "模型 ID 或 ep-… 接入点" : "模型 ID", text: $draft.model).meloInput()
            if !models.isEmpty { Picker("从列表选择", selection: $draft.model) { Text("选择或手填").tag(draft.model); ForEach(models.filter { $0 != draft.model }, id: \.self) { Text($0).tag($0) } } }
            SecureField(profiles.first { $0.id == selected }?.key.isEmpty == false ? "已保存密钥；留空保留" : "API Key", text: $key).meloInput()
            Toggle("清除此连接的已保存密钥", isOn: $clearKey).font(.caption)
            }.disabled(!editing)
            HStack(spacing: 16) {
                Button("设为当前") { runSave(activate: true) }.disabled(editing || profiles.first { $0.id == selected } == nil)
                Button("测试已保存连接") { Task { await test() } }.disabled(editing || profiles.first { $0.id == selected } == nil)
            }.font(.subheadline).frame(minHeight: 44)
            Button("读取模型列表") { Task { await loadModels() } }.font(.caption).disabled(!editing)
            if selected == "openrouter" {
                Button("登录 OpenRouter") { Task {
                    do {
                        let connection = try prepared()
                        guard connection.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == "https://openrouter.ai/api/v1" else { throw MeloError.message("OAuth 需要使用 OpenRouter 官方地址。") }
                        await oauth.start { grantedKey in guard editing else { return }; key = grantedKey; status = "授权已完成，点击保存后才更新连接。" }
                    } catch { status = error.localizedDescription }
                } }
                .disabled(!editing)
                Text("使用 OpenRouter 账号额度，不继承其他平台订阅额度。").font(.caption).foregroundStyle(.secondary)
            }
            Text(status).font(.caption).foregroundStyle(.secondary)
            if let probe = currentProbe {
                VStack(alignment: .leading, spacing: 6) {
                    Label("实际请求已通过", systemImage: "checkmark.circle").foregroundStyle(meloGold)
                    Text("请求模型：\(probe.requestedModel)")
                    Text("返回模型：\(probe.returnedModel ?? "服务未提供")")
                    Text("\(probe.elapsedMS) ms · \(probe.response)").lineLimit(3)
                    Text(probe.testedAt).foregroundStyle(MeloTheme.soft)
                }.font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(12).background(MeloTheme.inset, in: RoundedRectangle(cornerRadius: MeloTheme.controlRadius))
            } else { Text("当前配置尚未通过实际请求测试").font(.caption).foregroundStyle(MeloTheme.soft) }
            Text("连接测试会发送一次简短请求。模型只提供回答，Melo 保留自己的Agent、记忆与执行逻辑。API 模式暂未接入手机搜索工具。").font(.caption).foregroundStyle(.secondary)
        }.disabled(busy || oauth.busy)
        .overlay(alignment: .bottom) { if oauth.busy { Button("取消登录") { oauth.cancel() }.buttonStyle(.borderedProminent) } }
        .onAppear { restoreDraft() }
        .onChange(of: checkpoint) { _, _ in preserveDraft() }
        .onDisappear { preserveDraft(); oauth.cancel() }
        .confirmationDialog("放弃未保存的连接修改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) { select(selected) }
            Button("继续编辑", role: .cancel) {}
        }
        .onChange(of: oauth.message) { _, message in if !message.isEmpty { status = message } }
    }
    private func select(_ id: String) { draft = options.first { $0.id == id } ?? LLMConnection.presets[0]; original = draft; storedOriginal = profiles.first { $0.id == id }; editing = false; saved = false; saveError = nil; key = ""; clearKey = false; models = draft.models ?? []; status = "" }
    private func restoreDraft() {
        do {
            profiles = try LLMConnection.saved()
            if let value = try EditDraftStorage.shared.restore(ConnectionEditCheckpoint.self, key: "modelConnection", secure: true), value.editing {
                draft = value.draft; original = value.original; storedOriginal = value.storedOriginal
                selected = draft.id; key = value.key; clearKey = value.clearKey; editing = true; models = draft.models ?? []
                status = "已恢复未保存的连接草稿，保存前不会影响当前模型。"
            } else { selected = UserDefaults.standard.string(forKey: "activeLLMConnection") ?? "openai"; select(selected) }
        } catch { draftError = "无法恢复连接草稿，已保存连接未改变。" }
    }
    private func preserveDraft() {
        do {
            if editing && dirty { try EditDraftStorage.shared.save(checkpoint, key: "modelConnection", secure: true) }
            else { try EditDraftStorage.shared.remove(key: "modelConnection", secure: true) }
            draftError = nil
        } catch { draftError = "连接草稿暂时只保留在本次运行中，请勿退出；密钥未写入普通文件。" }
    }
    private func prepared() throws -> LLMConnection {
        var value = draft
        let previous = profiles.first { $0.id == selected }
        if let previous, !previous.key.isEmpty, previous.baseURL != draft.baseURL, key.isEmpty, !clearKey { throw MeloError.message("服务地址改变后，请重新填写密钥或先清除旧密钥。") }
        value.key = clearKey ? "" : key.isEmpty ? previous?.key ?? "" : key
        let endpoint = try value.endpoint()
        if value.probe?.matches(endpoint: endpoint, model: value.model, apiProtocol: value.apiProtocol, key: value.key) != true { value.probe = nil }
        return value
    }
    private func runSave(activate: Bool = false) {
        do {
            guard activate ? !editing : editing && dirty else { return }
            let stored = try LLMConnection.saved().first { $0.id == selected }
            guard stored == storedOriginal else { throw MeloError.message("连接已在其他地方更新，草稿已保留，请取消并重新编辑。") }
            let value = try prepared(); if activate { store.cancel() }; try value.save(activate: activate)
            profiles = try LLMConnection.saved(); draft = value; original = value; storedOriginal = value; key = ""; clearKey = false; editing = false; saved = true; saveError = nil
            status = activate ? "已设为当前模型。" : "连接已保存；设为当前后才会切换。"
        } catch { saveError = error.localizedDescription }
    }
    private func test() async {
        busy = true; defer { busy = false }
        do {
            guard !editing, var value = profiles.first(where: { $0.id == selected }) else { return }
            let tested = value
            let start = Date(); status = "正在发送真实模型请求…"
            var reported = ""
            let reply = try await Network.reply(messages: [.init(role: "user", content: "2 + 2 = ? Reply only with the number.")], endpoint: value.endpoint(), model: value.model, token: value.key, apiProtocol: value.apiProtocol, onObservation: { reported = $0.returnedModel ?? reported })
            value.probe = ConnectionProbe(signature: ConnectionProbe.signature(endpoint: try value.endpoint(), model: value.model, apiProtocol: value.apiProtocol, key: value.key), requestedModel: value.model, returnedModel: reported.isEmpty ? nil : reported, response: String(reply.text.prefix(100)), elapsedMS: Int(Date().timeIntervalSince(start) * 1000), testedAt: timestamp())
            guard try LLMConnection.saved().first(where: { $0.id == selected }) == tested else { throw MeloError.message("测试期间连接已变化，未覆盖新配置。") }
            try value.save(); profiles = try LLMConnection.saved(); draft = value; original = value; storedOriginal = value; key = ""; clearKey = false
            status = "测试与连接已保存；设为当前后才会切换。"
        } catch { status = error.localizedDescription }
    }
    private func loadModels() async {
        busy = true; defer { busy = false }
        do {
            let value = try prepared(), endpoint = try value.endpoint()
            let suffix = value.apiProtocol == "anthropic" ? "/messages" : "/chat/completions"
            var request = URLRequest(url: URL(string: String(endpoint.dropLast(suffix.count)) + "/models")!); request.timeoutInterval = 20
            if value.apiProtocol == "anthropic" { request.setValue(value.key, forHTTPHeaderField: "x-api-key"); request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version") }
            else { request.setValue("Bearer \(value.key)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await Network.session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200, let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], let rows = json["data"] as? [[String: Any]] else { throw MeloError.message("服务不提供模型列表或凭证不可用；可以手填模型 ID 并测试。") }
            models = rows.compactMap { $0["id"] as? String }
            draft.models = models
            var windows = draft.contextWindows ?? [:]
            for row in rows {
                guard let id = row["id"] as? String, let n = (row["context_window"] ?? row["context_length"]) as? NSNumber,
                      n.doubleValue.isFinite, n.doubleValue >= 4096 else { continue }
                windows[id] = PhoneReadHistory.boundedInteger(n.doubleValue, minimum: 4096, maximum: 400000)
            }
            draft.contextWindows = windows
            status = "读取到 \(models.count) 个模型；保存后可在对话中选择。列表不代表已验证调用权限。"
        } catch { status = error.localizedDescription }
    }
}

@MainActor final class OpenRouterLogin: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published var busy = false
    @Published var message = ""
    private var listener: OAuthLoopback?
    private var browser: ASWebAuthenticationSession?
    private var window: UIWindow?
    private var attempt: UUID?
    private var timeout: Task<Void, Never>?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window! }
    func cancel() { attempt = nil; timeout?.cancel(); timeout = nil; listener?.stop(); listener = nil; browser?.cancel(); browser = nil; busy = false }
    func start(save: @escaping (String) throws -> Void) async {
        guard !busy else { return }
        window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
        guard window != nil else { message = "请回到 Melo 页面再登录。"; return }
        busy = true; message = "等待 OpenRouter 授权"; let id = UUID(); attempt = id
        do {
            let state = try ChatGPTProtocol.random(), verifier = try ChatGPTProtocol.random()
            let callback = OAuthLoopback(); listener = callback
            var redirect: URL?
            let url = try await callback.start { [weak self] url in
                guard let self, let redirect, self.attempt == id else { return }
                self.listener?.stop(); self.listener = nil
                // Consume browser callback once; retain the attempt until the exchange is saved.
                Task { await self.complete(url, redirect: redirect, state: state, verifier: verifier, id: id, save: save) }
            }
            redirect = url
            var auth = URLComponents(string: "https://openrouter.ai/auth")!
            auth.queryItems = ["callback_url": url.absoluteString, "state": state, "key_label": "Melo", "code_challenge_method": "S256", "code_challenge": ChatGPTProtocol.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))].map { URLQueryItem(name: $0.key, value: $0.value) }
            let session = ASWebAuthenticationSession(url: auth.url!, callbackURLScheme: nil) { [weak self] _, error in Task { @MainActor in if let self, self.attempt == id, self.listener != nil, error != nil { self.cancel(); self.message = "授权已取消" } } }
            browser = session; session.presentationContextProvider = self
            guard session.start() else { throw MeloError.message("无法打开登录窗口。") }
            timeout = Task { [weak self] in do { try await Task.sleep(for: .seconds(300)) } catch { return }; guard let self, self.attempt == id else { return }; self.cancel(); self.message = "授权已过期，请重试。" }
        } catch { cancel(); message = error.localizedDescription }
    }
    private func complete(_ url: URL, redirect: URL, state: String, verifier: String, id: UUID, save: (String) throws -> Void) async {
        browser?.cancel(); browser = nil
        defer { if attempt == id { cancel() } }
        do {
            guard url.scheme == redirect.scheme, url.host == redirect.host, url.port == redirect.port, url.path == redirect.path,
                  let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  items.filter({ $0.name == "state" }).count == 1, items.first(where: { $0.name == "state" })?.value == state,
                  items.filter({ $0.name == "code" }).count == 1, let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty,
                  !items.contains(where: { $0.name == "error" }) else { throw MeloError.message("授权校验失败或已取消，请重试。") }
            message = "正在保存授权"
            var request = URLRequest(url: URL(string: "https://openrouter.ai/api/v1/auth/keys")!); request.httpMethod = "POST"; request.timeoutInterval = 20
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "code_verifier": verifier, "code_challenge_method": "S256"])
            let (data, response) = try await Network.session.data(for: request)
            guard attempt == id else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200, let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], let key = json["key"] as? String, !key.isEmpty else { throw MeloError.message("授权交换失败，请重新登录。") }
            try save(key); message = "授权成功；请点击保存应用到连接。"
        } catch { if attempt == id { message = error.localizedDescription } }
    }
}
