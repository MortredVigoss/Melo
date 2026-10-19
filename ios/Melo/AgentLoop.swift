import Foundation

// The phone agent loop (2026-10-19 手机 agent loop 对齐桌面): the same three
// stages as src/services/chat/chatExecutionRunner.js —
//   prepare      tool set + contract note, intent and uncertainty rules, budget
//   invoke-model ≤10 model calls, ≤32 calls per response, supplements between
//                calls, run budget before every model and tool call, repeat
//                guard, envelopes, per-call records, condensation on overflow
//   finalize     uncertainty marker + verification for verification intents
// Model protocols are single-round adapters behind AgentModelTransport
// (Codex Responses in ChatGPTAccount.swift, chat-completions and Anthropic in
// Network.swift). Limits and texts come from the shared contract.

/// Provider items a transport needs to replay a tool round.
enum AgentEcho: @unchecked Sendable {
    case none
    case responses([[String: Any]])
    case chat([String: Any])
    case anthropic([[String: Any]])
}

/// One model response, protocol-neutral.
struct AgentRound: @unchecked Sendable {
    var text = ""
    var calls: [ResponsesFunctionCall] = []
    var echo: AgentEcho = .none
    var sources: [WebSource] = []
    var searched = false
    var images: [ImagePayload] = []
    /// Provider-reported input tokens; nil when the response had no usage.
    var inputTokens: Int? = nil
    /// Request size estimate (body bytes without base64 images / 4) for the budget when usage is missing.
    var estimatedInputTokens = 0
    var outputTokens: Int? = nil
}

/// One executed (or refused) tool call as it goes back to the model.
struct AgentToolResult: @unchecked Sendable {
    let call: ResponsesFunctionCall
    var modelOutput: String
    var imageJPEG: Data? = nil
    var imageURL = ""
    var phoneResult: PhoneToolResult { PhoneToolResult(output: modelOutput, imageJPEG: imageJPEG, imageURL: imageURL) }
}

/// The turn so far, rendered by each transport into its own wire format.
enum AgentTranscriptItem: @unchecked Sendable {
    case toolRound(AgentRound, [AgentToolResult])
    case userText(String)
}

struct AgentLoopRequest: @unchecked Sendable {
    let iteration: Int
    let transcript: [AgentTranscriptItem]
    /// Seconds left for this request: min(transport cap, run budget remaining).
    let timeout: TimeInterval
    var remainingTokens: Int? = nil
}

/// A provider rejected the request as too large (HTTP 413 or a context-length
/// error). The message is the user-facing text the transport used before.
struct RequestTooLarge: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

protocol AgentModelTransport: AnyObject {
    /// Whether phone function tools are offered (calls are ignored otherwise).
    var offersTools: Bool { get }
    /// Per-request timeout cap in seconds.
    var timeoutCap: TimeInterval { get }
    func round(_ input: AgentLoopRequest) async throws -> AgentRound
    /// One tool-free request (verification, intent classification) on the same connection.
    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String
}

/// Phone tools for one turn: definitions plus the dispatcher.
struct AgentLoopTools {
    var definitions: [PhoneToolDefinition]
    var instructions: String
    var perform: @MainActor (ResponsesFunctionCall) async -> PhoneToolResult
    var statusText: (ResponsesFunctionCall) -> String = { WebPageToolSpec.named($0.name).map(\.statusText) ?? "正在读取手机数据…" }
    /// Tool instructions with the shared envelope note, as offered to the model.
    var instructionsWithContract: String { [instructions, AgentLoopContract.shared.contractNote].filter { !$0.isEmpty }.joined(separator: "\n") }
}

/// Finalize inputs: the classification made in prepare and the evidence context.
struct AgentVerification {
    var question: String
    var classification: PhoneIntent.Classification
    var contextBlocks: [String] = []
}

enum AgentStopReason: Equatable { case answered, toolLimit, budget }

