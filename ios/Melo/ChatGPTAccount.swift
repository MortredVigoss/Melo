import Foundation
import SwiftUI
import AuthenticationServices
import CryptoKit

struct ChatGPTRegistration: Codable, Identifiable {
    var id: String { clientID }
    var clientID: String
    var subject: String
    var email: String
    var accessToken: String
    var refreshToken: String
    var idToken: String
    var expiresAt: Date
    var scopes: String
}
struct ChatGPTModel: Decodable, Identifiable {
    var id: String { slug }
    let slug: String
    let display_name: String
    let visibility: String?
}

@MainActor final class ChatGPTAccount: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published private(set) var registrations: [ChatGPTRegistration] = []
    @Published private(set) var activeID: String?
    @Published private(set) var models: [ChatGPTModel] = []
    @Published private(set) var busy = false
    @Published var status = "尚未登录"
    @Published var error: String?
    @Published private(set) var replyStatus = "正在思考…"
    private var browser: ASWebAuthenticationSession?
    private var loopback: OAuthLoopback?
    private var timeout: Task<Void, Never>?
    private var attemptID: UUID?
    private var refreshing: Task<ChatGPTRegistration, Error>?
    private var epoch = UUID()
    private var window: ASPresentationAnchor?
    var active: ChatGPTRegistration? { registrations.first { $0.clientID == activeID } }
    var signedIn: Bool { !(active?.refreshToken.isEmpty ?? true) }
    override init() {
        super.init()
        do { try Secrets.prepareBackgroundRefresh() } catch { self.error = error.localizedDescription }
        if let data = Secrets.read("chatgptAccounts").data(using: .utf8), let saved = try? JSONDecoder().decode([ChatGPTRegistration].self, from: data) { registrations = saved }
        activeID = UserDefaults.standard.string(forKey: "chatgptActiveID")
        if signedIn { status = "已登录 · 手机独立连接" }
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window! }
    private func save(_ registration: ChatGPTRegistration) throws {
        var next = registrations.filter { $0.clientID != registration.clientID }; next.append(registration)
        try persist(next)
        activeID = registration.clientID; UserDefaults.standard.set(activeID, forKey: "chatgptActiveID")
    }
    private func persist(_ next: [ChatGPTRegistration]) throws {
        let data = try JSONEncoder().encode(next)
        try Secrets.write(String(decoding: data, as: UTF8.self), key: "chatgptAccounts")
        registrations = next
    }
    func select(_ id: String) {
        guard !busy, registrations.contains(where: { $0.clientID == id }) else { return }
        epoch = UUID(); refreshing?.cancel(); refreshing = nil
        activeID = id; UserDefaults.standard.set(id, forKey: "chatgptActiveID"); models = []
        status = signedIn ? "已登录 · 手机独立连接" : "请重新授权"
        Task { await loadModels() }
    }
    func signIn(existingID: String? = nil) async {
        guard !busy else { return }
        guard let anchor = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).filter({ $0.activationState == .foregroundActive }).flatMap(\.windows).first(where: \.isKeyWindow) else { error = "请回到 Melo 页面再登录。"; return }
        window = anchor
        busy = true; error = nil; status = "等待官方页面授权"
        let attempt = UUID(); attemptID = attempt
        let old = registrations.first { $0.clientID == existingID }
        do {
            let state = try ChatGPTProtocol.random(), nonce = try ChatGPTProtocol.random(), verifier = try ChatGPTProtocol.random()
            var hostID = Secrets.read("chatgptHostID")
            if hostID.isEmpty { hostID = "urn:uuid:" + UUID().uuidString.lowercased(); try Secrets.write(hostID, key: "chatgptHostID") }
            let listener = OAuthLoopback(); loopback = listener
            var redirectURL: URL?
            let redirect = try await listener.start { [weak self] url in
                guard let self, let redirectURL, self.attemptID == attempt else { return }
                Task { await self.complete(url: url, redirect: redirectURL, state: state, nonce: nonce, verifier: verifier, old: old, attempt: attempt) }
            }
            redirectURL = redirect
            var values = ["client_id": old?.clientID ?? "dynamic_agent_client", "ext_agent_host_id": hostID, "response_type": "code", "redirect_uri": redirect.absoluteString, "scope": ChatGPTProtocol.scopes, "resource": ChatGPTProtocol.resource, "state": state, "nonce": nonce, "code_challenge_method": "S256", "code_challenge": ChatGPTProtocol.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))]
            if let old { if !old.idToken.isEmpty { values["id_token_hint"] = old.idToken } } else { values["agent_name_hint"] = "Melo" }
            var url = URLComponents(string: ChatGPTProtocol.issuer + "/api/accounts/authorize")!
            url.queryItems = values.map { URLQueryItem(name: $0.key, value: $0.value) }
            let browser = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: nil) { [weak self] _, _ in
                Task { @MainActor in
                    guard let self, self.attemptID == attempt else { return }
                    self.cancelLogin(); self.status = "登录已取消，可以重试"
                }
            }
            self.browser = browser; browser.presentationContextProvider = self
            browser.prefersEphemeralWebBrowserSession = false
            guard browser.start() else { throw MeloError.message("无法打开官方登录窗口。") }
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(300)) } catch { return }
                guard let self, self.attemptID == attempt else { return }
                self.cancelLogin(); self.error = "登录等待超时，请重试。"
            }
        } catch { cancelLogin(); self.error = error.localizedDescription }
    }
    func cancelLogin() {
        attemptID = nil; timeout?.cancel(); timeout = nil
        loopback?.stop(); loopback = nil; browser?.cancel(); browser = nil; busy = false
    }
    private func complete(url: URL, redirect: URL, state: String, nonce: String, verifier: String, old: ChatGPTRegistration?, attempt: UUID) async {
        guard attemptID == attempt else { return }
        // Consume the callback once before awaiting any network work.
        attemptID = nil; timeout?.cancel(); timeout = nil; loopback?.stop(); loopback = nil; browser?.cancel(); browser = nil
        status = "正在验证登录身份"
        defer { busy = false }
        do {
            let result = try ChatGPTProtocol.callback(url, redirect: redirect, state: state, clientID: old?.clientID)
            let response = try await Self.token(["grant_type": "authorization_code", "client_id": result.clientID, "code": result.code, "code_verifier": verifier, "redirect_uri": redirect.absoluteString, "resource": ChatGPTProtocol.resource])
            let jwks = try await Self.get(ChatGPTProtocol.issuer + "/.well-known/jwks.json")
            guard let idToken = response.id_token else { throw MeloError.message("登录未返回身份凭证。") }
            let identity = try ChatGPTProtocol.validateIDToken(idToken, jwks: jwks, clientID: result.clientID, nonce: nonce)
            guard old == nil || old?.subject == identity.subject else { throw MeloError.message("返回账号与所选账号不一致，原登录已保留。") }
            let grant = try response.registration(clientID: result.clientID, subject: identity.subject, email: identity.email, previous: nil)
            epoch = UUID(); refreshing?.cancel(); refreshing = nil
            try save(grant); models = []; UserDefaults.standard.set("chatgpt", forKey: "modelAuthMode")
            status = "已登录 · 手机独立连接"
            await loadModels()
        } catch { self.error = error.localizedDescription; status = "授权未完成，原有记录已保留" }
    }
    private struct Token: Decodable {
        let access_token: String
        let refresh_token: String?
        let id_token: String?
        let expires_in: Double
        let scope: String?
        let token_type: String
        func registration(clientID: String, subject: String, email: String, previous: ChatGPTRegistration?) throws -> ChatGPTRegistration {
            let granted = scope ?? previous?.scopes ?? ""
            guard granted.split(separator: " ").contains("chatgpt.tokens.use.direct"), token_type.lowercased() == "bearer", !access_token.isEmpty, expires_in > 0,
                  let refresh = refresh_token ?? previous?.refreshToken, !refresh.isEmpty else { throw MeloError.message("尚未允许使用 ChatGPT 计划，请重新登录并在官方页面授权。") }
            return ChatGPTRegistration(clientID: clientID, subject: subject, email: email, accessToken: access_token, refreshToken: refresh, idToken: id_token ?? previous?.idToken ?? "", expiresAt: Date().addingTimeInterval(expires_in), scopes: granted)
        }
    }
    private static func token(_ values: [String: String]) async throws -> Token {
        var request = URLRequest(url: URL(string: ChatGPTProtocol.issuer + "/api/accounts/oauth/token")!)
        request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = ChatGPTProtocol.form(values)
        let (data, response) = try await Network.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count < 128_000 else { throw MeloError.message("登录凭证未能更新，请重新授权。") }
        return try JSONDecoder().decode(Token.self, from: data)
    }
    private static func get(_ url: String, token: String? = nil) async throws -> Data {
        var request = URLRequest(url: URL(string: url)!); request.timeoutInterval = 30
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await Network.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count < 2_000_000 else { throw MeloError.message("无法获取官方账号信息，请检查网络或重新登录。") }
        return data
    }
    private func credentials() async throws -> ChatGPTRegistration {
        guard let account = active, !account.refreshToken.isEmpty else { throw MeloError.message("请到设置中点 Continue with ChatGPT 完成授权登录。") }
        if account.expiresAt.timeIntervalSinceNow > 90 { return account }
        if let refreshing { return try await refreshing.value }
        let expectedEpoch = epoch
        let task = Task<ChatGPTRegistration, Error> {
            let response = try await Self.token(["grant_type": "refresh_token", "client_id": account.clientID, "refresh_token": account.refreshToken, "resource": ChatGPTProtocol.resource])
            if let token = response.id_token {
                let jwks = try await Self.get(ChatGPTProtocol.issuer + "/.well-known/jwks.json")
                let identity = try ChatGPTProtocol.validateIDToken(token, jwks: jwks, clientID: account.clientID, nonce: nil)
                guard identity.subject == account.subject else { throw MeloError.message("账号校验失败，请重新授权。") }
            }
            let updated = try response.registration(clientID: account.clientID, subject: account.subject, email: account.email, previous: account)
            try Task.checkCancellation()
            guard self.epoch == expectedEpoch, self.activeID == account.clientID else { throw CancellationError() }
            try self.save(updated)
            return updated
        }
        refreshing = task
        defer { if epoch == expectedEpoch { refreshing = nil } }
        return try await task.value
    }
    func loadModels() async {
        guard signedIn else { return }
        let expectedEpoch = epoch
        do {
            let account = try await credentials()
            let data = try await Self.get(ChatGPTProtocol.resource + "/models", token: account.accessToken)
            struct Catalog: Decodable { let models: [ChatGPTModel] }
            let available = try JSONDecoder().decode(Catalog.self, from: data).models.filter { $0.visibility == "list" }
            guard epoch == expectedEpoch else { return }
            models = available
            // Refreshing a catalog must not silently replace the user's saved model.
            // A missing selection is resolved explicitly in the model editor.
            if available.isEmpty { throw MeloError.message("此账号暂未提供可用模型，请检查计划授权。") }
        } catch { if epoch == expectedEpoch { self.error = error.localizedDescription } }
    }
    func signOut() async {
        guard !busy, let account = active else { return }
        busy = true; epoch = UUID(); refreshing?.cancel(); refreshing = nil
        defer { busy = false }
        var revoked = account.refreshToken.isEmpty
        if !account.refreshToken.isEmpty {
            var request = URLRequest(url: URL(string: ChatGPTProtocol.issuer + "/api/accounts/oauth/revoke")!)
            request.httpMethod = "POST"; request.timeoutInterval = 15
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = ChatGPTProtocol.form(["token": account.refreshToken, "token_type_hint": "refresh_token", "client_id": account.clientID])
            if let (_, response) = try? await Network.session.data(for: request) { revoked = (response as? HTTPURLResponse)?.statusCode == 200 }
        }
        do {
            var cleared = account; cleared.accessToken = ""; cleared.refreshToken = ""; cleared.idToken = ""; cleared.expiresAt = .distantPast
            try save(cleared); models = []; status = "已退出登录"
            if !revoked { error = "已退出此手机，但未确认远端撤销。你可以在 ChatGPT 设置里断开 Melo。" }
        } catch { self.error = error.localizedDescription }
    }
    func reply(messages: [ChatMessage], model: String, instructions: String, imageInputs: [ImageInput] = [], imageTask: ImageTaskPlan? = nil, onObservation: ((ExecutionObservation) -> Void)? = nil, onReceiving: (() -> Void)? = nil) async throws -> ModelReply {
        if imageTask?.makesImage != true { try ConversationHistory.validateCurrentInput(messages.last(where: { $0.role == "user" })?.content ?? "", instructions: instructions) }
        let expectedEpoch = epoch
        replyStatus = "正在思考…"
        defer { replyStatus = "正在思考…" }
        let account = try await credentials()
        try Task.checkCancellation()
        guard !model.isEmpty else { throw MeloError.message("请先在设置中刷新并选择 ChatGPT 模型。") }
        var request = URLRequest(url: URL(string: ChatGPTProtocol.resource + "/responses")!)
        request.httpMethod = "POST"; request.timeoutInterval = imageTask?.makesImage == true ? 180 : 120
        request.setValue("Bearer \(account.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let webSearch = imageTask?.makesImage != true && (UserDefaults.standard.object(forKey: "webSearchEnabled") as? Bool ?? true)
        var body = ChatGPTRequest.body(messages: messages, model: model, instructions: instructions, webSearch: webSearch)
        if !imageInputs.isEmpty || imageTask?.makesImage == true {
            let imageBody = ImageRequestBody.responses(messages: messages, inputs: imageInputs, task: imageTask ?? ImageTaskPlan(action: .analyze), model: model, instructions: instructions)
            body["input"] = imageBody["input"]
            if imageTask?.makesImage == true { body = imageBody }
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        var requestObservation = ExecutionObservation()
        requestObservation.stage("model:response", name: "模型请求", status: "running", output: "等待服务返回", model: model)
        onObservation?(requestObservation)
        let (bytes, response) = try await Network.session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw MeloError.message("模型服务没有响应。") }
        guard http.statusCode == 200 else {
            if http.statusCode == 401 || http.statusCode == 403 { throw MeloError.message("登录已失效或未授权计划用量，请回设置重新授权。") }
            if [400, 413, 422].contains(http.statusCode) {
                var errorBody = Data()
                for try await byte in bytes { errorBody.append(byte); if errorBody.count > 16_384 { break } }
                if let contextError = Network.contextLimitError(errorBody) { throw contextError }
                throw MeloError.message("当前账号或模型未接受所选工具、图片或输入内容（\(http.statusCode)）；本次要求和图片已保留。")
            }
            if http.statusCode == 429 { throw MeloError.message("已达到使用限额，请检查 ChatGPT 中 Melo 的计划额度。") }
            throw MeloError.message("模型服务暂时不可用，请稍后重试。")
        }
        let mustSearch = webSearch && ChatGPTRequest.requiresSearch(messages)
        func replyResult(_ stream: ChatGPTStream) throws -> ModelReply {
            let text = try stream.result()
            if imageTask?.makesImage == true && stream.images.isEmpty { throw MeloError.message("服务未返回完整图片，请确认当前账号或模型支持生图。要求和参考图已保留。") }
            if mustSearch && !stream.searched { throw MeloError.message("这次没有取得实际联网搜索结果，请重试或切换支持搜索的模型。消息已保留。") }
            return ModelReply(text: text, sources: stream.sources, searched: stream.searched, images: stream.images)
        }
        var parser = ChatGPTSSE(maxBytes: imageTask?.makesImage == true ? 64 * 1024 * 1024 : 8 * 1024 * 1024)
        var revision = -1
        var receivedText = false
        var consumedBytes = 0
        for try await byte in bytes {
            consumedBytes += 1
            if consumedBytes.isMultiple(of: 32768) { await Task.yield() }
            try Task.checkCancellation()
            guard epoch == expectedEpoch else { throw CancellationError() }
            do { try parser.accept(byte) }
            catch { onObservation?(parser.stream.observation); throw error }
            if !receivedText && !parser.stream.text.isEmpty { receivedText = true; onReceiving?() }
            if parser.stream.observation.revision != revision {
                revision = parser.stream.observation.revision
                onObservation?(parser.stream.observation)
            }
            let nextStatus = parser.stream.generatingImage ? "正在处理图片…" : parser.stream.searching ? "正在联网搜索…" : parser.stream.searched ? "正在整理搜索结果…" : "正在思考…"
            if replyStatus != nextStatus { replyStatus = nextStatus }
            if parser.stream.completed { return try replyResult(parser.stream) }
        }
        _ = try parser.finish()
        return try replyResult(parser.stream)
    }
}
