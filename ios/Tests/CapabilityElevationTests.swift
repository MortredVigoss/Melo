import Foundation

// iPhone capability elevation (2026-10-20, docs/capability-elevation-20261020.md §9):
// phone decision table, the device-local ledger (expiry, prune, relaunch,
// corrupt file, never backed up), revocation before the next call, collapse of
// concurrent requests, no-surface denial, ceiling, team member beyond the lead,
// timeout / run deadline / cancellation, «一直开启», prompt injection, the tool
// choke point and its run record, the read-only starter set and «基于已有 Agent».
// The desktop fixtures themselves run in SharedContractTests.

final class Clock: @unchecked Sendable {
    var now: Double = 1_800_000_000_000
    func read() -> Double { now }
}
@MainActor final class Box<T> { var value: T; init(_ value: T) { self.value = value } }

@MainActor final class Harness {
    let broker: CapabilityElevationBroker
    var requests: [CapabilityRequest] = []
    var closed: [(id: String, status: CapabilityElevationBroker.Status)] = []
    var audits: [(status: String, text: String)] = []
    var always: [CapabilityRequest] = []
    init(file: URL?, clock: Clock, boot: String = "boot-1", timeout: Double? = nil) {
        broker = CapabilityElevationBroker(file: file, bootID: boot, clock: clock.read, promptTimeoutMs: timeout)
        broker.onRequest = { [unowned self] in self.requests.append($0) }
        broker.onClose = { [unowned self] request, status in self.closed.append((request.id, status)) }
        broker.onAudit = { [unowned self] _, status, text in self.audits.append((status, text)) }
        broker.enableAlways = { [unowned self] request in self.always.append(request); return "phone" }
    }
    func authorize(_ tool: String, _ binding: PhoneElevationBinding) async -> CapabilityGate {
        await broker.authorize(toolID: tool, requirement: .phoneTool(tool), binding: binding)
    }
}

@MainActor func until(_ what: String, _ condition: @MainActor () -> Bool) async {
    for _ in 0..<2000 where !condition() { try? await Task.sleep(nanoseconds: 1_000_000) }
    assert(condition(), "timed out waiting for \(what)")
}

@MainActor func binding(_ agent: String, _ name: String, own: @escaping @MainActor () -> Set<String>, parent: (id: String, name: String, atoms: @MainActor () -> Set<String>)? = nil,
                        run: String = "run-1", chat: String = "chat-1", project: String? = nil, surface: Bool = true, budget: PhoneRunBudget? = nil) -> PhoneElevationBinding {
    PhoneElevationBinding(agentID: agent, agentName: name, parentAgentID: parent?.id, parentName: parent?.name, runID: run, chatID: chat, projectID: project,
                          ceiling: own, parent: parent?.atoms, surface: { surface }, budget: budget)
}