struct AgentLoopOutcome {
    var text: String
    var stop: AgentStopReason
    var finalRound: AgentRound?
    var sources: [WebSource]
    var searched: Bool
    var calls: [ExecutionToolCall]
    var iterations: Int
    var unusedSupplements: [String] = []
    var verification: PhoneUncertainty.Verification?
}

/// Observers; all run on the main actor.
struct AgentLoopHooks {
    var onStatus: (@MainActor (String) -> Void)? = nil
    var onStage: (@MainActor (_ id: String, _ name: String, _ status: String, _ output: String) -> Void)? = nil
    var onToolCall: (@MainActor (ExecutionToolCall) -> Void)? = nil
    /// Supplements typed while the turn runs; taken before every model call from the second on.
    var takeSupplements: (@MainActor () -> [String])? = nil
    var onSupplementsJoined: (@MainActor ([String]) -> Void)? = nil
}

final class AgentLoop: @unchecked Sendable {
    let transport: AgentModelTransport
    let tools: AgentLoopTools?
    let budget: PhoneRunBudget
    let hooks: AgentLoopHooks
    let latestUserMessage: String
    let verification: AgentVerification?
    /// Protocol-specific checks on the answer before finalize (e.g. a required web search).
    var validate: ((AgentLoopOutcome) throws -> Void)? = nil
    var maxIterations = AgentLoopContract.shared.maxIterations
    var maxCallsPerResponse = AgentLoopContract.shared.maxCallsPerResponse
    private var contract: AgentLoopContract { .shared }

    init(transport: AgentModelTransport, tools: AgentLoopTools?, budget: PhoneRunBudget, latestUserMessage: String, verification: AgentVerification? = nil, hooks: AgentLoopHooks = AgentLoopHooks()) {
        self.transport = transport; self.tools = tools; self.budget = budget
        self.latestUserMessage = latestUserMessage; self.verification = verification; self.hooks = hooks
    }

    // MARK: prepare

    /// Instructions for this turn: the uncertainty rules when the intent needs
    /// verification (ambiguous text counts as factual, the desktop fallback).
    static func prepareInstructions(_ instructions: String, classification: PhoneIntent.Classification?) -> String {
        guard let classification, classification.requiresVerification else { return instructions }
        return [instructions, PhoneUncertainty.rules].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
    static func classify(_ message: String, history: [ChatMessage]) -> PhoneIntent.Classification { PhoneIntent.classify(message, history: history) }

    // MARK: run

    func run() async throws -> AgentLoopOutcome {
        if let limits = PhoneMemberLimits.current { maxIterations = limits.iterations }
        budget.arm()
        var outcome = try await invokeModel()
        if PhoneMemberLimits.current != nil, outcome.stop != .answered { throw MeloError.message("成员达到运行上限，结果尚未完成。") }
        if let validate { try validate(outcome) }
        try await finalize(&outcome)
        return outcome
    }

    /// Unstructured race: a non-cooperative provider must not hold a structured
    /// task group open after the deadline. The loser is cancelled; late values
    /// are discarded. Tool implementations also check this scope before writes.
    private func withDeadline<T>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await PhoneExecutionScope.$budget.withValue(budget) {
            try await PhoneDeadline.run(seconds: budget.remainingMs() / 1000, work)
        }
    }

    private func exhaustedStop(_ exhausted: PhoneRunBudget.Exhaustion) async -> String {
        await hooks.onStage?("budget:exhausted", "运行预算已用完", "failed", PhoneRunBudget.stageText(exhausted))
        return PhoneRunBudget.reply(exhausted)
    }

    private func takeSupplements() async -> [String] {
        guard let take = hooks.takeSupplements else { return [] }
        return await take().map { JSText.prefix(JSText.trim($0), contract.supplementMaxChars) }.filter { !$0.isEmpty }
    }

    // MARK: invoke-model

