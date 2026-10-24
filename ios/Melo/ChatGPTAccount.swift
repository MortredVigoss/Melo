import Foundation
import SwiftUI

struct ChatGPTModel: Decodable, Identifiable {
    var id: String { slug }
    let slug: String
    let display_name: String
    let visibility: String?
    var context_window: Int? = nil
    var input_modalities: [String]? = nil
    var output_modalities: [String]? = nil
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
    /// Status of a reply running on another connection (API key with phone tools); nil clears it.
    func setReplyStatus(_ value: String?, for key: String) { replyStatuses[key] = value }
    @Published private(set) var imageVerified = false
    private var loginTask: Task<Void,Never>?
    private var attemptID: UUID?
    private var applicationActive = true
    private var refreshing: Task<CodexRegistration,Error>?
    private var epoch = UUID()
    var routingIdentity: String { (activeID ?? "") + epoch.uuidString }
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
                let initial=available[0]
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
    func routingTransport(messages: [ChatMessage], requestHistory: [ChatMessage], model: String, instructions: String, imageInputs: [ImageInput], tools: AgentLoopTools?, allowWebSearch: Bool, allowImageTool: Bool, cacheKey: String, onObservation: ((ExecutionObservation) -> Void)?) async throws -> CodexResponsesTransport {
        if !imageInputs.isEmpty, let inputs = models.first(where: { $0.slug == model })?.input_modalities, !inputs.contains("image") { throw MeloError.message("此模型已设为不支持图片输入，请选择视觉模型或修改能力设置。") }
        let expectedEpoch = epoch
        var tools = tools
        let permittedDefinitions = tools?.definitions.filter { ChatGPTRequest.allowsTool($0.name, messages: requestHistory) } ?? []
        tools?.definitions = permittedDefinitions
        let account = try await credentials()
        try Task.checkCancellation()
        var body = ChatGPTRequest.body(messages: messages, requestHistory: requestHistory, model: model, instructions: instructions, webSearch: allowWebSearch && (defaults.object(forKey: "webSearchEnabled") as? Bool ?? true), cacheKey: cacheKey)
        if !imageInputs.isEmpty { body["input"] = ImageRequestBody.responses(messages: ChatGPTRequest.withCurrentTime(messages), inputs: imageInputs, task: ImageTaskPlan(action: .analyze), model: model, instructions: instructions)["input"] }
        body["tools"] = ((body["tools"] as? [[String: Any]]) ?? []) + ((tools?.definitions ?? []) + [PhoneRoutingHost.control]).map(\.responsesDefinition)
        if allowImageTool && ChatGPTRequest.allowsTool("image", messages: requestHistory) { body["tools"] = ((body["tools"] as? [[String: Any]]) ?? []) + [["type": "image_generation", "model": ImageTaskPlan().model]] }
        body["tool_choice"] = "auto"
        body["instructions"] = ((body["instructions"] as? String) ?? "") + "\n" + (tools?.instructionsWithContract ?? "")
        let updates = StreamUpdates(onObservation: onObservation, onReceiving: nil, setStatus: { _ in })
        return CodexResponsesTransport(account: account, session: session, sessionID: UUID().uuidString, model: model, base: body, offersTools: true, imageMode: allowImageTool, updates: updates, isCurrent: { [weak self] in self?.epoch == expectedEpoch })
    }

