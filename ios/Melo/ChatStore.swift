import SwiftUI

@MainActor final class ChatStore: ObservableObject {
    @Published var taskCheckpoints: [TaskCheckpoint] = []
    @Published var taskHandoffs: [TaskHandoff] = []
    @Published var chats: [Conversation] = []
    // Drafts are local-only and survive history switches and application restarts.
    var selectedConversationID: String?
    @Published var composerDrafts: [String: ConversationDraft] = [:] { didSet { scheduleDraftSave() } }
    private var draftSaveTask: Task<Void, Never>?
    private var draftsReady = false
    private var draftsFile: URL { file.deletingLastPathComponent().appendingPathComponent("composer-drafts.json") }
    @Published var sendingID: String?
    @Published private(set) var activeImageAction: ImageAction?
    @Published private(set) var replyBackgroundStatus = ""
    @Published var syncing = false
    @Published var error: String?
    @Published var syncStatus = "仅保存在此 iPhone"
    @Published var storageReady = true
    var taskSpaceDiagnosticPending = ProcessInfo.processInfo.arguments.contains("-melo-open-task-space")
    let account = ChatGPTAccount()
    let imageLibrary: ImageLibrary
    @Published private(set) var imageRevision = 0
    @Published var preferences = MobilePreferences()
    @Published private(set) var executionRecords: [ExecutionRecord] = []
    private var executionReady = true
    private var lastSceneSave = Date.distantPast
    private var sceneFile: URL { file.deletingLastPathComponent().appendingPathComponent("execution-records.json") }
    private(set) var deletedChats: [DeletedChat] = []
    private var automaticSyncTask: Task<Void, Never>?
    private var automaticSyncPending = false
    private let syncLoader: ((Data) async throws -> Data)?
    private var sendTask: Task<Void, Never>?
    private let replyBackground: ReplyBackgroundLifetime
    private var expiredRunID: String?
    private var isBackground = false
    private let replyLoader: (([ChatMessage], String) async throws -> ModelReply)?
    private let file: URL
    private var preferencesFile: URL { file.deletingLastPathComponent().appendingPathComponent("preferences.json") }
    private var syncRecoveryFile: URL { file.deletingLastPathComponent().appendingPathComponent("pending-sync.json") }
    private let loadConnections: () throws -> [LLMConnection]
    init(directory: URL? = nil, background: ReplyBackgroundLifetime? = nil, replyLoader: (([ChatMessage], String) async throws -> ModelReply)? = nil, syncLoader: ((Data) async throws -> Data)? = nil, loadConnections: @escaping () throws -> [LLMConnection] = LLMConnection.saved) {
        self.loadConnections = loadConnections
        self.replyLoader = replyLoader
        self.syncLoader = syncLoader
        imageLibrary = ImageLibrary(directory: (directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo")).appendingPathComponent("Images"))
        replyBackground = background ?? ReplyBackgroundLifetime(scheduler: IOSReplyBackground())
        file = (directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo")).appendingPathComponent("conversations.json")
        replyBackground.onProtectionChange = { [weak self] protection in
            switch protection {
            case .continued: self?.replyBackgroundStatus = "可切换应用 · 后台继续，系统可随时停止"
            case .limited: self?.replyBackgroundStatus = "已申请短时后台续行 · 时长由系统决定"
            case .unavailable: self?.replyBackgroundStatus = "当前未获后台执行时间，请保持应用在前台"
            }
        }
        do {
            try BackgroundReplyStorage.prepare([file, preferencesFile, sceneFile])
            if FileManager.default.fileExists(atPath: syncRecoveryFile.path) {
                let recovery = try JSONDecoder().decode(SyncRecovery.self, from: Data(contentsOf: syncRecoveryFile))
                try writeSyncRecovery(recovery)
            }
            if FileManager.default.fileExists(atPath: file.path) {
                let snapshot = try JSONDecoder().decode(SyncSnapshot.self, from: Data(contentsOf: file))
                guard snapshot.version == 1 else { throw MeloError.message("本地数据版本不兼容。") }
                deletedChats = try mergeDeletedChats([], snapshot.deletedChats ?? [])
                chats = try merge([], snapshot.chats, deletedChats: deletedChats)
                taskCheckpoints = try mergeTaskCheckpoints([], snapshot.tasks ?? [])
                taskHandoffs = try mergeHandoffs([], snapshot.handoffs ?? [])
            }
            if FileManager.default.fileExists(atPath: preferencesFile.path) { preferences = try JSONDecoder().decode(MobilePreferences.self, from: Data(contentsOf: preferencesFile)) }
        } catch { storageReady = false; self.error = "无法读取本地记录。为避免覆盖原文件，已暂停写入。" }
        do {
            if FileManager.default.fileExists(atPath: draftsFile.path) {
                try BackgroundReplyStorage.prepare([draftsFile])
                composerDrafts = try JSONDecoder().decode([String: ConversationDraft].self, from: Data(contentsOf: draftsFile))
            }
            draftsReady = true
        } catch { self.error = "草稿文件无法读取，原文件已保留；本次输入仍可使用，但暂不能保存草稿。" }
        loadExecutionRecords()
        if storageReady && executionReady && !deletedChats.isEmpty {
            do {
                var next = preferences; quarantineDeletedMemories(&next, deleted: deletedChats)
                let records = executionRecords.filter { r in !deletedChats.contains { $0.id == r.chatId } }
                if records != executionRecords || next.memoryFacts != preferences.memoryFacts {
                    try commitSync(.init(snapshot: .init(chats: chats, tasks: taskCheckpoints, handoffs: taskHandoffs, deletedChats: deletedChats), preferences: next, records: records))
                    preferences = next; executionRecords = records
                }
            } catch { self.error = error.localizedDescription }
        }
        migrateLegacyReferences()
    }
    private func scheduleDraftSave() {
        guard draftsReady else { return }
        draftSaveTask?.cancel()
        draftSaveTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            self?.flushDrafts()
        }
    }
    func flushDrafts() {
        draftSaveTask?.cancel(); draftSaveTask = nil
        guard draftsReady, storageReady else { return }
        do {
            let live = Set(chats.map(\.id))
            let drafts = composerDrafts.filter { live.contains($0.key) }
            try BackgroundReplyStorage.write(JSONEncoder().encode(drafts), to: draftsFile)
        } catch { self.error = "草稿暂未保存，请保留当前页面后重试。" }
    }
    private func migrateLegacyReferences() {
        guard executionReady, storageReady else { return }
        let reconciled = ExecutionRecord.reconcilingHistory(executionRecords, chats: chats, messageSources: preferences.messageSources ?? [:])
        if reconciled != executionRecords { executionRecords = reconciled; saveExecutionRecords() }
    }
    private func loadExecutionRecords() {
        guard storageReady else { executionReady = false; return }
        guard FileManager.default.fileExists(atPath: sceneFile.path) else { return }
        do {
            executionRecords = try JSONDecoder().decode([ExecutionRecord].self, from: Data(contentsOf: sceneFile))
            for index in executionRecords.indices where !executionRecords[index].terminal { executionRecords[index].finish("interrupted") }
            saveExecutionRecords()
        } catch { executionReady = false; self.error = "任务回看记录读取失败，已保留原文件。对话仍可使用。" }
    }
    private func saveExecutionRecords() {
        guard executionReady, storageReady else { return }
        do {
            try FileManager.default.createDirectory(at: sceneFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            try BackgroundReplyStorage.write(JSONEncoder().encode(executionRecords), to: sceneFile)
            lastSceneSave = Date()
        } catch { self.error = "任务记录暂未保存，聊天记录不受影响。" }
    }
    private func observe(_ value: ExecutionObservation, runID: String) {
        guard let index = executionRecords.firstIndex(where: { $0.runId == runID }) else { return }
        guard !executionRecords[index].terminal else { return }
        executionRecords[index].observe(value)
        if !value.operations.isEmpty || value.returnedModel != nil {
            replyBackground.update(runID: runID, completed: 1, subtitle: "正在接收回复与检索结果")
        }
        if Date().timeIntervalSince(lastSceneSave) > 0.5 { saveExecutionRecords() }
    }
    private func finishRun(_ runID: String, state: String, message: ChatMessage? = nil, sources: [WebSource] = []) {
        guard let index = executionRecords.firstIndex(where: { $0.runId == runID }) else { return }
        executionRecords[index].finish(state, messageID: message?.id)
        if let message { executionRecords[index].reconcileReferences(message: message, annotations: sources) }
        saveExecutionRecords()
    }
    func scenes(for chatID: String) -> [ExecutionRecord] { executionRecords.filter { $0.chatId == chatID } }
    func execution(for messageID: String) -> ExecutionRecord? { executionRecords.last { $0.messageId == messageID } }
    private func stage(_ runID: String, id: String, name: String, status: String, output: String = "", model: String? = nil) {
        guard let index = executionRecords.firstIndex(where: { $0.runId == runID }) else { return }
        executionRecords[index].recordStage(id, name: name, status: status, output: output, model: model)
    }
    func markRendered(_ messageID: String) {
        guard let index = executionRecords.firstIndex(where: { $0.messageId == messageID }), executionRecords[index].pipeline?.contains(where: { $0.id == "reply:render" }) != true else { return }
        executionRecords[index].markRendered(messageID: messageID); saveExecutionRecords()
    }
    func save() throws {
        guard storageReady else { throw MeloError.message("本地存储需要恢复，暂时无法写入。") }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try BackgroundReplyStorage.write(JSONEncoder().encode(SyncSnapshot(chats: chats, tasks: taskCheckpoints, handoffs: taskHandoffs, deletedChats: deletedChats)), to: file)
    }
    @discardableResult func updatePreferences(_ change: (inout MobilePreferences) -> Void, reportFailure: Bool = true) -> Bool {
        guard storageReady else { return false }
        var next = preferences; change(&next)
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try BackgroundReplyStorage.write(JSONEncoder().encode(next), to: preferencesFile)
            preferences = next
            return true
        } catch { if reportFailure { self.error = "无法保存手机设置，原设置已保留。" }; return false }
    }
    func agent(for chatID: String) -> AgentProfile {
        if let projectID = preferences.chatProjects?[chatID], let agentID = preferences.chatAgents[chatID], let override = preferences.projectAgents?[projectID]?[agentID] { return override }
        return preferences.agents.first { $0.id == preferences.chatAgents[chatID] } ?? preferences.agents.first ?? AgentProfile.defaults[0]
    }
    func selectAgent(_ id: String, chatID: String) {
        guard sendingID != chatID, preferences.agents.contains(where: { $0.id == id }) else { return }
        updatePreferences { $0.chatAgents[chatID] = id }
    }
    func selectModel(_ model: ConversationModel?, chatID: String) {
        guard sendingID != chatID else { return }
        updatePreferences { if $0.chatModels == nil { $0.chatModels = [:] }; $0.chatModels?[chatID] = model }
    }
    func project(for chatID: String) -> PersonalProject? { preferences.projects?.first { $0.id == preferences.chatProjects?[chatID] } }
    func knowledge(for chatID: String) -> [KnowledgeNote] { ConversationContext.notes(preferences: preferences, chatID: chatID) }
    func rename(_ chatID: String, to title: String) {
        guard let index = chats.firstIndex(where: { $0.id == chatID }), !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let original = chats[index]
        chats[index].title = String(title.prefix(100)); chats[index].updatedAt = timestamp()
        do { try save() } catch { chats[index] = original; self.error = error.localizedDescription }
    }
    func newChat(agentID: String = "melo", projectID: String? = nil) -> String? {
        if preferences.projects?.first(where: { $0.id == projectID })?.archived == true { error = "请先恢复此项目，再创建对话。"; return nil }
        let chat = Conversation()
        chats.insert(chat, at: 0)
        do { try save(); guard updatePreferences({ $0.chatAgents[chat.id] = agentID; if let projectID { if $0.chatProjects == nil { $0.chatProjects = [:] }; $0.chatProjects?[chat.id] = projectID } }) else { chats.removeAll { $0.id == chat.id }; try save(); return nil }; return chat.id } catch { chats.removeAll { $0.id == chat.id }; self.error = error.localizedDescription; return nil }
    }
    @discardableResult func deleteConversation(_ chatID: String) -> Bool {
        guard storageReady, executionReady, sendingID != chatID, chats.contains(where: { $0.id == chatID }) else { return false }
        do {
            let nextDeleted = try mergeDeletedChats(deletedChats, [.init(id: chatID, deletedAt: timestamp())])
            let nextChats = try merge(chats, [], deletedChats: nextDeleted)
            var nextPreferences = preferences
            quarantineDeletedMemories(&nextPreferences, deleted: nextDeleted)
            nextPreferences.workspaceSync = nextPreferences.workspaceSync?.excluding(nextDeleted)
            try commitSync(.init(snapshot: .init(chats: nextChats, tasks: taskCheckpoints, handoffs: taskHandoffs, deletedChats: nextDeleted), preferences: nextPreferences, records: executionRecords.filter { $0.chatId != chatID }))
            deletedChats = nextDeleted; chats = nextChats; preferences = nextPreferences
            executionRecords.removeAll { $0.chatId == chatID }; imageRevision += 1
            composerDrafts[chatID] = nil; flushDrafts()
            scheduleAutomaticSync()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func send(_ text: String, chatID: String, retry: Bool = false, imageTask: ImageTaskPlan? = nil, onPreflightFailure: ((String) -> Void)? = nil) {
        func fail(_ reason: String) { if let onPreflightFailure { onPreflightFailure(reason) } else { self.error = reason } }
        guard sendingID == nil, storageReady, let index = chats.firstIndex(where: { $0.id == chatID }) else { onPreflightFailure?("当前无法发送，请确认对话存在且没有其他请求进行中。"); return }
        var clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !retry, clean.isEmpty, imageTask?.references.isEmpty == false {
            guard imageTask?.makesImage != true else { fail("请先填写想怎样修改或生成图片。"); return }
            clean = "请分析这些图片。"
        }
        guard retry || !clean.isEmpty else { return }
        var plan: ImageTaskPlan
        let imageInputs: [ImageInput]
        do {
            let previousImages = chats[index].messages.reversed().compactMap { message -> [String]? in
                let images = imageLibrary.images(for: message.id); return images.isEmpty ? nil : images.map(\.id)
            }.first ?? []
            if retry, let last = chats[index].messages.last {
                clean = last.content
                plan = try (imageLibrary.index.requests[last.id] ?? ImageTaskPlan(action: .analyze)).resolved(prompt: clean, previousImages: [])
            } else { plan = try (imageTask ?? ImageTaskPlan()).resolved(prompt: clean, previousImages: previousImages) }
            // A deliberate retry may choose a new image connection; keep the original input and other parameters.
            if retry, let connectionID = imageTask?.connectionID { plan.connectionID = connectionID }
            imageInputs = try imageLibrary.inputs(plan.references)
        } catch { fail(error.localizedDescription); return }
        do { try ConversationContext.validate(preferences: preferences, chatID: chatID) } catch { fail(error.localizedDescription); return }
        let choice = preferences.chatModels?[chatID]
        let selectedAgent = agent(for: chatID)
        let roleModel = selectedAgent.model?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var useChatGPT = choice.map { $0.connectionID == "chatgpt" } ?? ((UserDefaults.standard.string(forKey: "modelAuthMode") ?? "chatgpt") == "chatgpt")
        var endpoint = UserDefaults.standard.string(forKey: "modelEndpoint") ?? ""
        var model = UserDefaults.standard.string(forKey: "modelName") ?? ""
        if choice == nil && !roleModel.isEmpty { model = roleModel }
        var key = Secrets.read("modelKey")
        var apiProtocol = UserDefaults.standard.string(forKey: "modelProtocol") ?? "chat-completions"
        if let choice, !useChatGPT, !(plan.makesImage && plan.connectionID?.isEmpty == false) {
            do {
                guard let connection = LLMConnection.resolve(choice, in: try loadConnections()) else { throw MeloError.message("本对话选择的模型连接尚未在此设备配置，请连接对应平台或重新选择。") }
                endpoint = try connection.endpoint(); model = choice.model; key = connection.key; apiProtocol = connection.apiProtocol
            } catch { fail(error.localizedDescription); return }
        }
        if plan.makesImage, plan.connectionID == "chatgpt" { useChatGPT = true }
        else if plan.makesImage, let connectionID = plan.connectionID, !connectionID.isEmpty {
            do {
                guard let connection = try loadConnections().first(where: { $0.id == connectionID }) else { throw MeloError.message("所选图片连接尚未在此手机配置，请重新选择；原图和要求已保留。") }
                endpoint = try connection.endpoint(); key = connection.key; apiProtocol = connection.apiProtocol
                useChatGPT = false
            } catch { fail(error.localizedDescription); return }
        }
        let defaultCodexModel = UserDefaults.standard.string(forKey: "chatgptModel") ?? ""
        let explicitCodexImage = plan.makesImage && plan.connectionID == "chatgpt"
        let chatGPTModel = explicitCodexImage && choice?.connectionID != "chatgpt" ? defaultCodexModel : choice?.model ?? (roleModel.isEmpty ? defaultCodexModel : roleModel)
        var instructions = ConversationContext.instructions(agent: selectedAgent, project: project(for: chatID), notes: knowledge(for: chatID))
        if !plan.makesImage {
            do { try ConversationHistory.validateCurrentInput(clean, instructions: instructions) }
            catch { fail(error.localizedDescription); return }
        }
        if replyLoader == nil {
            do { try plan.validateRoute(useChatGPT: useChatGPT, apiProtocol: apiProtocol) }
            catch { fail(error.localizedDescription); return }
        }
        if replyLoader == nil {
            do {
                if useChatGPT {
                    guard account.signedIn, !chatGPTModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MeloError.message(CodexOAuth.loginRequired + " 请在模型服务中选择可用模型。") }
                } else {
                    guard !key.isEmpty, !(plan.makesImage ? plan.model : model).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw MeloError.message("请先配置本对话的模型与 API 密钥。") }
                    _ = try Network.endpoint(endpoint)
                }
            } catch { fail(error.localizedDescription); return }
        }
        if retry, plan.makesImage, let question = chats[index].messages.last, question.role == "user" {
            do { try imageLibrary.bind(plan.references.compactMap { imageLibrary.index.assets[$0.id] }, to: question.id, request: plan) }
            catch { fail(error.localizedDescription); return }
        }
        if !retry {
            let original = chats[index]
            let question = ChatMessage(role: "user", content: clean)
            if plan.makesImage || !plan.references.isEmpty {
                do { try imageLibrary.bind(plan.references.compactMap { imageLibrary.index.assets[$0.id] }, to: question.id, request: plan); imageRevision += 1 }
                catch { fail(error.localizedDescription); return }
            }
            chats[index].messages.append(question)
            if chats[index].messages.count == 1 { chats[index].title = String(clean.prefix(50)) }
            chats[index].updatedAt = timestamp()
            do { try save() } catch { chats[index] = original; fail(error.localizedDescription); return }
        }
        if let question = chats[index].messages.last, question.role == "user" {
            let extracted = MobileMemoryExtraction.extract(message: question, chatID: chatID, agentID: selectedAgent.id, projectID: project(for: chatID)?.id)
            if !extracted.isEmpty {
                _ = updatePreferences({ p in
                    var facts = p.memoryFacts ?? []
                    for fact in extracted where !facts.contains(where: { $0.id == fact.id }) { facts.append(fact) }
                    p.memoryFacts = facts
                }, reportFailure: false)
            }
        }
        var recalled: (facts: [MobileMemoryFact], semantic: Bool) = plan.makesImage ? ([], false) : MobileMemoryRecall.recall(preferences.memoryFacts ?? [], query: clean, chatID: chatID, projectID: project(for: chatID)?.id, agentID: selectedAgent.id, liveChats: Set(chats.map(\.id)), conflicts: Set((preferences.workspaceSync?.conflicts ?? []).filter { $0.kind == "memory" }.map(\.id)), hasAttachments: !plan.references.isEmpty)
        let memoryBudget = max(0, ConversationHistory.textByteBudget - ConversationHistory.instructionReserve - clean.utf8.count - instructions.utf8.count - 64)
        recalled.facts = plan.makesImage ? [] : MobileMemoryRecall.withinBudget(recalled.facts, remainingBytes: memoryBudget)
        instructions += MobileMemoryRecall.instructions(recalled.facts)
        let history = chats[index].messages
        guard history.last?.role == "user" else { return }
        let record = ExecutionRecord(chatId: chatID, query: history.last?.content ?? "", requestedModel: useChatGPT ? chatGPTModel : plan.makesImage ? plan.model : model)
        executionRecords.append(record); saveExecutionRecords()
        activeImageAction = plan.makesImage ? plan.action : nil
        sendingID = chatID
        expiredRunID = nil
        replyBackground.begin(runID: record.runId) { [weak self] in
            guard let self else { return }
            self.expiredRunID = record.runId
            self.finishRun(record.runId, state: "interrupted")
            self.sendTask?.cancel()
        }
        sendTask = Task {
            var completed = false
            defer {
                replyBackground.finish(runID: record.runId, success: completed)
                sendingID = nil; sendTask = nil; activeImageAction = nil
                if completed && !isBackground { scheduleAutomaticSync() }
            }
            do {
                try Task.checkCancellation()
                let reply: ModelReply
                if let replyLoader { reply = try await replyLoader(history, instructions) }
                else if useChatGPT { reply = try await account.reply(messages: history, model: chatGPTModel, instructions: instructions, imageInputs: imageInputs, imageTask: plan, onObservation: { observation in self.observe(observation, runID: record.runId) }, onReceiving: { self.replyBackground.update(runID: record.runId, completed: 1, subtitle: "正在接收回答") }) }
                else if plan.makesImage {
                    reply = try await ImageNetwork.reply(prompt: clean, task: plan, inputs: imageInputs, endpoint: endpoint, token: key, onObservation: { self.observe($0, runID: record.runId) })
                } else {
                    reply = try await Network.reply(messages: history, endpoint: endpoint, model: model, token: key, instructions: instructions, apiProtocol: apiProtocol, imageInputs: imageInputs, onObservation: { observation in self.observe(observation, runID: record.runId) })
                }
                try Task.checkCancellation()
                replyBackground.update(runID: record.runId, completed: 2, subtitle: "正在保存完整回答")
                guard let position = chats.firstIndex(where: { $0.id == chatID }) else { finishRun(record.runId, state: "interrupted"); return }
                let message = ChatMessage(role: "assistant", content: reply.text)
                if !reply.images.isEmpty {
                    let assets = try reply.images.map { try imageLibrary.store($0.data, title: plan.action == .edit ? "修改后的图片" : "生成的图片", references: plan.references.map(\.id), reportedModel: $0.reportedModel, revisedPrompt: $0.revisedPrompt) }
                    try imageLibrary.bind(assets, to: message.id); imageRevision += 1
                }
                stage(record.runId, id: "reply:save", name: "保存回答", status: "running", output: "写入本机聊天记录")
                let original = chats[position]
                chats[position].messages.append(message)
                chats[position].updatedAt = timestamp()
                do { try save() } catch { chats[position] = original; throw error }
                stage(record.runId, id: "reply:save", name: "保存回答", status: "completed", output: "回答已保存到本机")
                updatePreferences { preferences in
                    if preferences.memoryUsage == nil { preferences.memoryUsage = [:] }
                    preferences.memoryUsage?[message.id] = recalled.facts.map { MobileMemoryUse(id: $0.id, text: $0.text) }
                    preferences.memorySemanticLastUsed = recalled.semantic
                    if preferences.messageAgents == nil { preferences.messageAgents = [:] }
                    preferences.messageAgents?[message.id] = ReplyPersona(selectedAgent)
                    if preferences.messageModels == nil { preferences.messageModels = [:] }
                    preferences.messageModels?[message.id] = [.init(requestedModel: record.requestedModel, reportedModel: executionRecords.first(where: { $0.runId == record.runId })?.returnedModel ?? "")]
                    if !reply.sources.isEmpty { if preferences.messageSources == nil { preferences.messageSources = [:] }; preferences.messageSources?[message.id] = reply.sources }
                    if reply.searched { if preferences.searchedMessages == nil { preferences.searchedMessages = [] }; preferences.searchedMessages?.insert(message.id) }
                }
                finishRun(record.runId, state: "completed", message: message, sources: reply.sources)
                LocalDeviceServices.shared.completed(text: reply.text, background: isBackground)
                completed = true
                replyBackground.finish(runID: record.runId, success: true)
            } catch is CancellationError { if expiredRunID != record.runId { finishRun(record.runId, state: "cancelled") } }
            catch let failure as URLError where failure.code == .cancelled { if expiredRunID != record.runId { finishRun(record.runId, state: "cancelled") } }
            catch { if expiredRunID != record.runId {
                stage(record.runId, id: "reply:failure", name: "请求失败", status: "failed", output: String(error.localizedDescription.prefix(1000)))
                finishRun(record.runId, state: "failed"); self.error = error.localizedDescription
            } }
        }
    }
    func importImage(_ data: Data, title: String = "参考图片") throws -> LocalImage {
        let image = try imageLibrary.store(data, title: title); imageRevision += 1; return image
    }
    func transformImage(_ image: LocalImage, operation: String) throws -> LocalImage {
        let result = try imageLibrary.transformed(image, operation: operation); imageRevision += 1; return result
    }
    func exportLocalArchive() throws -> Data {
        guard storageReady, executionReady, sendingID == nil, !syncing else { throw MeloError.message("请等待当前任务结束后再导出。") }
        let connections = try portableConnections()
        let workspace = try WorkspaceProjection.refreshed(preferences, chats: chats, records: executionRecords, connections: connections, device: syncDevice)
        let data = try JSONEncoder().encode(PortableArchive(snapshot: SyncSnapshot(chats: chats, tasks: taskCheckpoints, handoffs: taskHandoffs, workspace: workspace, deletedChats: deletedChats)))
        guard data.count <= 16 * 1024 * 1024 else { throw MeloError.message("资料超过 16 MB 导出上限。") }
        return data
    }
    func importLocalArchive(_ archive: PortableArchive) throws {
        guard storageReady, executionReady, sendingID == nil, !syncing else { throw MeloError.message("请等待当前任务结束后再导入。") }
        try archive.validate()
        let connections = try portableConnections(), remote = archive.snapshot
        let nextDeleted = try mergeDeletedChats(deletedChats, remote.deletedChats ?? [])
        let nextChats = try merge(chats,remote.chats, deletedChats: nextDeleted)
        var nextPreferences = preferences, nextRecords = executionRecords
        if let incoming = remote.workspace {
            let current = try WorkspaceProjection.refreshed(preferences, chats: chats, records: executionRecords, connections: connections, device: syncDevice)
            try WorkspaceProjection.apply(current.excluding(nextDeleted).merging(incoming.excluding(nextDeleted)),preferences:&nextPreferences,records:&nextRecords,connections:connections)
        }
        let nextTasks = try mergeTaskCheckpoints(taskCheckpoints,remote.tasks ?? []), nextHandoffs = try mergeHandoffs(taskHandoffs,remote.handoffs ?? [])
        nextPreferences.workspaceSync = nextPreferences.workspaceSync?.excluding(nextDeleted)
        nextRecords.removeAll { record in nextDeleted.contains { $0.id == record.chatId } }
        quarantineDeletedMemories(&nextPreferences, deleted: nextDeleted)
        try commitSync(SyncRecovery(snapshot:SyncSnapshot(chats:nextChats,tasks:nextTasks,handoffs:nextHandoffs,deletedChats:nextDeleted),preferences:nextPreferences,records:nextRecords))
        deletedChats = nextDeleted; chats = nextChats; preferences = nextPreferences; executionRecords = nextRecords; taskCheckpoints = nextTasks; taskHandoffs = nextHandoffs
    }
    func cancel() { sendTask?.cancel(); LocalDeviceServices.shared.stopSpeech() }
    func enteredBackground() {
        isBackground = true
        flushDrafts()
        saveExecutionRecords()
        replyBackground.enteredBackground()
    }
    func becameActive() { isBackground = false }
    func interruptionNotice(for chatID: String) -> String? {
        guard sendingID != chatID, chats.first(where: { $0.id == chatID })?.messages.last?.role == "user",
              scenes(for: chatID).last?.status == "interrupted" else { return nil }
        return "上次回复已中断，可能是后台任务结束或应用被关闭。提问已保存，点重新生成可再试。"
    }
    func requestHandoff(_ task: TaskCheckpoint) async {
        guard storageReady, task.canRequestHandoff,
              taskCheckpoints.contains(where: { $0 == task }) else { error = "任务状态已变化，请同步后再查看。"; return }
        guard !taskHandoffs.contains(where: { $0.taskId == task.id && $0.revision == task.revision }) else { await sync(); return }
        let device = UserDefaults.standard.string(forKey: "syncDeviceID") ?? UUID().uuidString
        UserDefaults.standard.set(device, forKey: "syncDeviceID")
        let request = TaskHandoff(taskId: task.id, fromDevice: device, revision: task.revision)
        taskHandoffs.append(request)
        do { try save(); await sync() } catch { taskHandoffs.removeAll { $0.id == request.id }; self.error = error.localizedDescription }
    }
    private func scheduleAutomaticSync() {
        automaticSyncPending = true
        guard !syncing, automaticSyncTask == nil else { return }
        automaticSyncTask = Task { [weak self] in
            guard let self else { return }
            self.automaticSyncPending = false
            await self.sync(reportErrors: false)
            self.automaticSyncTask = nil
            if self.automaticSyncPending { self.scheduleAutomaticSync() }
        }
    }
    func sync(reportErrors: Bool = true) async {
        guard !syncing, storageReady, executionReady else { return }
        let endpoint = UserDefaults.standard.string(forKey: "syncEndpoint") ?? ""
        guard !endpoint.isEmpty || syncLoader != nil else { syncStatus = "未配置云同步 · 记录保存在手机"; return }
        let token = Secrets.read("syncToken")
        guard token.count >= 32 || syncLoader != nil else { syncStatus = "请填写有效同步密钥"; return }
        syncing = true
        defer {
            syncing = false
            if automaticSyncPending && automaticSyncTask == nil { scheduleAutomaticSync() }
        }
        do {
            let connections = try portableConnections()
            let workspace = try WorkspaceProjection.refreshed(preferences, chats: chats, records: executionRecords, connections: connections, device: syncDevice)
            guard updatePreferences({ $0.workspaceSync = workspace }) else { return }
            let sentDeletions = deletedChats
            let payload = try JSONEncoder().encode(SyncSnapshot(chats: chats, tasks: taskCheckpoints, handoffs: taskHandoffs, workspace: workspace, deletedChats: sentDeletions))
            guard payload.count <= 8 * 1024 * 1024 else { throw MeloError.message("聊天记录超过当前同步容量。") }
            let data: Data
            if let syncLoader { data = try await syncLoader(payload) }
            else { data = try await Network.post(try Network.endpoint(endpoint), token: token, body: payload) }
            let remote = try JSONDecoder().decode(SyncSnapshot.self, from: data).validated()
            guard remote.version == 1 else { throw MeloError.message("同步服务版本不匹配。") }
            try requireDeletionAcknowledgement(sentDeletions, remote.deletedChats)
            let nextDeleted = try mergeDeletedChats(deletedChats, remote.deletedChats ?? [])
            let oldHandoffs = taskHandoffs
            let nextChats = try merge(chats, remote.chats, deletedChats: nextDeleted)
            let nextTasks = try mergeTaskCheckpoints(taskCheckpoints, remote.tasks ?? [])
            let nextHandoffs = try mergeHandoffs(taskHandoffs, remote.handoffs ?? [])
            var nextPreferences = preferences, nextRecords = executionRecords
            if let remoteWorkspace = remote.workspace {
                // Include edits made while the HTTP request was in flight.
                let current = try WorkspaceProjection.refreshed(preferences, chats: chats, records: executionRecords, connections: connections, device: syncDevice)
                let merged = try current.excluding(nextDeleted).merging(remoteWorkspace.excluding(nextDeleted))
                try WorkspaceProjection.apply(merged, preferences: &nextPreferences, records: &nextRecords, connections: connections)
            }
            nextPreferences.workspaceSync = nextPreferences.workspaceSync?.excluding(nextDeleted)
            nextRecords.removeAll { record in nextDeleted.contains { $0.id == record.chatId } }
            quarantineDeletedMemories(&nextPreferences, deleted: nextDeleted)
            let recovery = SyncRecovery(snapshot: SyncSnapshot(chats: nextChats, tasks: nextTasks, handoffs: nextHandoffs, deletedChats: nextDeleted), preferences: nextPreferences, records: nextRecords)
            try commitSync(recovery)
            deletedChats = nextDeleted; chats = nextChats; taskCheckpoints = nextTasks; taskHandoffs = nextHandoffs; preferences = nextPreferences; executionRecords = nextRecords
            // A local request is only delivered after the sync service echoes
            // the identical request. This is not confirmation of desktop execution.
            let confirmed = Set((remote.handoffs ?? []).filter { oldHandoffs.contains($0) }.map(\.id))
            if !confirmed.isEmpty { updatePreferences { $0.taskHandoffReceipts = ($0.taskHandoffReceipts ?? []).union(confirmed) } }
            migrateLegacyReferences()
            let conflicts = preferences.workspaceSync?.conflicts.count ?? 0
            syncStatus = remote.workspace == nil ? "正文已同步 · 服务尚未支持角色、项目和来源同步，请更新同步服务" : conflicts > 0 ? "有 \(conflicts) 项同步冲突 · 所有版本均已保留，请处理" : "对话、角色、项目、资料与来源已同步 · \(Date().formatted(date: .omitted, time: .shortened))"
        } catch { syncStatus = "同步未完成 · " + error.localizedDescription; if reportErrors { self.error = error.localizedDescription } }
    }
    private var syncDevice: String {
        if let saved = UserDefaults.standard.string(forKey: "syncDeviceID") { return saved }
        let id = UUID().uuidString; UserDefaults.standard.set(id, forKey: "syncDeviceID"); return id
    }
    private func portableConnections() throws -> [PortableConnection] {
        try LLMConnection.saved().map { .init(id:$0.id,name:$0.name,baseURL:$0.baseURL,apiProtocol:$0.apiProtocol) }
    }
    func resolveSyncConflict(_ key: String, choice: Int) {
        guard storageReady, executionReady, !syncing else { return }
        do {
            var next = preferences, records = executionRecords, workspace = preferences.workspaceSync ?? .init()
            try workspace.resolve(key:key,choice:choice,device:syncDevice)
            try WorkspaceProjection.apply(workspace,preferences:&next,records:&records,connections:portableConnections())
            try commitSync(.init(snapshot:SyncSnapshot(chats:chats,tasks:taskCheckpoints,handoffs:taskHandoffs,deletedChats:deletedChats),preferences:next,records:records))
            preferences=next; executionRecords=records
            syncStatus="冲突选择已保存 · 下次同步会发送所选版本"
        } catch { self.error=error.localizedDescription }
    }
    private func quarantineDeletedMemories(_ p: inout MobilePreferences, deleted: [DeletedChat]) {
        let ids = Set(deleted.map(\.id))
        for index in p.memoryFacts?.indices ?? 0..<0 where ids.contains(p.memoryFacts![index].chatId) {
            if p.memoryFacts![index].status == "active" { p.memoryFacts?[index].status = "unconfirmed" }
        }
    }
    private struct SyncRecovery: Codable { var snapshot: SyncSnapshot; var preferences: MobilePreferences; var records: [ExecutionRecord]; var removedMessageIDs: Set<String>?; var protectedImageIDs: Set<String>? }
    private func commitSync(_ value: SyncRecovery) throws {
        var recovery = value
        let deleted = Set((value.snapshot.deletedChats ?? []).map(\.id))
        recovery.removedMessageIDs = Set(chats.filter { deleted.contains($0.id) }.flatMap(\.messages).map(\.id))
        recovery.protectedImageIDs = Set(composerDrafts.filter { !deleted.contains($0.key) }.values.flatMap { $0.imagePlan.references.map(\.id) })
        recovery.records.removeAll { deleted.contains($0.chatId) }
        try BackgroundReplyStorage.write(JSONEncoder().encode(recovery),to:syncRecoveryFile)
        do { try writeSyncRecovery(recovery) }
        catch { storageReady=false; throw MeloError.message("同步保存未完成，恢复记录已保留。请重新打开 Melo 完成恢复，避免覆盖数据。") }
    }
    private func writeSyncRecovery(_ recovery: SyncRecovery) throws {
        _ = try recovery.preferences.workspaceSync?.validated()
        try BackgroundReplyStorage.write(JSONEncoder().encode(recovery.snapshot),to:file)
        try BackgroundReplyStorage.write(JSONEncoder().encode(recovery.preferences),to:preferencesFile)
        try BackgroundReplyStorage.write(JSONEncoder().encode(recovery.records),to:sceneFile)
        try imageLibrary.removeMessages(recovery.removedMessageIDs ?? [], protecting: recovery.protectedImageIDs ?? [])
        try FileManager.default.removeItem(at:syncRecoveryFile)
    }
}

#if DEBUG
extension ChatStore {
    func verifySearch() async {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/search-verification.json")
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var result: [String: Any] = ["completed": false, "startedAt": ISO8601DateFormatter().string(from: Date())]
        if let data = try? JSONSerialization.data(withJSONObject: result) { try? data.write(to: url, options: .atomic) }
        do {
            let reply = try await account.reply(messages: [ChatMessage(role: "user", content: "请实际联网搜索悉尼明天的天气，说明具体日期和气温，并附来源。")], model: UserDefaults.standard.string(forKey: "chatgptModel") ?? "", instructions: "")
            result = ["completed": true, "searched": reply.searched, "sourceCount": reply.sources.count, "hasText": !reply.text.isEmpty, "testReply": reply.text]
        } catch { result["error"] = error.localizedDescription }

        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: result) { try? data.write(to: url, options: .atomic) }
    }
}
#endif