    private func invokeModel() async throws -> AgentLoopOutcome {
        var transcript: [AgentTranscriptItem] = []
        var sources: [WebSource] = [], searched = false
        var records: [ExecutionToolCall] = []
        var evidence: [PhoneUncertainty.ToolPair] = []
        var seenCallIDs = Set<String>()
        var screenshots = 0
        var spentTokens = 0
        let guardian = PhoneRepeatGuard()
        let offered = Set((tools?.definitions ?? []).map(\.name))
        let transport = self.transport
        for iteration in 0..<maxIterations {
            if iteration > 0 {
                let supplements = await takeSupplements()
                if !supplements.isEmpty {
                    transcript.append(.userText(contract.supplementMessage(supplements)))
                    await hooks.onSupplementsJoined?(supplements)
                }
            }
            if let exhausted = budget.exhausted() {
                let text = await exhaustedStop(exhausted)
                return AgentLoopOutcome(text: text, stop: .budget, finalRound: nil, sources: sources, searched: searched, calls: records, iterations: iteration)
            }
            var round = AgentRound()
            var condensed = false
            while true {
                let request = AgentLoopRequest(iteration: iteration, transcript: transcript, timeout: budget.requestTimeout(cap: transport.timeoutCap), remainingTokens: PhoneMemberLimits.current.map { max(0, $0.tokens - spentTokens) })
                do {
                    round = try await withDeadline { try await transport.round(request) }
                    break
                } catch let error as RequestTooLarge {
                    // audit C-8 parity: condense older tool outputs once and retry; never on the first call.
                    guard iteration > 0, !condensed else { throw error }
                    let next = Self.condense(transcript)
                    guard next.changed else { throw error }
                    transcript = next.transcript; condensed = true
                    await hooks.onStage?("tool-chain:condense:\(iteration)", "工具结果已压缩", "completed", "早期工具输出已压缩以继续本轮。")
                } catch is PhoneDeadline.Reached {
                    let text = await exhaustedStop(budget.exhausted(at: budget.deadlineAt) ?? PhoneRunBudget.Exhaustion(reason: "deadline", limit: budget.deadlineAt - budget.startedAt, used: budget.deadlineAt - budget.startedAt, usage: budget.used))
                    return AgentLoopOutcome(text: text, stop: .budget, finalRound: nil, sources: sources, searched: searched, calls: records, iterations: iteration)
                } catch let error as URLError where error.code == .timedOut && !Task.isCancelled && budget.remainingMs() <= 1000 {
                    // The deadline landed inside the request: that is the budget, not a provider failure.
                    let text = await exhaustedStop(budget.exhausted(at: budget.deadlineAt) ?? PhoneRunBudget.Exhaustion(reason: "deadline", limit: budget.deadlineAt - budget.startedAt, used: budget.deadlineAt - budget.startedAt, usage: budget.used))
                    return AgentLoopOutcome(text: text, stop: .budget, finalRound: nil, sources: sources, searched: searched, calls: records, iterations: iteration)
                }
            }
            let inputTokens = round.inputTokens ?? round.estimatedInputTokens
            budget.record(inputTokens: inputTokens, providerCalls: 1)
            spentTokens += inputTokens + (round.outputTokens ?? PhoneTokenEstimate.text(round.text + round.calls.map(\.arguments).joined()))
            if let limit = PhoneMemberLimits.current?.tokens, spentTokens > limit { throw MeloError.message("成员 token 预算已用完，未继续执行工具。") }
            sources += round.sources
            searched = searched || round.searched
            let calls = transport.offersTools && tools != nil ? round.calls : []
            if calls.isEmpty {
                lastEvidence = evidence
                return AgentLoopOutcome(text: round.text, stop: .answered, finalRound: round, sources: sources, searched: searched, calls: records, iterations: iteration + 1)
            }
            // Validate the whole batch before any side effect.
            guard calls.count <= maxCallsPerResponse else { throw MeloError.message("模型一次请求了过多工具调用（超过 \(maxCallsPerResponse) 个），已全部拦截，未执行任何操作。") }
            var batchIDs = Set<String>()
            for call in calls where call.callID.isEmpty || call.callID.count > 256 || !batchIDs.insert(call.callID).inserted || seenCallIDs.contains(call.callID) {
                throw MeloError.message("模型返回的工具调用编号无效，已全部拦截，未执行任何操作。")
            }
            seenCallIDs.formUnion(batchIDs)
            var results: [AgentToolResult] = []
            for call in calls {
                let args = OrderedJSON.arguments(call.arguments)
                let started = Date()
                var outcome: PhoneToolOutcome
                var executed = false
                var cancelled = false
                var image: (Data, String)? = nil
                if Task.isCancelled {
                    outcome = PhoneToolEnvelope.finalize(ok: false, error: "ABORTED", output: "Aborted before execution.")
                } else if !offered.contains(call.name) {
                    outcome = PhoneToolEnvelope.finalize(ok: false, error: "UNKNOWN_TOOL", output: contract.unknownToolOutput)
                } else if let rejected = guardian.check(call.name, args) {
                    outcome = rejected
                } else if call.name == WebPageToolSpec.screenshot, screenshots >= WebPageText.maxScreenshotsPerReply {
                    outcome = PhoneToolEnvelope.parse(WebPageText.tooManyScreenshots(url: call.urlArgument))
                } else if let exhausted = budget.exhausted() {
                    outcome = PhoneToolEnvelope.finalize(ok: false, error: contract.budgetCode, output: AgentLoopContract.fill(contract.budgetToolSkippedTemplate, ["reason": exhausted.reason, "tool": call.name]))
                    guardian.record(call.name, args, outcome)
                } else {
                    budget.record(toolCalls: 1)
                    if let tools {
                        await hooks.onStatus?(tools.statusText(call))
                        do {
                            let result = try await withDeadline { await tools.perform(call) }
                            try PhoneExecutionScope.check(deadline: budget)
                            outcome = PhoneToolEnvelope.parse(result.output)
                            if let jpeg = result.imageJPEG { image = (jpeg, result.imageURL); screenshots += 1 }
                        } catch is PhoneDeadline.Reached {
                            outcome = PhoneToolEnvelope.finalize(ok: false, error: contract.budgetCode, output: "The run deadline expired during this tool call.")
                        } catch {
                            cancelled = error is CancellationError
                            outcome = PhoneToolEnvelope.finalize(ok: false, error: "ABORTED", output: "The tool call was cancelled.")
                        }
                    } else { outcome = PhoneToolEnvelope.finalize(ok: false, error: "UNKNOWN_TOOL", output: contract.unknownToolOutput) }
                    executed = true
                    guardian.record(call.name, args, outcome)
                }
                let record = ExecutionToolCall(iteration: iteration, call: call, args: args, outcome: outcome, executed: executed, started: started, finished: Date())
                records.append(record)
                await hooks.onToolCall?(record)
                if cancelled { throw CancellationError() }
                evidence.append(PhoneUncertainty.ToolPair(callID: call.callID, name: call.name, args: args, ok: outcome.ok, output: outcome.output, receivedAt: record.startedAt))
                if evidence.count > contract.evidenceMaxToolItems { evidence.removeFirst(evidence.count - contract.evidenceMaxToolItems) }
                results.append(AgentToolResult(call: call, modelOutput: PhoneToolEnvelope.modelFacing(outcome, maxOutputChars: max(contract.maxModelFacingOutputChars, WebPageText.maxOutputCharacters)), imageJPEG: image?.0, imageURL: image?.1 ?? ""))
            }
            await hooks.onStatus?("正在思考…")
            transcript.append(.toolRound(round, results))
            // A cancelled turn stops here: its records are already reported for the tool trace.
            try Task.checkCancellation()
            lastEvidence = evidence
        }
        // Exhaustion is not success; never publish a tool-call block as an answer.
        lastEvidence = evidence
        return AgentLoopOutcome(text: contract.toolLimitReply(for: latestUserMessage), stop: .toolLimit, finalRound: nil, sources: sources, searched: searched, calls: records, iterations: maxIterations)
    }
    private var lastEvidence: [PhoneUncertainty.ToolPair] = []

