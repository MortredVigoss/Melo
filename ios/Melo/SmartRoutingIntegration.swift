import Foundation

extension ChatStore {
    @MainActor func smartRoutingHost(choice: ConversationModel?, agent: AgentProfile, messages: [ChatMessage], history: [ChatMessage], instructions: String, images: [ImageInput], phoneTools: DeviceToolContext?, chatID: String, runID: String, allowWeb: Bool, allowImages: Bool, onObservation: @escaping @MainActor (ExecutionObservation) -> Void, onSelection: @escaping @MainActor (String) -> Void) throws -> PhoneRoutingHost? {
        let policy = PhoneRoutingPolicy.read()
        let mode = choice?.mode ?? (choice == nil ? policy.defaultMode : "fixed")
        guard mode == "smart", agent.model?.isEmpty != false else { return nil }
        var connections = try LLMConnection.saved()
        let defaults = UserDefaults.standard
        let defaultIsCodex = (defaults.string(forKey: "modelAuthMode") ?? "chatgpt") == "chatgpt"
        let defaultEndpoint = defaults.string(forKey: "modelEndpoint") ?? ""
        let legacy = LLMConnection(id: "", name: "当前连接", baseURL: defaultEndpoint, model: defaults.string(forKey: "modelName") ?? "", key: Secrets.read("modelKey"), apiProtocol: defaults.string(forKey: "modelProtocol") ?? "chat-completions")
        if !connections.contains(where: { WorkspaceProjection.base($0.baseURL) == WorkspaceProjection.base(defaultEndpoint) }), !defaultIsCodex { connections.append(legacy) }
        let selected = choice.flatMap { LLMConnection.resolve($0, in: connections) }
        let currentID = choice?.connectionID == "chatgpt" || (choice == nil && defaultIsCodex) ? "chatgpt" : selected?.id ?? connections.first(where: { WorkspaceProjection.base($0.baseURL) == WorkspaceProjection.base(defaultEndpoint) })?.id ?? ""
        let defaultModel = currentID == "chatgpt" ? choice?.model ?? defaults.string(forKey: "chatgptModel") ?? "" : choice?.model ?? connections.first(where: { $0.id == currentID })?.model ?? ""
        var candidates = connections.flatMap { c in Array(Set((c.models ?? []) + [c.model])).filter { !$0.isEmpty }.map { PhoneRoutingCandidate(connectionId: c.id, model: $0, name: c.name, capabilities: ["tools":true].merging(c.capabilities(for: $0)) { _, declared in declared }, contextWindow: c.contextWindows?[$0] ?? 0, available: !c.key.isEmpty) } }
        if account.signedIn { candidates += Array(Set(account.models.map(\.slug) + [defaults.string(forKey: "chatgptModel") ?? ""])).filter { !$0.isEmpty }.map { model in PhoneRoutingCandidate(connectionId: "chatgpt", model: model, name: "Codex", capabilities: account.models.first(where: { $0.slug == model })?.input_modalities.map { ["tools":true,"vision":$0.contains("image")] } ?? ["tools":true]) } }
        let session = try PhoneRoutingSession(policy: policy, mode: mode, connectionId: currentID, defaultModel: defaultModel, candidates: candidates,
                                             text: history.last(where: { $0.role == "user" })?.content ?? "", history: history.map { ["role": $0.role, "content": $0.content] }, attachments: images.map { _ in ["kind": "image"] })
        let capturedConnections = connections
        let account = self.account
        let accountIdentity = account.routingIdentity
        let tools = phoneTools?.toolSet.loopTools
        let scope = ChatGPTRequest.cacheKey(chatID: chatID, agentID: agent.id)
        return PhoneRoutingHost(session: session, messages: Array(history.filter { $0.role == "user" }.suffix(4)), identity: accountIdentity + capturedConnections.map { $0.id + $0.baseURL + $0.key }.joined(separator: "|") + chatID) { id, model in
            try Task.checkCancellation()
            onSelection(model)
            let prefix = "routing:" + UUID().uuidString + ":"
            let observe: @MainActor (ExecutionObservation) -> Void = { value in
                var value = value
                value.pipeline = value.pipeline.map { row in var row = row; row.id = prefix + row.id; return row }
                onObservation(value)
            }
            if id == "chatgpt" {
                guard account.routingIdentity == accountIdentity else { throw CancellationError() }
                let transport = try await account.routingTransport(messages: messages, requestHistory: history, model: model, instructions: instructions, imageInputs: images, tools: tools, allowWebSearch: allowWeb, allowImageTool: allowImages && session.decision["tier"] as? String == "strong", cacheKey: scope, onObservation: observe)
                transport.routingContextLimit = PhoneContextBudget().input
                return transport
            }
            guard let connection = capturedConnections.first(where: { $0.id == id }) else { throw MeloError.message("所选智能模型的连接已不可用。") }
            let capacity = PhoneContextBudget(capacity: connection.contextWindows?[model])
            let transport = try PhoneContextBudget.$current.withValue(capacity) { try Network.routingTransport(messages: messages, endpoint: connection.endpoint(), model: model, token: connection.key, instructions: instructions, apiProtocol: connection.apiProtocol, imageInputs: images, modelCapabilities: connection.capabilities(for: model), tools: tools, onObservation: observe) }
            transport.routingContextLimit = capacity.input
            return transport
        }
    }
}