final class OneCallTransport: AgentModelTransport, @unchecked Sendable {
    var offersTools = true
    var timeoutCap: TimeInterval = 120
    var step = 0
    func round(_ input: AgentLoopRequest) async throws -> AgentRound {
        step += 1
        return step == 1 ? AgentRound(text: "", calls: [ResponsesFunctionCall(callID: "c1", name: "contacts_search", arguments: #"{"query":"张"}"#)], echo: .none, estimatedInputTokens: 10)
                         : AgentRound(text: "done", estimatedInputTokens: 10)
    }
    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String { "" }
}

func code(_ envelope: String?) -> String? { envelope.map { PhoneToolEnvelope.parse($0).code ?? "" } }

@main struct CapabilityElevationTests {
    @MainActor static func main() async throws {
        let c = CapabilityElevation.contract
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("melo-capability-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent(CapabilityElevationBroker.fileName)

        // 1. Phone decision table (contract phone mapping).
        func decide(_ tool: String, own: Set<String>, lead: Set<String>? = nil, surface: Bool = true, project: String? = nil) -> CapabilityDecision {
            CapabilityElevation.decide(toolId: tool, requirement: .phoneTool(tool), member: CapabilityParty(agentId: "writer", capabilities: own),
                                       parent: lead.map { CapabilityParty(agentId: "melo", capabilities: $0) }, context: CapabilityContext(surface: surface, runId: "r", projectId: project, chatId: "c"), now: 1)
        }
        assert(decide("open_url", own: ["network"]).decision == "allowed" && decide("open_url", own: ["network"]).reason == "base")
        var d = decide("contacts_search", own: ["network"])
        assert(d.decision == "enable-own" && d.missing == ["contacts"] && d.options == ["run", "always", "deny"], "own permission missing → enable-own")
        d = decide("contacts_search", own: ["network", "contacts"], lead: ["network"])
        assert(d.decision == "elevate-beyond-parent" && d.options == ["run", "project", "deny"] && d.projectOptionScope == "chat", "member beyond the lead, no project → chat")
        assert(decide("contacts_search", own: ["network", "contacts"], lead: ["network"], project: "p1").projectOptionScope == "project")
        d = decide("calendar_list_events", own: ["network"], lead: ["network", "calendar"])
        assert(d.decision == "enable-own" && d.missing == ["calendar"], "ceiling: the member's own settings, even when the lead has it")
        assert(decide("open_url", own: ["network"], lead: ["network"]).decision == "allowed")
        assert(decide("read_history", own: []).decision == "allowed", "read_history is not capability-gated on the phone")
        d = decide("run_shell", own: ["network"])
        assert(d.decision == "deny-ceiling" && d.reason == "unclassified", "unknown tools are never elevated")
        d = decide("calendar_create_event", own: [], surface: false)
        assert(d.decision == "deny-no-surface" && d.wouldPrompt == "enable-own" && d.missing == ["calendar"])
        d = decide("web_screenshot", own: ["network"], lead: [], surface: false)
        assert(d.decision == "deny-no-surface" && d.wouldPrompt == "elevate-beyond-parent")
        assert(CapabilityElevation.requestable(["network"], ceiling: ["network", "contacts"], surface: false, jitVisible: c.phoneJitVisible) == ["network"], "no surface: nothing new is visible")
        let visible = CapabilityElevation.requestable(["network"], ceiling: ["network", "contacts"], surface: true, jitVisible: c.phoneJitVisible)!
        assert(visible.isSuperset(of: ["network", "contacts", "calendar", "reminders", "location"]) && !visible.contains("delegate"), "surface: ceiling + just-in-time booleans, never delegate")
        assert(CapabilityElevation.label(atoms: ["location", "network", "calendar"]) == "联网、日历、当前位置")
        assert(CapabilityElevation.promptText(decision: "enable-own", agent: "Melo", parent: nil, atoms: ["contacts"]) == "此 Agent（Melo）需要『通讯录』")
        assert(CapabilityElevation.phoneText("timeoutOutput", ["agent": "A", "capability": "联网", "tool": "open_url"]).contains("这台 iPhone"), "phone timeout wording")
        assert(Set(c.phonePermissionAtoms) == Set(PhoneCapability.allCases.map(\.rawValue)))

        // 2. Prompt → run grant; prompt injection; run grant does not carry into the next run.
        let clock = Clock()
        let h = Harness(file: file, clock: clock)
        let own = Box<Set<String>>(["network", "contacts"]), lead = Box<Set<String>>(["network"])
        let writer = binding("writer", "写作伙伴", own: { own.value }, parent: ("melo", "Melo", { lead.value }))
        let pendingCall = Task { await h.authorize("contacts_search", writer) }
        await until("the first card") { h.requests.count == 1 }
        let card = h.requests[0]
        assert(card.decision == "elevate-beyond-parent" && card.atoms == ["contacts"] && card.options == ["run", "project", "deny"] && card.projectOptionScope == "chat")
        assert(card.prompt == "写作伙伴 需要『通讯录』，Melo 没有这个能力" && card.expiresAt - card.createdAt == c.promptTimeoutMs)
        assert(h.audits.last?.status == "running" && h.audits.last?.text == "等待用户决定：" + card.prompt)
        // Model text / tool output can only carry strings: nothing but the live id + an offered option creates a grant.
        for (id, option) in [("cg_" + UUID().uuidString, "run"), ("requestId=\(card.auditID)", "run"), (card.id, "always"), (card.id, "forever"), (card.id + " ", "project"), (String(card.id.dropLast()), "project")] {
            do { try h.broker.respond(requestID: id, decision: option); assert(false, "\(id)/\(option) must not create a grant") }
            catch { assert(error is CapabilityRequestError) }
        }
        assert(h.broker.grants.isEmpty && h.broker.pendingRequests.count == 1, "no grant from a forged decision")
        let runGrant = try h.broker.respond(requestID: card.id, decision: "run")!
        var gate = await pendingCall.value
        assert(gate.denial == nil && gate.audit?.allowed == true && gate.audit?.status == "granted" && gate.audit?.grantScope == "run" && gate.audit?.response == "run")
        assert(runGrant.kind == "elevate-beyond-parent" && runGrant.scope == "run" && runGrant.runId == "run-1" && runGrant.bootId == "boot-1" && runGrant.decidedBy == "user")
        assert(h.closed.last?.status == .granted && h.audits.last?.status == "completed" && h.audits.last!.text.hasPrefix("用户允许 写作伙伴 使用『通讯录』（仅本次任务，至 ") && h.audits.last!.text.hasSuffix(" · contacts_search"))
        do { try h.broker.respond(requestID: card.id, decision: "run"); assert(false) } catch { assert(error as? CapabilityRequestError == .ended, "a second tap on an ended card saves nothing") }
        gate = await h.authorize("contacts_search", writer)
        assert(gate.denial == nil && gate.audit?.reason == "grant" && gate.audit?.grantIds == [runGrant.id] && h.requests.count == 1, "the run grant covers the next call without a card")
        gate = await h.authorize("contacts_search", binding("writer", "写作伙伴", own: { own.value }, parent: ("melo", "Melo", { lead.value }), run: "run-2", surface: false))
        assert(gate.denial == CapabilityElevationBroker.deniedOutput(agentID: "writer", toolID: "contacts_search") && gate.audit?.decision == "deny-no-surface" && h.requests.count == 1,
               "no surface: denied exactly as before, no card; a run grant does not carry into the next run")

        // 3. A grant never exceeds the member ceiling; the lead's grants are not inherited.
        own.value.remove("contacts")
        d = h.broker.decide(toolID: "contacts_search", requirement: .phoneTool("contacts_search"), binding: writer, surface: true)
        assert(d.decision == "enable-own" && d.effective == ["network"], "a beyond-parent grant stops at the member's own settings")
        own.value.insert("contacts")

        // 4. Revocation applies to the next call; the 24-hour chat grant.
        try h.broker.revoke(runGrant.id)
        assert(h.broker.list(agentID: "writer").isEmpty)
        let afterRevoke = Task { await h.authorize("contacts_search", writer) }
        await until("the card after revoking") { h.requests.count == 2 }
        let chatGrant = try h.broker.respond(requestID: h.requests[1].id, decision: "project")!
        gate = await afterRevoke.value
        assert(gate.denial == nil && gate.audit?.grantScope == "chat" && chatGrant.scope == "chat" && chatGrant.projectId == nil && chatGrant.chatId == "chat-1")
        assert(chatGrant.expiresAt == clock.now + 86_400_000 && chatGrant.bootId == nil)
        assert(h.audits.last!.text.contains("本对话 24 小时"))
        assert(h.broker.allowsNow(toolID: "contacts_search", requirement: .phoneTool("contacts_search"), binding: binding("writer", "写作伙伴", own: { own.value }, parent: ("melo", "Melo", { lead.value }), run: "run-7", surface: false)),
               "an existing grant applies without a surface")
        assert(!h.broker.allowsNow(toolID: "contacts_search", requirement: .phoneTool("contacts_search"), binding: binding("writer", "写作伙伴", own: { own.value }, parent: ("melo", "Melo", { lead.value }), chat: "chat-2", surface: false)),
               "a chat grant is bound to its chat")
        let leadBinding = binding("melo", "Melo", own: { lead.value })
        assert(!h.broker.allowsNow(toolID: "contacts_search", requirement: .phoneTool("contacts_search"), binding: leadBinding), "a member's grant never applies to the lead")

        // 5. «一直开启» (enable-own): the permission path plus a run grant; audit names the phone settings.
        let alwaysCall = Task { await h.authorize("location_current", leadBinding) }
        await until("the enable-own card") { h.requests.count == 3 }
        let ownCard = h.requests[2]
        assert(ownCard.decision == "enable-own" && ownCard.options == ["run", "always", "deny"] && ownCard.prompt == "此 Agent（Melo）需要『当前位置』")
        let alwaysGrant = try h.broker.respond(requestID: ownCard.id, decision: "always")!
        gate = await alwaysCall.value
        assert(gate.denial == nil && h.always.map(\.id) == [ownCard.id] && alwaysGrant.kind == "enable-own" && alwaysGrant.scope == "run")
        assert(h.audits.last?.text == "用户为 Melo 一直开启『当前位置』（这台手机上的设置） · location_current")
        h.broker.enableAlways = { _ in throw MeloError.message("设置中尚未开启") }
        let failingAlways = Task { await h.authorize("calendar_list_events", leadBinding) }
        await until("the second enable-own card") { h.requests.count == 4 }
        do { try h.broker.respond(requestID: h.requests[3].id, decision: "always"); assert(false) } catch { assert(!(error is CapabilityRequestError)) }
        assert(h.broker.pendingRequests.count == 1 && !h.broker.grants.contains { $0.atoms == ["calendar"] }, "a failed «一直开启» saves nothing and keeps the card")
        try h.broker.respond(requestID: h.requests[3].id, decision: "deny")
        gate = await failingAlways.value
        assert(code(gate.denial) == "CAPABILITY_DENIED" && gate.denial!.contains("不要重试") && gate.audit?.status == "denied" && h.audits.last?.text == "用户拒绝 Melo 使用『日历』 · calendar_list_events")

        // 6. Ledger file: private, not backed up, survives a relaunch except run grants; 24-hour expiry; corrupt file.
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        assert(raw["version"] as? Int == 1 && (raw["grants"] as? [Any])?.count == 2, "chat grant + «一直开启» run grant on disk")
        let backup = try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
        assert(backup == true, "the ledger is never backed up")
        let relaunched = Harness(file: file, clock: clock, boot: "boot-2")
        assert(relaunched.broker.list().map(\.id) == [chatGrant.id], "run grants are dropped on relaunch; the 24-hour grant stays")
        assert(relaunched.broker.allowsNow(toolID: "contacts_search", requirement: .phoneTool("contacts_search"), binding: binding("writer", "写作伙伴", own: { own.value }, parent: ("melo", "Melo", { lead.value }), run: "run-8", surface: false)))
        clock.now += 86_400_000
        assert(relaunched.broker.list().isEmpty && relaunched.broker.decide(toolID: "contacts_search", requirement: .phoneTool("contacts_search"), binding: writer, surface: true).decision == "elevate-beyond-parent", "24 hours later the chat grant has expired")
        try relaunched.broker.revoke(chatGrant.id)
        let pruned = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        assert((pruned["grants"] as! [Any]).isEmpty, "expired and revoked grants are pruned from the file")
        let corrupt = directory.appendingPathComponent("corrupt/" + CapabilityElevationBroker.fileName)
        try FileManager.default.createDirectory(at: corrupt.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: corrupt)
        let recovered = Harness(file: corrupt, clock: clock)
        let kept = try FileManager.default.contentsOfDirectory(atPath: corrupt.deletingLastPathComponent().path)
        assert(recovered.broker.grants.isEmpty && kept.contains { $0.contains(".corrupt-") }, "a corrupt ledger is kept aside and read as empty")
        var forged = runGrant; forged.decidedBy = nil; forged.id = "forged"
        assert(CapabilityElevationBroker.normalize(forged) == nil, "records not decided by the user are dropped")
        var widened = runGrant; widened.atoms = ["contacts", "bogus"]
        assert(CapabilityElevationBroker.normalize(widened) == nil, "unknown atoms fail closed")

        // 7. Concurrent identical requests collapse into one card; one tap answers both.
        let hc = Harness(file: nil, clock: clock)
        let meloOwn = Box<Set<String>>(["network"])
        let melo = binding("melo", "Melo", own: { meloOwn.value }, run: "run-c")
        let first = Task { await hc.authorize("contacts_search", melo) }
        let second = Task { await hc.authorize("contacts_search", melo) }
        await until("the shared card") { hc.requests.count == 1 }
        try await Task.sleep(nanoseconds: 30_000_000)
        assert(hc.requests.count == 1 && hc.broker.pendingRequests.count == 1, "identical requests share one card")
        try hc.broker.respond(requestID: hc.requests[0].id, decision: "run")
        let (a, b) = (await first.value, await second.value)
        assert(a.denial == nil && b.denial == nil && hc.broker.grants.count == 1)
        let otherAgent = Task { await hc.authorize("contacts_search", binding("analyst", "分析助手", own: { [] }, run: "run-c")) }
        await until("a different Agent's card") { hc.requests.count == 2 }
        hc.broker.releaseRun("run-c")
        gate = await otherAgent.value
        assert(code(gate.denial) == "ABORTED" && hc.broker.grants.isEmpty && hc.closed.last?.status == .aborted, "run end drops run grants and closes open cards")

        // 8. Timeout, run deadline and cancellation.
        let quick = Harness(file: nil, clock: clock, timeout: 30)
        gate = await quick.authorize("contacts_search", melo)
        assert(code(gate.denial) == "CAPABILITY_DENIED" && gate.denial!.contains("这台 iPhone") && quick.closed.last?.status == .timeout && quick.broker.grants.isEmpty && quick.audits.last!.status == "failed")
        gate = await hc.authorize("contacts_search", binding("melo", "Melo", own: { meloOwn.value }, run: "run-d", budget: PhoneRunBudget(deadlineMs: 20)))
        assert(code(gate.denial) == "BUDGET_EXHAUSTED" && hc.closed.last?.status == .budget, "the run deadline still applies while a card waits")
        let cancelled = Task { await hc.authorize("contacts_search", binding("melo", "Melo", own: { meloOwn.value }, run: "run-e")) }
        await until("the card to cancel") { hc.broker.pendingRequests.count == 1 }
        cancelled.cancel()
        gate = await cancelled.value
        assert(code(gate.denial) == "ABORTED" && hc.broker.pendingRequests.isEmpty && hc.closed.last?.status == .aborted && hc.audits.last?.status == "cancelled")

        // 9. The tool choke point and the run record.
        final class Count { var value = 0 }
        let executed = Count()
        let denyAudit = CapabilityAudit(decision: "deny-no-surface", reason: "no-surface", missing: ["contacts"], allowed: false)
        let gated = DeviceToolContext(policy: DeviceToolPolicy(enabled: [.contacts]), execute: { _ in executed.value += 1; return PhoneToolEnvelope.success(#"{"count":0,"contacts":[]}"#) },
                                      gate: { _ in CapabilityGate(denial: CapabilityElevationBroker.deniedOutput(agentID: "melo", toolID: "contacts_search"), audit: denyAudit) })
        let refused = await gated.perform(ResponsesFunctionCall(callID: "x", name: "contacts_search", arguments: #"{"query":"张"}"#))
        assert(executed.value == 0 && refused.capability == denyAudit && code(refused.output) == "CAPABILITY_DENIED", "a refused call never reaches the tool")
        let grantAudit = CapabilityAudit(decision: "allowed", reason: "grant", missing: [], grantIds: ["g"], allowed: true)
        var passing = gated; passing.gate = { _ in CapabilityGate(denial: nil, audit: grantAudit) }
        let ran = await passing.perform(ResponsesFunctionCall(callID: "y", name: "contacts_search", arguments: #"{"query":"张"}"#))
        assert(executed.value == 1 && ran.capability == grantAudit)
        let records = Box<[ExecutionToolCall]>([])
        let outcome = try await AgentLoop(transport: OneCallTransport(), tools: AgentLoopTools(definitions: DeviceToolSpec.all.map(\.definition), instructions: "", perform: gated.perform),
                                          budget: PhoneRunBudget(), latestUserMessage: "q", hooks: AgentLoopHooks(onToolCall: { records.value.append($0) })).run()
        assert(outcome.text == "done" && records.value.count == 1 && records.value[0].executed == false && records.value[0].capability == denyAudit && records.value[0].code == "CAPABILITY_DENIED",
               "the run record keeps the decision and marks the call as not executed")
        let encoded = try JSONDecoder().decode(ExecutionToolCall.self, from: JSONEncoder().encode(records.value[0]))
        assert(encoded.capability == denyAudit)
        let legacyRecord = #"{"iteration":0,"callId":"a","toolId":"open_url","argsDigest":"","argsHash":"","status":"ok","executed":true,"startedAt":"x","durationMs":1}"#
        let legacy = try JSONDecoder().decode(ExecutionToolCall.self, from: Data(legacyRecord.utf8))
        assert(legacy.capability == nil, "older records stay readable")

        // 10. New Agents: read-only starter set and «基于已有 Agent».
        let starter = AgentStarter.newAgent()
        for key in c.booleanKeys { assert(starter.capabilities?[key].bool == c.newAgentStarter.contains(key), "starter \(key)") }
        assert(c.newAgentStarter == ["readFiles", "network", "knowledgeMemory"] && starter.capabilities?["mcpServers"].array.isEmpty == true && starter.name.isEmpty)
        var draft = AgentStarter.newAgent(); draft.name = "新助手"
        var source = AgentProfile(id: "builder", name: "Builder", subtitle: "建造", symbol: "hammer", instructions: "写代码", avatarData: Data([1, 2, 3]), identity: "工程师", mood: "focused", model: "gpt-x")
        source.capabilities = AgentCapabilityWidening.widened(AgentSettingsProjection.emptyCapabilities, with: ["readFiles", "writeFiles", "mcpServers:github"])
        source.collaboration = .object(["canDelegate": .bool(true), "delegateTargets": .array([.string("research"), .string(draft.id)]), "maxDelegationDepth": .number(1), "maxIterations": .number(8), "maxTokens": .number(32000), "timeoutMs": .number(180000)])
        source.contextSources = .object(["projects": .bool(false), "knowledge": .bool(true), "memory": .bool(true)])
        let based = AgentStarter.apply(draft, source: source, copyPersona: false, previousSource: nil, previousCopy: false)
        assert(based.capabilities == source.capabilities && based.contextSources == source.contextSources && based.model == "gpt-x")
        assert(based.collaboration?["delegateTargets"].array == [.string("research")] && based.collaboration?["canDelegate"].bool == true, "never itself as a delegate target")
        assert(based.id == draft.id && based.name == "新助手" && based.avatarData == nil && based.symbol == "person.crop.square" && based.instructions.isEmpty && based.description.isEmpty && based.mood == nil,
               "identity/persona only when ticked; never the id, name, avatar or icon")
        let persona = AgentStarter.apply(based, source: source, copyPersona: true, previousSource: source, previousCopy: false)
        assert(persona.instructions == source.instructions && persona.identity == "工程师" && persona.description == "建造" && persona.mood == "focused" && persona.name == "新助手" && persona.avatarData == nil)
        let unticked = AgentStarter.apply(persona, source: source, copyPersona: false, previousSource: source, previousCopy: true)
        assert(unticked.instructions.isEmpty && unticked.description.isEmpty && unticked.capabilities == source.capabilities)
        var edited = persona; edited.instructions += "\n我的修改"
        assert(AgentStarter.apply(edited, source: source, copyPersona: false, previousSource: source, previousCopy: true).instructions == edited.instructions, "edited persona text is kept")
        let readOnly = AgentStarter.apply(persona, source: nil, copyPersona: false, previousSource: source, previousCopy: true)
        assert(readOnly.capabilities == AgentStarter.capabilities && readOnly.collaboration == nil && readOnly.contextSources == nil && readOnly.model == nil && readOnly.instructions.isEmpty)
        source.capabilities = AgentSettingsProjection.emptyCapabilities
        assert(based.capabilities?["writeFiles"].bool == true, "afterwards the two Agents are independent")

        // 11. A synced (desktop) capability: «一直开启» on the phone is a widening the desktop must confirm.
        var preferences = MobilePreferences()
        let globalScope = try AgentCapabilityWidening.propose(["knowledgeMemory", "mcpServers:github"], agentID: "melo", projectID: nil, preferences: &preferences)
        assert(globalScope == "global")
        assert(preferences.agents[0].capabilities?["knowledgeMemory"].bool == true && preferences.agents[0].capabilities?["mcpServers"].array == [.string("github")])
        for atom in ["contacts", "network", "generateMedia"] {
            do { _ = try AgentCapabilityWidening.propose([atom], agentID: "melo", projectID: nil, preferences: &preferences); assert(false, "\(atom) is a phone permission") } catch {}
        }
        var override = preferences.agents[0]; override.capabilities = AgentSettingsProjection.emptyCapabilities
        preferences.projectAgents = ["p1": ["melo": override]]
        do { _ = try AgentCapabilityWidening.propose(["writeFiles"], agentID: "melo", projectID: "p1", preferences: &preferences); assert(false) }
        catch { assert(error.localizedDescription.contains("项目设置不能单独开启"), "a project override cannot enable what the global settings lack") }
        let projectScope = try AgentCapabilityWidening.propose(["knowledgeMemory"], agentID: "melo", projectID: "p1", preferences: &preferences)
        assert(projectScope == "project")
        assert(preferences.projectAgents?["p1"]?["melo"]?.capabilities?["knowledgeMemory"].bool == true && preferences.agents[0].capabilities?["writeFiles"].bool == false)
        preferences.agents[1].capabilities = nil
        do { _ = try AgentCapabilityWidening.propose(["knowledgeMemory"], agentID: preferences.agents[1].id, projectID: nil, preferences: &preferences); assert(false, "legacy Agents migrate on the desktop first") } catch {}

        print("Capability elevation passed: phone decision table, ledger (file, relaunch, expiry, corrupt), revoke, collapse, no surface, ceiling, team member, timeout/deadline/cancel, «一直开启», prompt injection, choke point + run record, starter set, «基于已有 Agent», synced widening")
    }
}