    func reply(messages: [ChatMessage], requestHistory: [ChatMessage]? = nil, model: String, instructions: String, imageInputs: [ImageInput] = [], imageTask: ImageTaskPlan? = nil, deviceTools: DeviceToolContext? = nil, allowWebSearch: Bool = true, allowImageTool: Bool = false, statusKey: String? = nil, cacheKey: String? = nil, budget: PhoneRunBudget? = nil, verification: AgentVerification? = nil, hooks: AgentLoopHooks = AgentLoopHooks(), onObservation: ((ExecutionObservation) -> Void)? = nil, onReceiving: (() -> Void)? = nil) async throws -> ModelReply {
        if !imageInputs.isEmpty, let inputs = models.first(where: { $0.slug == model })?.input_modalities, !inputs.contains("image") { throw MeloError.message("此模型已设为不支持图片输入，请选择视觉模型或修改能力设置。") }
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
        var body = ChatGPTRequest.body(messages: messages, requestHistory: requestHistory, model: model, instructions: instructions, webSearch: webSearch, cacheKey: cacheKey)
        if !imageInputs.isEmpty || imageTask?.makesImage == true {
            // Analysis replaces the text-only input; retain the per-turn clock too.
            let imageMessages = imageTask?.makesImage == true ? messages : ChatGPTRequest.withCurrentTime(messages)
            let imageBody = ImageRequestBody.responses(messages: imageMessages, inputs: imageInputs, task: imageTask ?? ImageTaskPlan(action: .analyze), model: model, instructions: instructions)
            body["input"] = imageBody["input"]
            if imageTask?.makesImage == true { body = CodexRequest.imageBody(messages: messages, inputs: imageInputs, task: imageTask!, model: model, instructions: instructions) }
        }
        // Ordinary replies may still make or edit an image when the wording was not
        // recognised up front: the model decides, instead of saying the tool is missing.
        let offersImageTool = allowImageTool && imageTask?.makesImage != true && ChatGPTRequest.allowsTool("image", messages: requestHistory ?? messages)
        if offersImageTool {
            let plan = imageTask ?? ImageTaskPlan()
            body["tools"] = ((body["tools"] as? [[String: Any]]) ?? []) + [["type": "image_generation", "model": plan.model].merging(plan.size == "auto" ? [:] : ["size": plan.size]) { _, new in new }]
            if body["tool_choice"] == nil { body["tool_choice"] = "auto" }
            body["instructions"] = ((body["instructions"] as? String) ?? "") + "\n你可以调用 image_generation 生成或修改图片。用户要求做图，或附上图片并提出修改要求时，直接调用它交付图片，不要说缺少工具；只是提问或看图分析时不要生成。用户提到之前的图片（如“第二张”“原图”）而本轮没有附带那张图时，不要凭空生成新图，请说明需要哪一张。"
        }
        let imageMode = imageTask?.makesImage == true || offersImageTool
        // Phone tools (device data + web pages + read_history) are offered only for ordinary replies, never image generation.
        let phoneTools = imageTask?.makesImage == true ? [] : (deviceTools?.definitions ?? []).filter { ChatGPTRequest.allowsTool($0.name, messages: requestHistory ?? messages) }
        var loopTools: AgentLoopTools?
        if !phoneTools.isEmpty, let deviceTools {
            let tools = AgentLoopTools(definitions: phoneTools, instructions: deviceTools.instructions, perform: deviceTools.perform, statusText: deviceTools.statusText)
            loopTools = tools
            body["tools"] = ((body["tools"] as? [[String: Any]]) ?? []) + phoneTools.map(\.responsesDefinition)
            // Let the model resolve local context before a public lookup.
            body["tool_choice"] = "auto"
            let include = (body["include"] as? [String]) ?? []
            body["include"] = include.contains("reasoning.encrypted_content") ? include : include + ["reasoning.encrypted_content"]
            body["instructions"] = ((body["instructions"] as? String) ?? "") + "\n" + tools.instructionsWithContract
        }
        let updates = StreamUpdates(onObservation: onObservation, onReceiving: onReceiving, setStatus: setStatus)
        let transport = CodexResponsesTransport(account: account, session: session, sessionID: sessionID, model: model, base: body, offersTools: loopTools != nil, imageMode: imageMode, updates: updates,
                                                isCurrent: { [weak self] in self?.epoch == expectedEpoch })
        var loopHooks = hooks
        if loopHooks.onStatus == nil { loopHooks.onStatus = { setStatus($0) } }
        let loop = AgentLoop(transport: transport, tools: loopTools, budget: budget ?? PhoneRunBudget(), latestUserMessage: (requestHistory ?? messages).last(where: { $0.role == "user" })?.content ?? "", verification: imageTask?.makesImage == true ? nil : verification, hooks: loopHooks)
        let makesImage = imageTask?.makesImage == true
        loop.nativeSearchAvailable = webSearch
        loop.goalHistory = requestHistory ?? messages
        loop.validate = { outcome in
            guard outcome.stop == .answered else { return }
            if makesImage && (outcome.finalRound?.images.isEmpty ?? true) { throw MeloError.message("服务未返回完整图片，请确认当前账号或模型支持图片生成。要求和参考图已保留。") }
            // Missing search evidence is handled by the shared goal check;
            // preserve the candidate and expose its incomplete receipt.
        }
        let outcome = try await loop.run()
        try Task.checkCancellation()
        guard epoch == expectedEpoch else { throw CancellationError() }
        let images = outcome.stop == .answered ? (outcome.finalRound?.images ?? []) : []
        if !images.isEmpty {
            defaults.set(true, forKey: "codexImageVerified:" + account.id)
            imageVerified = true
        }
        let sources = WebReplyFormatter.references(in: "", annotations: outcome.sources)
        let note = transport.sizeFallback ? "服务未接受所选尺寸 \(imageTask?.size ?? "")，已按服务默认尺寸生成；需要 2K/4K 可改用支持该尺寸的图像 API 连接。" : ""
        return ModelReply(text: [outcome.text, note].filter { !$0.isEmpty }.joined(separator: "\n\n"), sources: sources, searched: outcome.searched, images: images, completion: outcome.completion)
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

/// Codex Responses (streaming, store:false) as a single-round AgentLoop
/// transport. Round 1 sends the body built by ChatGPTAccount.reply unchanged
/// (available web_search, `reasoning.encrypted_content`, image items); later
/// rounds replay every output item verbatim, one function_call_output per call
/// and this round's screenshots. Completion checks use a separate tool-free body.
final class CodexResponsesTransport: AgentModelTransport, @unchecked Sendable {
    var routingContextLimit: Int? = nil
    let account: CodexRegistration, session: URLSession, sessionID: String, model: String
    private(set) var base: [String: Any]
    let offersTools: Bool
    let imageMode: Bool
    var timeoutCap: TimeInterval { imageMode ? 180 : 120 }
    private(set) var sizeFallback = false
    let updates: ChatGPTAccount.StreamUpdates
    let isCurrent: @MainActor () -> Bool

    init(account: CodexRegistration, session: URLSession, sessionID: String, model: String, base: [String: Any], offersTools: Bool, imageMode: Bool, updates: ChatGPTAccount.StreamUpdates, isCurrent: @escaping @MainActor () -> Bool) {
        self.account = account; self.session = session; self.sessionID = sessionID; self.model = model
        self.base = base; self.offersTools = offersTools; self.imageMode = imageMode; self.updates = updates; self.isCurrent = isCurrent
    }

    /// Input items for one request: the base input plus the rendered transcript.
    static func rendered(_ input: [Any], transcript: [AgentTranscriptItem]) -> [Any] {
        var items = input
        for item in transcript {
            switch item {
            case .toolRound(let round, let results):
                let output: [[String: Any]]
                if case .responses(let original) = round.echo { output = original }
                else { output = (round.text.isEmpty ? [] : [["type": "message", "role": "assistant", "content": [["type": "output_text", "text": round.text]]]]) + round.calls.map { ["type": "function_call", "call_id": $0.callID, "name": $0.name, "arguments": $0.arguments] } }
                items = DeviceToolLoop.followUpInput(previous: items, output: output, results: results.map { (callID: $0.call.callID, result: $0.phoneResult) })
            case .userText(let text): items.append(["role": "user", "content": text])
            }
        }
        return items
    }

    private func checkCurrent() async throws {
        try Task.checkCancellation()
        guard await isCurrent() else { throw CancellationError() }
    }

    private func stream(_ body: [String: Any], timeout: TimeInterval, observe: Bool) async throws -> (ChatGPTStream, Int) {
        try await checkCurrent()
        var request = CodexOAuth.request(path: "/responses", account: account, method: "POST")
        request.timeoutInterval = max(1, min(timeoutCap, timeout))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(sessionID, forHTTPHeaderField: "session_id")
        let payload = try JSONSerialization.data(withJSONObject: body)
        request.httpBody = payload
        if observe {
            var requestObservation = ExecutionObservation()
            requestObservation.stage("model:response", name: "模型请求", status: "running", output: "等待服务返回", model: model)
            let updates = self.updates, snapshot = requestObservation
            await MainActor.run { updates.onObservation?(snapshot) }
        }
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
                let message = "当前账号或模型未接受所选工具、图片或输入内容（\(http.statusCode)）\(Network.rejectionDetail(errorBody))；本次要求和图片已保留。"
                if http.statusCode == 413 { throw RequestTooLarge(message: message) }
                throw MeloError.message(message)
            }
            if http.statusCode == 429 { throw MeloError.message("已达到 Codex 使用限额，请检查 ChatGPT 订阅与 Codex 用量。") }
            throw MeloError.message("模型服务暂时不可用，请稍后重试。")
        }
        // Read and parse off the main thread: an image reply is megabytes of
        // base64, and byte-by-byte work here would stall the interface.
        let quiet = ChatGPTAccount.StreamUpdates(onObservation: nil, onReceiving: nil, setStatus: { _ in })
        let stream = try await ChatGPTAccount.readStream(bytes, maxBytes: imageMode ? 64 * 1024 * 1024 : 8 * 1024 * 1024, acceptImageCompletion: imageMode, requestStarted: requestStarted, updates: observe ? updates : quiet)
        try await checkCurrent()
        return (stream, RequestSizeEstimate.tokens(payload))
    }
    /// Input tokens the service reported for this response, when it did.
    static func inputTokens(_ stream: ChatGPTStream, key: String = "input") -> Int? {
        guard let usage = stream.observation.pipeline.first(where: { $0.id == "model:response" })?.api?["usage"], case .number(let value) = usage[key], value.isFinite, value >= 0, value < Double(Int.max) else { return nil }
        return Network.usageNumber(NSNumber(value: value))
    }

