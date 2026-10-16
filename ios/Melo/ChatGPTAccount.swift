import Foundation
import SwiftUI

struct ChatGPTModel: Decodable, Identifiable {
    var id: String { slug }
    let slug: String
    let display_name: String
    let visibility: String?
}
// Keep the existing connection identifier so conversation selections survive migration.
// Credentials are exclusively Codex grants in a NEW Keychain entry; SIWC is never reused.
/// The image tool rejected the requested output size.
struct ImageSizeRejected: Error {}
@MainActor final class ChatGPTAccount: ObservableObject {
    @Published private(set) var registrations: [CodexRegistration] = []
    @Published private(set) var activeID: String?
    @Published private(set) var models: [ChatGPTModel] = []
    @Published private(set) var busy = false
    @Published private(set) var deviceCode: CodexDeviceCode?
    @Published var status = "尚未登录 Codex"
    @Published var error: String?
    @Published private(set) var replyStatus = "正在思考…"
    /// Status per conversation, so two replies running at once each show their own.
    @Published private(set) var replyStatuses: [String: String] = [:]
    func replyStatus(for key: String) -> String { replyStatuses[key] ?? "正在思考…" }
    @Published private(set) var imageVerified = false
    private var loginTask: Task<Void,Never>?
    private var attemptID: UUID?
    private var applicationActive = true
    private var refreshing: Task<CodexRegistration,Error>?
    private var epoch = UUID()
    private let session: URLSession
    private let defaults: UserDefaults
    private let persistCredentials: (String) throws -> Void
    var active: CodexRegistration? { registrations.first { $0.id == activeID } }
    var signedIn: Bool { !(active?.refreshToken.isEmpty ?? true) }
    init(session: URLSession = CodexOAuth.session, defaults: UserDefaults = .standard,
         readCredentials: () -> String = { Secrets.read("codexAccounts") },
         persistCredentials: @escaping (String) throws -> Void = { try Secrets.write($0,key:"codexAccounts") },
         prepareStorage: () throws -> Void = Secrets.prepareBackgroundRefresh) {
        self.session=session; self.defaults=defaults; self.persistCredentials=persistCredentials
        do { try prepareStorage() } catch { self.error = error.localizedDescription }
        let saved = readCredentials()
        if !saved.isEmpty {
            do { registrations = try JSONDecoder().decode([CodexRegistration].self,from:Data(saved.utf8)) }
            catch { self.error = "Codex 登录记录无法读取，原数据已保留。" }
        }
        activeID = defaults.string(forKey:"codexActiveID")
        updateStatus()
    }
    private func updateStatus() {
        imageVerified = activeID.map { defaults.bool(forKey:"codexImageVerified:" + $0) } ?? false
        status = signedIn ? "Codex 已登录 · 手机独立连接" : "尚未登录 Codex · 原 ChatGPT 授权需重新登录"
    }
    private func save(_ account: CodexRegistration) throws {
        var next = registrations.filter { $0.id != account.id }; next.append(account)
        let data = try JSONEncoder().encode(next)
        try persistCredentials(String(decoding:data,as:UTF8.self))
        registrations = next; activeID = account.id
        defaults.set(account.id,forKey:"codexActiveID")
    }
    func select(_ id: String) {
        guard !busy, registrations.contains(where: { $0.id == id }) else { return }
        epoch = UUID(); refreshing?.cancel(); refreshing = nil
        activeID=id; defaults.set(id,forKey:"codexActiveID"); models=[]; error=nil
        updateStatus(); Task { await loadModels() }
    }
    func signIn(existingID: String? = nil) async {
        guard !busy else { return }
        busy=true; error=nil; deviceCode=nil; status="正在申请官方验证码…"
        let attempt=UUID(); attemptID=attempt
        let old=registrations.first { $0.id == existingID }
        do {
            let code=try await CodexOAuth.begin(session:session)
            guard attemptID == attempt else { return }
            deviceCode=code; status="等待官方网页授权 · 切换应用后可继续"
            loginTask=Task { [weak self] in
                guard let self else { return }
                do {
                    let token=try await CodexOAuth.poll(code,session:self.session,beforeRequest:{
                        try await self.waitForActive(until:code.expiresAt)
                    },onRetry:{
                        self.status="连接暂时中断，验证码已保留 · 返回 Melo 后自动继续"
                    })
                    let account=try await CodexOAuth.registration(token,previous:old,session:self.session,beforeRequest:{
                        try await self.waitForActive(until:code.expiresAt)
                    })
                    try Task.checkCancellation()
                    guard self.attemptID == attempt else { return }
                    try self.save(account)
                    self.epoch=UUID(); self.refreshing?.cancel(); self.refreshing=nil
                    self.attemptID=nil; self.deviceCode=nil; self.busy=false; self.loginTask=nil; self.models=[]
                    defaults.set("chatgpt",forKey:"modelAuthMode")
                    self.updateStatus()
                    await self.loadModels()
                } catch {
                    guard self.attemptID == attempt else { return }
                    self.attemptID=nil; self.deviceCode=nil; self.busy=false; self.loginTask=nil
                    self.updateStatus(); self.error=CodexOAuth.loginError(error)
                }
            }
        } catch {
            guard attemptID == attempt else { return }
            attemptID=nil; busy=false; updateStatus(); self.error=CodexOAuth.loginError(error)
        }
    }
    func setApplicationActive(_ active: Bool) { applicationActive=active }
    private func waitForActive(until deadline: Date) async throws {
        while !applicationActive {
            try Task.checkCancellation()
            guard Date() < deadline else { throw MeloError.message("Codex 验证码已过期，请重新获取。") }
            try await Task.sleep(for:.milliseconds(200))
        }
        try Task.checkCancellation()
        guard Date() < deadline else { throw MeloError.message("Codex 验证码已过期，请重新获取。") }
    }
    func cancelLogin() {
        guard attemptID != nil else { return }
        attemptID=nil; loginTask?.cancel(); loginTask=nil; deviceCode=nil; busy=false; updateStatus()
    }
    private func credentials() async throws -> CodexRegistration {
        guard let account=active, !account.refreshToken.isEmpty else { throw MeloError.message(CodexOAuth.loginRequired) }
        if account.expiresAt.timeIntervalSinceNow > 90 { return account }
        if let refreshing { return try await refreshing.value }
        let expectedEpoch=epoch
        let task=Task<CodexRegistration,Error> {
            let token=try await CodexOAuth.refresh(account,session:self.session)
            let updated=try await CodexOAuth.registration(token,previous:account,session:self.session)
            try Task.checkCancellation()
            guard self.epoch == expectedEpoch, self.activeID == account.id else { throw CancellationError() }
            try self.save(updated)
            return updated
        }
        refreshing=task
        defer { if epoch == expectedEpoch { refreshing=nil } }
        return try await task.value
    }
    func loadModels() async {
        guard signedIn else { return }
        let expectedEpoch=epoch
        do {
            let account=try await credentials()
            // Protocol compatibility version, not Melo's application version.
            let request=CodexOAuth.request(path:"/models?client_version=0.180.0",account:account)
            let (data,status)=try await CodexOAuth.data(request,session:session,limit:2_000_000)
            guard status == 200 else { throw MeloError.message("Codex 模型列表读取失败（\(status)）。原模型选择已保留，可稍后刷新。") }
            struct Catalog: Decodable { let models: [ChatGPTModel] }
            let available=try JSONDecoder().decode(Catalog.self,from:data).models.filter { $0.visibility == nil || $0.visibility == "list" }
            guard epoch == expectedEpoch else { return }
            guard !available.isEmpty else { throw MeloError.message("此 Codex 账号暂未提供可用模型，请检查订阅或工作区权限。") }
            models=available
            if (defaults.string(forKey:"chatgptModel") ?? "").isEmpty {
                let initial=available.first(where: { $0.slug == "gpt-6.1-sol" }) ?? available[0]
                defaults.set(initial.slug,forKey:"chatgptModel")
            }
        } catch { if epoch == expectedEpoch { self.error=error.localizedDescription } }
    }
    func signOut() async {
        guard !busy, let account=active else { return }
        busy=true; epoch=UUID(); refreshing?.cancel(); refreshing=nil
        defer { busy=false }
        let revoked=await CodexOAuth.revoke(account,session:session)
        do {
            var cleared=account; cleared.accessToken=""; cleared.refreshToken=""; cleared.idToken=""; cleared.expiresAt = .distantPast
            try save(cleared); models=[]
            defaults.removeObject(forKey:"codexImageVerified:" + account.id)
            updateStatus()
            if !revoked { error="已退出此手机，但未确认远端撤销。可在 ChatGPT 的安全设置中检查授权。" }
        } catch { self.error=error.localizedDescription }
    }
    func reply(messages: [ChatMessage], model: String, instructions: String, imageInputs: [ImageInput] = [], imageTask: ImageTaskPlan? = nil, deviceTools: DeviceToolContext? = nil, allowWebSearch: Bool = true, allowImageTool: Bool = false, statusKey: String? = nil, onObservation: ((ExecutionObservation) -> Void)? = nil, onReceiving: (() -> Void)? = nil) async throws -> ModelReply {
        if imageTask?.makesImage != true { try ConversationHistory.validateCurrentInput(messages.last(where: { $0.role == "user" })?.content ?? "", instructions: instructions) }
        let expectedEpoch = epoch
        func setStatus(_ value: String) {
            if replyStatus != value { replyStatus = value }
            if let statusKey, replyStatuses[statusKey] != value { replyStatuses[statusKey] = value }
        }
        setStatus("正在思考…")
        defer { replyStatus = "正在思考…"; if let statusKey { replyStatuses[statusKey] = nil } }
        let account = try await credentials()
        try Task.checkCancellation()
        guard !model.isEmpty else { throw MeloError.message("请先在设置中刷新并选择 Codex 模型。") }
        let sessionID = UUID().uuidString
        // The device-wide switch and this Agent's phone permission must both allow search.
        let webSearch = allowWebSearch && imageTask?.makesImage != true && (defaults.object(forKey: "webSearchEnabled") as? Bool ?? true)
        var body = ChatGPTRequest.body(messages: messages, model: model, instructions: instructions, webSearch: webSearch)
        if !imageInputs.isEmpty || imageTask?.makesImage == true {
            let imageBody = ImageRequestBody.responses(messages: messages, inputs: imageInputs, task: imageTask ?? ImageTaskPlan(action: .analyze), model: model, instructions: instructions)
            body["input"] = imageBody["input"]
            if imageTask?.makesImage == true { body = CodexRequest.imageBody(messages: messages, inputs: imageInputs, task: imageTask!, model: model, instructions: instructions) }
        }
        // Ordinary replies may still make or edit an image when the wording was not
        // recognised up front: the model decides, instead of saying the tool is missing.
        let offersImageTool = allowImageTool && imageTask?.makesImage != true
        if offersImageTool {
            let plan = imageTask ?? ImageTaskPlan()
            body["tools"] = ((body["tools"] as? [[String: Any]]) ?? []) + [["type": "image_generation", "model": plan.model].merging(plan.size == "auto" ? [:] : ["size": plan.size]) { _, new in new }]
            if body["tool_choice"] == nil { body["tool_choice"] = "auto" }
            body["instructions"] = ((body["instructions"] as? String) ?? "") + "\n你可以调用 image_generation 生成或修改图片。用户要求做图，或附上图片并提出修改要求时，直接调用它交付图片，不要说缺少工具；只是提问或看图分析时不要生成。用户提到之前的图片（如“第二张”“原图”）而本轮没有附带那张图时，不要凭空生成新图，请说明需要哪一张。"
        }
        let imageMode = imageTask?.makesImage == true || offersImageTool
        // Phone data tools are offered only for ordinary replies, never image generation.
        let phoneTools = imageTask?.makesImage == true ? [] : (deviceTools?.policy.tools ?? [])
        if !phoneTools.isEmpty, let deviceTools {
            body["tools"] = ((body["tools"] as? [[String: Any]]) ?? []) + phoneTools.map(\.responsesDefinition)
            body["tool_choice"] = "auto" // Allow phone data before a web lookup (e.g. nearby weather).
            let include = (body["include"] as? [String]) ?? []
            body["include"] = include.contains("reasoning.encrypted_content") ? include : include + ["reasoning.encrypted_content"]
            body["instructions"] = ((body["instructions"] as? String) ?? "") + "\n" + DeviceToolLoop.instructions(deviceTools.policy)
        }
        let mustSearch = webSearch && DeviceToolLoop.requiresWebSearch(messages, policy: deviceTools?.policy ?? DeviceToolPolicy())
        var priorSources: [WebSource] = []
        var sizeFallback = false
        var searchedEarlier = false
        func replyResult(_ stream: ChatGPTStream) throws -> ModelReply {
            let text = try stream.result()
            let searched = searchedEarlier || stream.searched
            if imageTask?.makesImage == true && stream.images.isEmpty { throw MeloError.message("服务未返回完整图片，请确认当前账号或模型支持图片生成。要求和参考图已保留。") }
            if mustSearch && !searched { throw MeloError.message("这次没有取得实际联网搜索结果，请重试或切换支持搜索的模型。消息已保留。") }
            if !stream.images.isEmpty {
                defaults.set(true, forKey: "codexImageVerified:" + account.id)
                imageVerified = true
            }
            let sources = WebReplyFormatter.references(in: "", annotations: priorSources + stream.sources)
            let note = sizeFallback ? "服务未接受所选尺寸 \(imageTask?.size ?? "")，已按服务默认尺寸生成；需要 2K/4K 可改用支持该尺寸的图像 API 连接。" : ""
            return ModelReply(text: [text, note].filter { !$0.isEmpty }.joined(separator: "\n\n"), sources: sources, searched: searched, images: stream.images)
        }
        func streamOnce(_ body: [String: Any]) async throws -> ChatGPTStream {
            try Task.checkCancellation()
            guard epoch == expectedEpoch else { throw CancellationError() }
            var request = CodexOAuth.request(path: "/responses", account: account, method: "POST")
            request.timeoutInterval = imageMode ? 180 : 120
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue(sessionID, forHTTPHeaderField: "session_id")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            var requestObservation = ExecutionObservation()
            requestObservation.stage("model:response", name: "模型请求", status: "running", output: "等待服务返回", model: model)
            onObservation?(requestObservation)
            let requestStarted = ProcessInfo.processInfo.systemUptime
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw MeloError.message("模型服务没有响应。") }
            guard http.statusCode == 200 else {
                if http.statusCode == 401 || http.statusCode == 403 { throw MeloError.message("Codex 登录已失效或此账号未获所选能力（\(http.statusCode)），请到设置重新授权或检查账号权限。") }
                if http.statusCode == 400, ((body["tools"] as? [[String: Any]]) ?? []).contains(where: { $0["type"] as? String == "image_generation" && $0["size"] != nil }) { throw ImageSizeRejected() }
                if [400, 413, 422].contains(http.statusCode) {
                    var errorBody = Data()
                    for try await byte in bytes { errorBody.append(byte); if errorBody.count > 16_384 { break } }
                    if let contextError = Network.contextLimitError(errorBody) { throw contextError }
                    throw MeloError.message("当前账号或模型未接受所选工具、图片或输入内容（\(http.statusCode)）\(Network.rejectionDetail(errorBody))；本次要求和图片已保留。")
                }
                if http.statusCode == 429 { throw MeloError.message("已达到 Codex 使用限额，请检查 ChatGPT 订阅与 Codex 用量。") }
                throw MeloError.message("模型服务暂时不可用，请稍后重试。")
            }
            // Read and parse off the main thread: an image reply is megabytes of
            // base64, and byte-by-byte work here would stall the interface.
            let updates = StreamUpdates(onObservation: onObservation, onReceiving: onReceiving, setStatus: setStatus)
            let stream = try await Self.readStream(bytes, maxBytes: imageMode ? 64 * 1024 * 1024 : 8 * 1024 * 1024, acceptImageCompletion: imageMode, requestStarted: requestStarted, updates: updates)
            try Task.checkCancellation()
            guard epoch == expectedEpoch else { throw CancellationError() }
            return stream
        }
        for _ in 0..<DeviceToolLoop.maxRounds {
            let stream: ChatGPTStream
            do { stream = try await streamOnce(body) }
            catch is ImageSizeRejected {
                // Retry once at the service's default size; the reply says so.
                body["tools"] = ((body["tools"] as? [[String: Any]]) ?? []).map { var tool = $0; if tool["type"] as? String == "image_generation" { tool["size"] = nil }; return tool }
                sizeFallback = true
                stream = try await streamOnce(body)
            }
            let calls = phoneTools.isEmpty ? [] : stream.functionCalls
            guard !calls.isEmpty, let deviceTools else { return try replyResult(stream) }
            // Validate the whole batch before any side effect, then run sequentially.
            try DeviceToolLoop.validateBatch(calls)
            var results: [(callID: String, output: String)] = []
            for call in calls {
                try Task.checkCancellation()
                guard epoch == expectedEpoch else { throw CancellationError() }
                setStatus("正在读取手机数据…")
                let output = await deviceTools.execute(call)
                deviceTools.onCall?(call, output)
                try Task.checkCancellation()
                guard epoch == expectedEpoch else { throw CancellationError() }
                results.append((call.callID, output))
            }
            priorSources += stream.sources
            searchedEarlier = searchedEarlier || stream.searched
            body["input"] = DeviceToolLoop.followUpInput(previous: (body["input"] as? [Any]) ?? [], output: stream.outputItems, results: results)
        }
        throw MeloError.message("手机数据操作超过 \(DeviceToolLoop.maxRounds) 轮仍未得到回答，已停止。已执行的操作见运行记录。")
    }
    /// Hands parser progress to the main actor at most every 150 ms (and always for the first text and the end).
    final class StreamUpdates: @unchecked Sendable {
        let onObservation: ((ExecutionObservation) -> Void)?
        let onReceiving: (() -> Void)?
        let setStatus: (String) -> Void
        init(onObservation: ((ExecutionObservation) -> Void)?, onReceiving: (() -> Void)?, setStatus: @escaping (String) -> Void) {
            self.onObservation = onObservation; self.onReceiving = onReceiving; self.setStatus = setStatus
        }
    }
    nonisolated static func readStream(_ bytes: URLSession.AsyncBytes, maxBytes: Int, acceptImageCompletion: Bool, requestStarted: TimeInterval, updates: StreamUpdates) async throws -> ChatGPTStream {
        var parser = ChatGPTSSE(maxBytes: maxBytes, acceptImageCompletion: acceptImageCompletion, requestStarted: requestStarted)
        var revision = -1, receivedText = false, status = "正在思考…", lastSent = Date.distantPast
        func publish(force: Bool) async {
            let now = Date()
            guard force || now.timeIntervalSince(lastSent) >= 0.15 else { return }
            lastSent = now
            let observation = parser.stream.observation
            let changed = observation.revision != revision
            revision = observation.revision
            let nextStatus = parser.stream.generatingImage ? "正在处理图片…" : parser.stream.searching ? "正在联网搜索…" : parser.stream.searched ? "正在整理搜索结果…" : "正在思考…"
            let statusChanged = nextStatus != status
            status = nextStatus
            guard changed || statusChanged else { return }
            await MainActor.run {
                if changed { updates.onObservation?(observation) }
                if statusChanged { updates.setStatus(nextStatus) }
            }
        }
        for try await byte in bytes {
            try Task.checkCancellation()
            do { try parser.accept(byte) }
            catch { let observation = parser.stream.observation; await MainActor.run { updates.onObservation?(observation) }; throw error }
            if !receivedText && !parser.stream.text.isEmpty { receivedText = true; await MainActor.run { updates.onReceiving?() } }
            if parser.stream.completed { await publish(force: true); return parser.stream }
            if byte == 10 { await publish(force: false) }
        }
        // Reaching here means no completion event: finish() reports truncation.
        _ = try parser.finish()
        await publish(force: true)
        return parser.stream
    }

}
