import Foundation

struct ExecutionStage: Codable, Equatable, Identifiable {
    var id: String
    var module = "create"
    var channel: String?
    var name: String
    var status: String
    var input = ""
    var output = ""
    var model: String?
    var returnedModel: String?
    var startedAt: String?
    var finishedAt: String?
    // Local API receipt; omitted from the frozen v1 sync projection.
    var api: [String: SyncValue]?
}

struct ExecutionOperation: Codable, Equatable, Identifiable {
    var id: String
    var module = "search"
    var name = "native_web_search"
    var status = "queued"
    var provider = "ChatGPT"
    var input = ""
    var output = ""
    var query = ""
    var resultSummary = ""
}
struct ExecutionSource: Codable, Equatable, Identifiable {
    var id: String
    var url: String
    var title: String
    var titleProvided = false
    var order: Int
    var rank: Int
    var reading = "unknown"
    var appeared = false
    var accessed = false
    var opened = false
    var cited = false
    var citationUrl: String?
    var citationLabel: String?
    var providers = ["ChatGPT"]
    var queries: [String] = []

    static func merge(_ incoming: ExecutionSource, into sources: inout [ExecutionSource]) {
        guard let identity = WebSource.identity(incoming.url) else { return }
        guard let index = sources.firstIndex(where: { WebSource.identity($0.url) == identity }) else { sources.append(incoming); return }
        // Keep the first node ID and all recorded evidence across legacy duplicates.
        if incoming.titleProvided { sources[index].title = incoming.title; sources[index].titleProvided = true }
        sources[index].rank = min(sources[index].rank, incoming.rank)
        sources[index].appeared = sources[index].appeared || incoming.appeared
        sources[index].opened = sources[index].opened || incoming.opened
        sources[index].accessed = sources[index].accessed || incoming.accessed
        sources[index].cited = sources[index].cited || incoming.cited
        let weight = ["unknown": 0, "snippet": 1, "partial": 2, "range-unknown": 2, "extracted": 3]
        if weight[incoming.reading, default: -1] > weight[sources[index].reading, default: 0] { sources[index].reading = incoming.reading }
        if let url = incoming.citationUrl, WebSource.identity(url) == identity { sources[index].citationUrl = url }
        if let label = incoming.citationLabel { sources[index].citationLabel = label }
        for value in incoming.providers where !sources[index].providers.contains(value) { sources[index].providers.append(value) }
        for value in incoming.queries where !sources[index].queries.contains(value) { sources[index].queries.append(value) }
    }
}
struct ExecutionObservation: Equatable {
    var revision = 0
    var operations: [ExecutionOperation] = []
    var sources: [ExecutionSource] = []
    var returnedModel: String?
    var pipeline: [ExecutionStage] = []
    private var summaryParts: [String: [Int: String]] = [:]
    private var summarySequences: [String: Int] = [:]
    private var requestStarted: TimeInterval
    init(requestStarted: TimeInterval = ProcessInfo.processInfo.systemUptime) { self.requestStarted = requestStarted }
    mutating func apiReceipt(_ response: [String: Any], transport: String, finishReason: String? = nil) {
        guard let index = pipeline.firstIndex(where: { $0.id == "model:response" }) else { return }
        var api = pipeline[index].api ?? [:]
        func identifier(_ value: Any?) -> SyncValue? {
            guard let value = value as? String, value.range(of: #"^[A-Za-z0-9._:/-]{1,200}$"#, options: .regularExpression) != nil else { return nil }
            return .string(value)
        }
        func count(_ value: Any?) -> Double? {
            guard let n = value as? NSNumber, String(cString: n.objCType) != "c" else { return nil }
            let value = n.doubleValue
            return value.isFinite && value >= 0 && value <= 9007199254740991 && value.rounded() == value ? value : nil
        }
        for (key, value) in [("responseId", response["id"]), ("reportedModel", response["model"]), ("responseStatus", response["status"]), ("transport", transport as Any?), ("finishReason", finishReason as Any?)] {
            if let value = identifier(value) { api[key] = value }
        }
        let elapsed = max(0, ((ProcessInfo.processInfo.systemUptime - requestStarted) * 1000).rounded())
        api["durationMs"] = .number(elapsed)
        if api["firstEventMs"] == nil { api["firstEventMs"] = .number(elapsed) }
        if let raw = response["usage"] as? [String: Any] {
            let inputDetails = (raw["input_tokens_details"] ?? raw["prompt_tokens_details"]) as? [String: Any] ?? [:]
            let outputDetails = (raw["output_tokens_details"] ?? raw["completion_tokens_details"]) as? [String: Any] ?? [:]
            var values: [String: Any?] = ["input":raw["input_tokens"] ?? raw["prompt_tokens"], "output":raw["output_tokens"] ?? raw["completion_tokens"], "total":raw["total_tokens"], "cached":inputDetails["cached_tokens"] ?? raw["cache_read_input_tokens"], "cacheWrite":inputDetails["cache_write_tokens"] ?? raw["cache_creation_input_tokens"], "reasoning":outputDetails["reasoning_tokens"]]
            if transport == "anthropic", raw["cache_read_input_tokens"] != nil || raw["cache_creation_input_tokens"] != nil {
                if let input = count(raw["input_tokens"]), let read = count(raw["cache_read_input_tokens"] ?? 0), let write = count(raw["cache_creation_input_tokens"] ?? 0) { values["input"] = input + read + write }
                else { values.removeValue(forKey: "input") }
            }
            let usage = values.compactMapValues { count($0).map(SyncValue.number) }
            if !usage.isEmpty { api["usage"] = .object(usage) }
        }
        if api != pipeline[index].api { pipeline[index].api = api; revision += 1 }
    }
    mutating func stage(_ id: String, name: String, status: String, output: String = "", model: String? = nil) {
        if let index = pipeline.firstIndex(where: { $0.id == id }) {
            guard !["completed", "failed", "cancelled", "interrupted"].contains(pipeline[index].status) else { return }
            guard pipeline[index].status != status || pipeline[index].output != output else { return }
            pipeline[index].status = status; pipeline[index].output = output
            if let model { pipeline[index].model = model }
            if status != "running" { pipeline[index].finishedAt = timestamp() }
            pipeline[index].returnedModel = returnedModel
        } else {
            pipeline.append(ExecutionStage(id: id, name: name, status: status, output: output, model: model, returnedModel: returnedModel,
                startedAt: status == "running" ? timestamp() : nil, finishedAt: status == "running" ? nil : timestamp()))
        }
        revision += 1
    }
    mutating func source(url: String, title: String = "", appeared: Bool = false, opened: Bool = false, cited: Bool = false, provider: String? = "ChatGPT") {
        guard let safe = WebSource.validated(title: title, url: url) else { return }
        var next = sources.count
        while sources.contains(where: { $0.id == "source-\(next)" }) { next += 1 }
        let existing = sources.first { WebSource.identity($0.url) == WebSource.identity(safe.url) }
        var incoming = ExecutionSource(id: "source-\(next)", url: safe.url, title: safe.title, order: sources.count, rank: existing?.rank ?? sources.count)
        incoming.titleProvided = !title.isEmpty
        incoming.providers = provider.map { [$0] } ?? []
        incoming.appeared = appeared; incoming.opened = opened; incoming.cited = cited
        if cited { incoming.citationUrl = safe.url; incoming.citationLabel = safe.title }
        ExecutionSource.merge(incoming, into: &sources)
        revision += 1
    }
    mutating func tool(_ item: [String: Any], fallbackID: String = "search") {
        guard item["type"] as? String == "web_search_call" else { return }
        let id = item["id"] as? String ?? fallbackID
        let index = operation(id)
        let status = item["status"] as? String ?? "in_progress"
        setStatus(status == "in_progress" || status == "searching" ? "running" : status, at: index)
        let action = item["action"] as? [String: Any] ?? [:]
        let queries = action["queries"] as? [String] ?? (action["query"] as? String).map { [$0] } ?? []
        if !queries.isEmpty {
            operations[index].query = queries.joined(separator: " · ")
            operations[index].input = String(queries.joined(separator: "\n").prefix(1000))
        }
        // Some completion summaries omit action; keep the earlier tool evidence.
        guard !action.isEmpty else { revision += 1; return }
        let kind = action["type"] as? String ?? "search"
        if let url = action["url"] as? String, kind == "open_page" || kind == "find_in_page" {
            source(url: url, opened: status == "completed")
            operations[index].input = url
            operations[index].resultSummary = kind == "open_page" ? "页面打开事件 · 正文范围未提供" : "页内查找事件 · 正文范围未提供"
        } else {
            let entries = action["sources"] as? [[String: Any]] ?? []
            for entry in entries { if let url = entry["url"] as? String { source(url: url, title: entry["title"] as? String ?? "", appeared: true) } }
            operations[index].resultSummary = entries.isEmpty ? (status == "completed" ? "搜索已返回 · 未提供候选列表" : "搜索执行中") : "服务返回 \(entries.count) 条候选"
        }
        operations[index].output = operations[index].resultSummary
        revision += 1
    }
    private mutating func operation(_ id: String) -> Int {
        if let index = operations.firstIndex(where: { $0.id == id }) { return index }
        operations.append(ExecutionOperation(id: id)); return operations.count - 1
    }
    private mutating func setStatus(_ status: String, at index: Int) {
        let terminal = ["completed", "failed", "cancelled", "interrupted"]
        if terminal.contains(operations[index].status) && !terminal.contains(status) { return }
        operations[index].status = status
    }
    private mutating func publishSummary(_ itemID: String, status: String = "running") {
        let id = "model:summary:" + itemID
        let parts = summaryParts[itemID] ?? [:]
        let text = String(parts.keys.sorted().compactMap { parts[$0] }.joined(separator: "\n\n").prefix(12000))
        guard !text.isEmpty else { return }
        stage(id, name: "模型公开推理摘要", status: status, output: text)
        if let index = pipeline.firstIndex(where: { $0.id == id }) {
            pipeline[index].module = "compute"; pipeline[index].channel = "reasoning-summary"
        }
    }
    private mutating func summary(_ event: [String: Any]) {
        let type = event["type"] as? String ?? ""
        // Only the documented public summary channel; never reasoning_text or encrypted content.
        guard ["response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done"].contains(type),
              let id = event["item_id"] as? String, !id.isEmpty,
              let index = event["summary_index"] as? Int, (0..<64).contains(index),
              summaryParts[id] != nil || summaryParts.count < 32,
              !pipeline.contains(where: { $0.id == "model:summary:" + id && $0.status != "running" }) else { return }
        let key = "\(id):\(index)"
        if let sequence = event["sequence_number"] as? Int {
            guard sequence > summarySequences[key, default: -1] else { return }
            summarySequences[key] = sequence
        }
        let part = event["part"] as? [String: Any]
        if type.hasSuffix(".delta"), let delta = event["delta"] as? String {
            summaryParts[id, default: [:]][index] = String((summaryParts[id]?[index] ?? "").appending(delta).prefix(12000))
        } else if let text = event["text"] as? String ?? (part?["type"] as? String == "summary_text" ? part?["text"] as? String : nil) {
            summaryParts[id, default: [:]][index] = String(text.prefix(12000))
        }
        publishSummary(id, status: event["status"] as? String == "incomplete" ? "interrupted" : "running")
    }
    private mutating func summaryItem(_ item: [String: Any], done: Bool) {
        guard item["type"] as? String == "reasoning", let id = item["id"] as? String,
              summaryParts[id] != nil || summaryParts.count < 32,
              !pipeline.contains(where: { $0.id == "model:summary:" + id && $0.status != "running" }) else { return }
        if let parts = item["summary"] as? [[String: Any]], !parts.isEmpty {
            var values: [Int: String] = [:]
            for (index, part) in parts.prefix(64).enumerated() where part["type"] as? String == "summary_text" {
                if let text = part["text"] as? String { values[index] = String(text.prefix(12000)) }
            }
            if !values.isEmpty { summaryParts[id] = values }
        }
        publishSummary(id, status: item["status"] as? String == "incomplete" ? "interrupted" : done ? "completed" : "running")
    }
    mutating func accept(_ event: [String: Any]) {
        let type = event["type"] as? String ?? ""
        summary(event)
        if let response = event["response"] as? [String: Any] {
            if let model = response["model"] as? String, model != returnedModel { returnedModel = model; revision += 1 }
            for item in response["output"] as? [[String: Any]] ?? [] { tool(item); summaryItem(item, done: type == "response.completed" && response["status"] as? String == "completed") }
        }
        if type == "response.created" { stage("model:response", name: "模型请求", status: "running", output: "服务已接收请求，等待输出") }
        if type == "response.output_text.delta" { stage("model:response", name: "模型请求", status: "running", output: "正在接收模型输出") }
        if type == "response.completed", let response = event["response"] as? [String: Any], response["status"] as? String == "completed" {
            stage("model:response", name: "模型请求", status: "completed", output: "模型返回完成" + (returnedModel.map { " · 服务返回模型：\($0)" } ?? " · 服务未报告模型标识"))
            for id in Array(summaryParts.keys) { publishSummary(id, status: "completed") }
        }
        if ["response.failed", "response.incomplete", "error"].contains(type) {
            stage("model:response", name: "模型请求", status: "failed", output: "未取得完整响应")
            for id in Array(summaryParts.keys) { publishSummary(id, status: type == "response.incomplete" ? "interrupted" : "failed") }
        }
        if let item = event["item"] as? [String: Any] { tool(item); summaryItem(item, done: type == "response.output_item.done") }
        if type.hasPrefix("response.web_search_call."), let id = event["item_id"] as? String {
            let index = operation(id)
            let status = type.hasSuffix("completed") ? "completed" : type.hasSuffix("failed") ? "failed" : "running"
            setStatus(status, at: index); revision += 1
        }
        if let response = event["response"] as? [String: Any] { apiReceipt(response, transport: "responses") }
    }
}
struct ExecutionRecord: Codable, Identifiable, Equatable {
    var id: String { runId }
    var version = 1
    var runId = UUID().uuidString
    var requestId = UUID().uuidString
    var chatId: String
    var query: String
    var startedAt = timestamp()
    var finishedAt: String?
    var status = "running"
    var sequence = 0
    var operations: [ExecutionOperation] = []
    var pipeline: [ExecutionStage]?
    var sources: [ExecutionSource] = []
    var artifacts: [String] = []
    var selectedImageIds: [String] = []
    var requestedImages = 1
    var lastModule: String?
    var events: [String] = []
    var restSeed = "0"
    var messageId: String?
    var requestedModel: String
    var returnedModel: String?
    var observationNote = "手机直连 · 真实工具与交付记录，非模型内部思维"
    var sourceDevice: String?
    var terminal: Bool { ["completed", "failed", "cancelled", "interrupted"].contains(status) }
    mutating func reconcileReferences(message: ChatMessage, annotations: [WebSource] = []) {
        guard message.role == "assistant", messageId == message.id else { return }
        let references = WebReplyFormatter.references(in: message.content, annotations: annotations)
        let cited = Set(references.compactMap { WebSource.identity($0.url) })
        var reconciled: [ExecutionSource] = []
        for var source in sources {
            source.cited = WebSource.identity(source.url).map { cited.contains($0) } ?? false
            if !source.cited { source.citationUrl = nil; source.citationLabel = nil }
            ExecutionSource.merge(source, into: &reconciled)
        }
        var observation = ExecutionObservation(); observation.sources = reconciled
        for source in references { observation.source(url: source.url, title: source.title, cited: true, provider: nil) }
        guard observation.sources != sources else { return }
        sources = observation.sources; sequence += 1
        // Reconciliation never creates tool calls or changes their completion state.
    }
    static func reconcilingHistory(_ records: [ExecutionRecord], chats: [Conversation], messageSources: [String: [WebSource]]) -> [ExecutionRecord] {
        var result = records
        for chat in chats {
            var query = chat.title
            for message in chat.messages {
                if message.role == "user" { query = message.content }
                guard message.role == "assistant" else { continue }
                let annotations = messageSources[message.id] ?? []
                if let index = result.firstIndex(where: { $0.chatId == chat.id && $0.messageId == message.id }) {
                    result[index].reconcileReferences(message: message, annotations: annotations)
                } else {
                    let references = WebReplyFormatter.references(in: message.content, annotations: annotations)
                    if !references.isEmpty { result.append(.legacy(chatID: chat.id, message: message, query: query, sources: references)) }
                }
            }
        }
        return result.sorted { ($0.startedAt, $0.runId) < ($1.startedAt, $1.runId) }
    }
    static func legacy(chatID: String, message: ChatMessage, query: String, sources: [WebSource]) -> ExecutionRecord {
        var record = ExecutionRecord(chatId: chatID, query: query, requestedModel: "")
        record.runId = "legacy-" + message.id; record.requestId = record.runId
        record.startedAt = message.createdAt; record.finishedAt = message.createdAt
        var observed = ExecutionObservation()
        for source in sources { observed.source(url: source.url, title: source.title, cited: true, provider: nil) }
        record.sources = observed.sources; record.messageId = message.id; record.status = "completed"
        record.lastModule = record.sources.isEmpty ? nil : "search"
        record.observationNote = "历史引用 · 当时未保存工具调用，不补造执行记录"
        return record
    }
    mutating func observe(_ observation: ExecutionObservation) {
        guard !terminal else { return }
        operations = observation.operations; sources = observation.sources; returnedModel = observation.returnedModel
        for stage in observation.pipeline { mergeStage(stage) }
        lastModule = pipeline?.last(where: { $0.status == "running" })?.module ?? operations.last?.module
        sequence += 1
    }
    private mutating func mergeStage(_ stage: ExecutionStage) {
        if pipeline == nil { pipeline = [] }
        if let index = pipeline?.firstIndex(where: { $0.id == stage.id }) {
            guard !["completed", "failed", "cancelled", "interrupted"].contains(pipeline![index].status) else { return }
            let start = pipeline![index].startedAt
            let requested = pipeline![index].model
            pipeline![index] = stage
            pipeline![index].startedAt = start ?? stage.startedAt
            pipeline![index].model = requested ?? stage.model
        } else { pipeline?.append(stage) }
    }
    mutating func recordStage(_ id: String, name: String, status: String, output: String = "", model: String? = nil) {
        guard !terminal else { return }
        mergeStage(ExecutionStage(id: id, name: name, status: status, output: output, model: model,
            startedAt: status == "running" ? timestamp() : nil, finishedAt: status == "running" ? nil : timestamp()))
        lastModule = "create"; sequence += 1
    }
    mutating func markRendered(messageID: String) {
        guard terminal, messageId == messageID, pipeline?.contains(where: { $0.id == "reply:render" }) != true else { return }
        mergeStage(ExecutionStage(id: "reply:render", name: "本机聊天渲染", status: "completed", output: "回答已呈现到本机聊天界面；不代表用户已阅读", finishedAt: timestamp()))
        sequence += 1
    }
    mutating func finish(_ state: String, messageID: String? = nil) {
        guard !terminal else { return }
        status = state; finishedAt = timestamp(); messageId = messageID; sequence += 1
        for index in operations.indices where ["running", "queued", "in_progress"].contains(operations[index].status) { operations[index].status = state == "cancelled" ? "cancelled" : "interrupted" }
        for index in (pipeline ?? []).indices where ["running", "queued"].contains(pipeline![index].status) {
            pipeline![index].status = state == "cancelled" ? "cancelled" : state == "failed" ? "failed" : "interrupted"
            pipeline![index].finishedAt = finishedAt
        }
        restSeed = String(sequence * 37, radix: 36)
    }
}

struct ExecutionViewPreference: Codable {
    var focus: String?
    var more: Bool
    var slot: Int
    var zoom: Double
}