    func round(_ input: AgentLoopRequest) async throws -> AgentRound {
        var body = base
        if let review = input.goalReview {
            body = ["model": model, "stream": true, "store": false, "instructions": review["systemPrompt"] as? String ?? "", "input": review["messages"] as? [[String: Any]] ?? []]
        } else if !input.transcript.isEmpty {
            body["input"] = Self.rendered(base["input"] as? [Any] ?? [], transcript: input.transcript)
            if body["tool_choice"] != nil { body["tool_choice"] = "auto" }
        }
        if input.repairing { body["tools"] = (body["tools"] as? [[String: Any]])?.filter { $0["type"] as? String != "image_generation" } }
        _ = try PhoneMemberLimits.outputAllowance(body: body, remaining: input.remainingTokens)
        if let limit = routingContextLimit, RequestSizeEstimate.tokens(try JSONSerialization.data(withJSONObject: body)) > limit { throw RequestTooLarge(message: "所选模型上下文容量不足；原对话和已执行结果已保留，请选择容量更大的模型。") }
        var result: (ChatGPTStream, Int)
        do { result = try await stream(body, timeout: input.timeout, observe: input.goalReview == nil) }
        catch is ImageSizeRejected where input.goalReview == nil && !input.repairing {
            // Retry once at the service's default size; the reply says so.
            base["tools"] = ((base["tools"] as? [[String: Any]]) ?? []).map { var tool = $0; if tool["type"] as? String == "image_generation" { tool["size"] = nil }; return tool }
            body["tools"] = base["tools"]
            sizeFallback = true
            result = try await stream(body, timeout: input.timeout, observe: true)
        }
        let (stream, estimate) = result
        let calls = input.goalReview == nil && offersTools ? stream.functionCalls : []
        let text = calls.isEmpty ? try stream.result() : stream.text
        return AgentRound(text: text, calls: calls, echo: .responses(stream.outputItems), sources: stream.sources, searched: stream.searched, images: stream.images,
                          inputTokens: Self.inputTokens(stream), estimatedInputTokens: estimate, outputTokens: Self.inputTokens(stream, key: "output"))
    }

    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String {
        let body: [String: Any] = ["model": model, "stream": true, "store": false, "instructions": system, "input": messages.map { ["role": $0.role, "content": $0.content] }]
        return try await stream(body, timeout: timeout, observe: false).0.result()
    }
}