    /// `compactToolChain`: older tool outputs (all but the newest two rounds) are
    /// cut to 600 characters with the condensed marker; call ids never change.
    static func condense(_ transcript: [AgentTranscriptItem]) -> (transcript: [AgentTranscriptItem], changed: Bool) {
        let c = AgentLoopContract.shared
        let roundIndices = transcript.indices.filter { if case .toolRound = transcript[$0] { return true }; return false }
        let protected = Set(roundIndices.suffix(c.condenseKeepRecentResults))
        var changed = false
        let next = transcript.enumerated().map { index, item -> AgentTranscriptItem in
            guard case .toolRound(let round, let results) = item, !protected.contains(index) else { return item }
            let condensed = results.map { result -> AgentToolResult in
                var copy = result
                if copy.imageJPEG != nil { copy.imageJPEG = nil; changed = true }
                let output = condenseOutput(result.modelOutput, maxChars: c.condenseMaxOutputChars)
                if output != result.modelOutput { copy.modelOutput = output; changed = true }
                return copy
            }
            return .toolRound(round, condensed)
        }
        return (next, changed)
    }
    static func condenseOutput(_ envelope: String, maxChars: Int) -> String {
        let marker = AgentLoopContract.shared.condensedMarker
        if let parsed = OrderedJSON.parse(envelope), case .object(let fields) = parsed, let output = parsed["output"] {
            let text: String
            switch output { case .string(let value): text = value; case .null: text = ""; default: text = output.json }
            guard JSText.length(text) > maxChars else { return envelope }
            return OrderedJSON.object(fields.map { $0.0 == "output" ? ($0.0, .string(JSText.prefix(text, maxChars) + "\n" + marker)) : $0 }).json
        }
        return JSText.length(envelope) > maxChars ? JSText.prefix(envelope, maxChars) + "\n" + marker : envelope
    }

    // MARK: finalize

    private func finalize(_ outcome: inout AgentLoopOutcome) async throws {
        guard let verification else { return }
        let parsed = PhoneUncertainty.parse(outcome.text)
        outcome.text = parsed.cleanReply
        guard parsed.hasMarker else { return }
        var classification = verification.classification
        let transport = self.transport
        if classification.taskType == nil && classification.riskLevel != "high" {
            // Ambiguous wording: the desktop asks the classifier model; the phone asks only when it matters.
            guard budget.exhausted() == nil else { return }
            do {
                let timeout = budget.requestTimeout(cap: transport.timeoutCap)
                let question = verification.question
                let answer = try await withDeadline { try await transport.complete(system: AgentLoopContract.shared.intentFallbackSystemPrompt, messages: [ChatMessage(role: "user", content: JSText.trim(question))], timeout: timeout) }
                budget.record(inputTokens: PhoneTokenEstimate.text(AgentLoopContract.shared.intentFallbackSystemPrompt + question), providerCalls: 1)
                classification.taskType = PhoneIntent.normalize(answer)
            } catch {
                if Task.isCancelled || error is CancellationError { throw error }
                classification.taskType = "factual"
            }
        }
        guard classification.requiresVerification, budget.exhausted() == nil else { return }
        await hooks.onStage?("finalize:verify", "核实不确定内容", "running", parsed.uncertainClaim)
        let toolEvidence = PhoneUncertainty.collect(lastEvidence, query: latestUserMessage)
        let timeout = budget.requestTimeout(cap: transport.timeoutCap)
        let budget = self.budget
        let result = try await PhoneUncertainty.verify(question: verification.question, reply: parsed.cleanReply, claim: parsed.uncertainClaim,
                                                       contextBlocks: verification.contextBlocks, toolEvidence: toolEvidence) { system, messages in
            budget.record(inputTokens: PhoneTokenEstimate.text(system + messages.map(\.content).joined()), providerCalls: 1)
            return try await self.withDeadline { try await transport.complete(system: system, messages: messages, timeout: timeout) }
        }
        outcome.text = PhoneUncertainty.apply(parsed.cleanReply, result)
        outcome.verification = result
        let label = ["VERIFIED": "已核实", "CORRECTED": "已按证据更正", "UNVERIFIED": "未能核实，已标注"][result.verdict] ?? result.verdict
        await hooks.onStage?("finalize:verify", "核实不确定内容", "completed", label)
    }
}

/// Shared by the loop, approval queue and the real device/web dispatchers.
enum PhoneExecutionScope {
    @TaskLocal static var budget: PhoneRunBudget?
    static func check(deadline: PhoneRunBudget? = nil) throws {
        try Task.checkCancellation()
        if let budget = deadline ?? budget, budget.remainingMs() <= 0 { throw PhoneDeadline.Reached() }
    }
}

enum PhoneDeadline {
    struct Reached: Error {}
    static func run<T>(seconds: TimeInterval, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try Task.checkCancellation()
        guard seconds > 0 else { throw Reached() }
        let race = DeadlineRace<T>()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                race.install(continuation)
                race.add(Task {
                    do { try Task.checkCancellation(); let result = try await work(); try Task.checkCancellation(); race.finish(.success(result)) }
                    catch { race.finish(.failure(error)) }
                })
                race.add(Task {
                    do {
                        try await Task.sleep(nanoseconds: UInt64(min(seconds, 86_400) * 1_000_000_000))
                        race.finish(.failure(Reached()))
                    } catch { /* The winning request cancelled the timer. */ }
                })
            }
        }, onCancel: { race.finish(.failure(CancellationError())) })
    }
}

/// Single resume and loser cancellation, including cancellation before install.
private final class DeadlineRace<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    private var result: Result<T, Error>?
    private var tasks: [Task<Void, Never>] = []
    func install(_ value: CheckedContinuation<T, Error>) {
        lock.lock()
        let done = result
        if done == nil { continuation = value }
        lock.unlock()
        if let done { value.resume(with: done) }
    }
    func add(_ task: Task<Void, Never>) {
        lock.lock(); let done = result != nil
        if !done { tasks.append(task) }
        lock.unlock()
        if done { task.cancel() }
    }
    func finish(_ value: Result<T, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let pending = continuation, losers = tasks
        continuation = nil; tasks = []
        lock.unlock()
        losers.forEach { $0.cancel() }
        pending?.resume(with: value)
    }
}

/// Supplements typed while a reply runs (src/services/chat/supplements.js).
/// The loop takes them before its next model call; whatever is left when the
/// reply ends is handed back so it can be sent as the next message.
@MainActor final class PhoneSupplements {
    private(set) var queued: [String] = []
    private(set) var used: [String] = []
    func add(_ text: String) -> Bool {
        let clean = JSText.prefix(JSText.trim(text), AgentLoopContract.shared.supplementMaxChars)
        guard !clean.isEmpty else { return false }
        queued.append(clean); return true
    }
    func take() -> [String] { let taken = queued; queued = []; used += taken; return taken }
    /// Ends the turn: the supplements that were never used.
    func end() -> [String] { let left = queued; queued = []; return left }
}

/// Token estimate for a request body when the provider sends no usage:
/// shared multilingual estimate, with base64 payloads left out (not prose).
enum RequestSizeEstimate {
    private static let base64 = try! NSRegularExpression(pattern: #"(?:;base64,|"data":")[A-Za-z0-9+/=]{64,}"#)
    static func tokens(_ body: Data) -> Int {
        guard let text = String(data: body, encoding: .utf8) else { return body.count / 4 }
        let prose = base64.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
        return PhoneTokenEstimate.text(prose)
    }
}

/// Captured per member; no process-global settings can widen a running child.
struct PhoneMemberLimits: Sendable {
    @TaskLocal static var current: PhoneMemberLimits?
    var iterations: Int
    var tokens: Int
    var timeoutMs: Double
    static func outputAllowance(body: [String: Any], remaining: Int?) throws -> Int? {
        guard let remaining else { return nil }
        let data = try JSONSerialization.data(withJSONObject: body)
        let input = RequestSizeEstimate.tokens(data)
        guard remaining > input else { throw MeloError.message("成员 token 预算不足，未发起下一次模型请求。") }
        return remaining - input
    }
}
