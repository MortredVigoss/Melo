import Foundation

// iPhone half of the cross-platform behaviour contract. The same fixture runs in
// mobile-sync/crossPlatformContracts.test.js; desktop (JS) values are canonical.
@main struct SharedContractTests {
    static func main() {
        let url = URL(fileURLWithPath: "shared/protocol/contracts.json")
        let contract = try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]

        let prose = contract["proseUrls"] as! [[String: Any]]
        assert(prose.count >= 10)
        for row in prose {
            let text = row["text"] as! String, expected = row["urls"] as! [String]
            let actual = WebReplyFormatter.candidateURLs(in: text)
            assert(actual == expected, "prose URLs differ for \(text): \(actual) vs \(expected)")
        }

        let identities = contract["sourceIdentity"] as! [[String: Any]]
        assert(identities.count >= 20)
        for row in identities {
            let input = row["url"] as! String, expected = row["identity"] as! String
            let actual = WebSource.identity(input) ?? ""
            assert(actual == expected, "source identity differs for \(input): \(actual) vs \(expected)")
        }

        let replay = contract["toolLoopReplay"] as! [String: Any]
        let output = replay["output"] as! [[String: Any]]
        let results = (replay["results"] as! [[String: String]]).map { (callID: $0["call_id"]!, output: $0["output"]!) }
        let previous: [Any] = [["role": "user", "content": "问题"]]
        let input = DeviceToolLoop.followUpInput(previous: previous, output: output, results: results)
        let tail = Array(input.suffix(output.count + results.count))
        for (index, item) in output.enumerated() {
            assert(NSDictionary(dictionary: tail[index] as! [String: Any]).isEqual(to: item), "output item \(index) must be replayed verbatim")
        }
        let outputs = tail.suffix(results.count).map { $0 as! [String: Any] }
        assert(outputs.map { $0["type"] as? String } == Array(repeating: "function_call_output", count: results.count))
        assert(outputs.map { $0["call_id"] as? String } == results.map(\.callID))
        assert(outputs.allSatisfy { $0["output"] is String })

        let handoffs = contract["teamHandoff"] as! [[String: Any]]
        assert(handoffs.count >= 6)
        for row in handoffs {
            let expected = row["expected"] as! [String: Any]
            let h = AgentTeam.handoff(task: row["task"] as! String, output: row["output"] as! String, ok: row["ok"] as! Bool)
            assert(h.conclusion == expected["conclusion"] as! String, "conclusion differs for \((row["output"] as! String).prefix(60))")
            assert(h.evidence == expected["evidence"] as! [String] && h.changedFiles == expected["changedFiles"] as! [String] && h.unfinished == expected["unfinished"] as! [String], "lists differ for \((row["output"] as! String).prefix(60))")
            assert(h.status == expected["status"] as! String && h.review == expected["review"] as? String, "status/review differ for \((row["output"] as! String).prefix(60))")
        }

        let plans = contract["teamPlans"] as! [[String: Any]]
        for row in plans {
            let plan = row["plan"] as! [String: Any]
            let result = try? AgentTeam.validate(templateID: plan["templateId"] as! String, members: plan["members"] as! [String])
            if row["error"] as? Bool == true { assert(result == nil, "plan should be rejected: \(plan)"); continue }
            assert(result?.mode.rawValue == row["mode"] as? String && result?.members == row["members"] as? [String], "plan differs: \(plan)")
        }

        let schedules = contract["teamSchedule"] as! [[String: Any]]
        let wait = DispatchSemaphore(value: 0)
        Task.detached {
            for row in schedules {
                let planValue = row["plan"] as! [String: Any], approveRound = row["approveRound"] as! Int
                let plan = try! AgentTeam.validate(templateID: planValue["templateId"] as! String, members: planValue["members"] as! [String])
                final class Log: @unchecked Sendable { var calls: [String] = []; let lock = NSLock() }
                let log = Log()
                let outcome = await AgentTeam.run(plan, task: "t") { call in
                    log.lock.lock(); log.calls.append("\(call.memberID)\(call.round):" + call.prior.map(\.conclusion).joined(separator: "|")); log.lock.unlock()
                    let reviewer = plan.mode == .reviewLoop && call.memberID == plan.members[1]
                    var body: [String: Any] = ["conclusion": "\(call.memberID) r\(call.round)", "evidence": [], "changedFiles": [], "unfinished": []]
                    if reviewer { body["review"] = approveRound > 0 && call.round >= approveRound ? "approve" : "revise" }
                    return String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
                }
                let expected = (row["calls"] as! [[String: Any]]).map { "\($0["member"]!)\($0["round"]!):" + ($0["prior"] as! [String]).joined(separator: "|") }
                let prefix = row["parallelPrefix"] as! Int
                assert(log.calls.prefix(prefix).sorted() == expected.prefix(prefix).sorted() && Array(log.calls.dropFirst(prefix)) == Array(expected.dropFirst(prefix)), "team order differs for \(planValue): \(log.calls) vs \(expected)")
                assert(outcome.accepted == row["accepted"] as! Bool && outcome.ok == row["ok"] as! Bool, "team acceptance differs for \(planValue)")
            }
            wait.signal()
        }
        wait.wait()

        let compactSync = contract["compactSync"] as! [String: Any]
        let conversation = try! SyncValue.from(compactSync["conversation"] as! [String: Any])
        try! SyncWireContract.validate(conversation, definition: "conversation")
        let compactMessages = (compactSync["messages"] as! [[String: Any]]).map { ChatMessage(id: $0["id"] as! String, role: $0["role"] as! String, content: $0["content"] as! String) }
        let compactContext = ConversationHistory.compactContext(conversation["compact"], messages: compactMessages)
        assert(compactContext.messages.map(\.id) == compactSync["expectedInputIds"] as! [String], "compact boundary differs: \(compactContext.messages.map(\.id))")
        assert(compactContext.summary.contains(compactSync["summaryContains"] as! String), "compact summary missing")
        assert(ConversationHistory.recentTurns(compactMessages, afterMessageId: "m4").map(\.id) == compactSync["expectedInputIds"] as! [String])
        assert(ConversationHistory.recentTurns(compactMessages, afterMessageId: "missing") == ConversationHistory.recentTurns(compactMessages), "an unknown boundary keeps the full history")

        let loopCases = agentLoopContract()
        let elevation = capabilityElevationContract()
        print("Shared contract passed: \(prose.count) prose URL cases, \(identities.count) source identities, tool-call replay, \(handoffs.count) handoffs, \(plans.count) team plans, \(schedules.count) team schedules, compact sync, \(loopCases) agent-loop fixtures, \(elevation.cases) capability-elevation fixtures (\(elevation.skipped.count) skipped\(elevation.skipped.isEmpty ? "" : ": " + elevation.skipped.joined(separator: "; ")))")
    }

    /// Fixture adapter for capability elevation: desktop tool id (+ args, + the
    /// tool's declared capability) → requirement. A port of
    /// src/domain/agent/capabilities.js `toolCapabilityAllowed`, used only to
    /// feed the desktop fixtures to the phone decision core; the phone runtime
    /// classifies its own tools with `CapabilityRequirement.phoneTool`.
    static func desktopRequirement(_ id: String, args: OrderedJSON?, tool: OrderedJSON?) -> CapabilityRequirement {
        let desktopKeys = CapabilityElevation.contract.booleanKeys
        let args = args.flatMap { $0 == .null ? nil : $0 }
        func action() -> String? { args?["action"]?.stringValue }
        if id.hasPrefix("mcp:") {
            let rest = id.dropFirst(4)
            guard let separator = rest.firstIndex(of: ":"), separator != rest.startIndex else { return .unclassified }
            let server = String(rest[..<separator])
            guard !rest[rest.index(after: separator)...].isEmpty, server.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return .unclassified }
            return .atom("mcpServers:" + server)
        }
        if id.hasPrefix("skill:") { let skill = String(id.dropFirst(6)); return skill.isEmpty ? .unclassified : .atom("skills:" + skill) }
        if let tool, tool["id"]?.stringValue == id, let declared = tool["capability"] {
            switch declared {
            case .null: return .ungated
            case .string(let key): return desktopKeys.contains(key) ? .atom(key) : .unclassified
            case .array(let values):
                let keys = values.compactMap(\.stringValue)
                return keys.count == values.count && keys.allSatisfy(desktopKeys.contains) ? .all(keys) : .unclassified
            case .object:
                let keys = declared["anyOf"]?.items.compactMap(\.stringValue).filter(desktopKeys.contains) ?? []
                return CapabilityRequirement(allows: { set in keys.contains(where: set.contains) })
            default: return .unclassified
            }
        }
        func when(_ test: @escaping (Set<String>) -> Bool) -> CapabilityRequirement { CapabilityRequirement(allows: test) }
        if ["file_read", "glob", "grep", "media_info"].contains(id) { return .atom("readFiles") }
        if ["file_write", "file_edit", "file_delete", "file_move", "file_mkdir", "xlsx"].contains(id) { return .atom("writeFiles") }
        if ["web_search", "fetch_url", "web_screenshot", "media_api", "translate", "browser_open", "browser_snapshot", "browser_click", "browser_fill", "browser_wait_for", "browser_close"].contains(id) { return .atom("network") }
        if id == "bash" { return .atom("runCommands") }
        if id == "agent" || id == "delegate" { return .atom("delegate") }
        if id == "calculator" { return .ungated }
        if ["search_history", "read_history", "reminder"].contains(id) { return .atom("knowledgeMemory") }
        if id == "knowledge" { return when { $0.contains("knowledgeMemory") && (args == nil || action() != "index" || $0.contains("readFiles")) } }
        if id == "clipboard" { return when { c in args == nil ? c.contains("readFiles") || c.contains("writeFiles") : c.contains(action() == "read" ? "readFiles" : "writeFiles") } }
        if id == "pdf" {
            guard let args else { return when { $0.contains("readFiles") || $0.contains("writeFiles") } }
            let read = action() == "read"
            let remote: Bool = { if case .object(let fields) = args { return fields.contains { $0.1.stringValue?.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil } }; return false }()
            let known = read || ["write", "structured", "from_spec"].contains(action() ?? "")
            return when { c in c.contains(read ? "readFiles" : "writeFiles") && (!remote || c.contains("network")) && (known || c.contains("readFiles")) }
        }
        if id == "image" {
            guard args != nil else { return when { $0.contains("readFiles") || $0.contains("generateMedia") } }
            if ["info", "ocr"].contains(action() ?? "") { return .atom("readFiles") }
            let output: Bool = {
                switch args?["output"] {
                case nil, .null?: return false
                case .string(let value)?: return !value.isEmpty
                case .bool(let value)?: return value
                case .number(let value)?: return value != 0 && !value.isNaN
                default: return true
                }
            }()
            let process = action() == "process"
            return when { c in c.contains("generateMedia") && (!output || c.contains("writeFiles")) && (!process || c.contains("readFiles") && c.contains("writeFiles")) }
        }
        return .unclassified // New/plugin tool identifiers need an explicit mapping (desktop parity).
    }

    /// Capability elevation (2026-10-20): `fixtures.capabilityElevation`, the
    /// same cases src/domain/agent/capabilityElevation.test.js runs.
    static func capabilityElevationContract() -> (cases: Int, skipped: [String]) {
        let text = try! String(contentsOfFile: "shared/protocol/agent-loop.json", encoding: .utf8)
        let F = OrderedJSON.parse(text)!["fixtures"]!["capabilityElevation"]!
        let c = CapabilityElevation.contract
        // Fixtures the phone cannot evaluate, by name, with the reason. Empty:
        // every desktop tool id the fixtures use has a requirement above, and the
        // atoms are the contract's own. A new fixture whose decision the phone
        // core gets wrong fails here instead of being skipped silently.
        let phoneSkips: [String: String] = [:]
        var count = 0, skipped: [String] = []
        func atoms(_ value: OrderedJSON?) -> Set<String>? {
            guard let value, value != .null else { return nil }
            return Set(value.items.compactMap(\.stringValue))
        }
        func strings(_ value: OrderedJSON?) -> [String] { value?.items.compactMap(\.stringValue) ?? [] }
        func optional(_ value: OrderedJSON?) -> String? { value?.stringValue }
        assert(c.decisions == ["allowed", "elevate-beyond-parent", "enable-own", "deny-no-surface", "deny-ceiling"] && c.booleanKeys.count == 7 && c.listKeys == ["mcpServers", "skills", "connectors"])
        assert(c.allBooleans == c.booleanKeys + ["calendar", "reminders", "contacts", "location"], "phone booleans follow the contract booleans")
        // The phone table covers exactly the phone's function tools and permissions.
        let phoneTools = Set(DeviceToolSpec.all.map(\.name) + WebPageToolSpec.all.map(\.name) + [PhoneReadHistory.name])
        assert(Set(c.phoneTools.keys) == phoneTools, "capabilityElevation.phone.toolCapabilities must list every phone tool: \(phoneTools.symmetricDifference(c.phoneTools.keys))")
        assert(Set(c.phonePermissionAtoms) == Set(PhoneCapability.allCases.map(\.rawValue)), "phone permission atoms are the PhoneCapability cases")
        for row in F["decisions"]!.items {
            let name = row["name"]!.stringValue!
            if let reason = phoneSkips[name] { skipped.append("\(name) (\(reason))"); continue }
            let input = row["input"]!, expected = row["expected"]!
            let m = input["member"]!
            let member = CapabilityParty(agentId: m["agentId"]!.stringValue!, capabilities: atoms(m["capabilities"]), scope: optional(m["scope"]), globalCapabilities: atoms(m["globalCapabilities"]))
            let parent: CapabilityParty? = input["parent"].flatMap { $0 == .null ? nil : CapabilityParty(agentId: $0["agentId"]!.stringValue!, capabilities: atoms($0["capabilities"])) }
            let grants = try! JSONDecoder().decode([CapabilityGrant].self, from: Data((input["grants"] ?? .array([])).json.utf8))
            let x = input["context"]!
            let context = CapabilityContext(surface: x["surface"]?.boolValue == true, runId: optional(x["runId"]), projectId: optional(x["projectId"]), chatId: optional(x["chatId"]),
                                            allowedToolIds: x["allowedToolIds"].flatMap { $0 == .null ? nil : strings($0) })
            let toolId = input["toolId"]!.stringValue!
            let d = CapabilityElevation.decide(toolId: toolId, requirement: desktopRequirement(toolId, args: input["args"], tool: input["tool"]), member: member, parent: parent,
                                               base: atoms(input["base"]), grants: grants, context: context, now: input["now"]!.numberValue!)
            let label = "capability fixture «\(name)»"
            assert(d.decision == expected["decision"]!.stringValue!, "\(label): decision \(d.decision)")
            assert(d.missing == strings(expected["missing"]), "\(label): missing \(d.missing)")
            if expected["effective"] == .null { assert(d.effective == nil, "\(label): effective must be null") }
            else { assert(d.effective.map { CapabilityElevation.sort($0) } == strings(expected["effective"]), "\(label): effective \(CapabilityElevation.sort(d.effective ?? []))") }
            assert(d.grantIds == strings(expected["grantIds"]), "\(label): grantIds \(d.grantIds)")
            if let reason = expected["reason"] { assert(d.reason == reason.stringValue, "\(label): reason \(String(describing: d.reason))") }
            assert(d.options == expected["options"].map { strings($0) }, "\(label): options \(String(describing: d.options))")
            assert(d.projectOptionScope == optional(expected["projectOptionScope"]), "\(label): projectOptionScope")
            assert(d.wouldPrompt == optional(expected["wouldPrompt"]), "\(label): wouldPrompt")
            assert(d.alwaysUnavailable == (expected["alwaysUnavailable"]?.boolValue == true), "\(label): alwaysUnavailable")
            count += 1
        }
        for row in F["prompts"]!.items {
            let actual = CapabilityElevation.promptText(decision: row["decision"]!.stringValue!, agent: row["agent"]!.stringValue!, parent: optional(row["parent"]), atoms: strings(row["atoms"]))
            assert(actual == row["expected"]!.stringValue!, "capability prompt differs: \(actual)"); count += 1
        }
        for row in F["expiries"]!.items {
            assert(CapabilityElevation.grantExpiry(row["scope"]!.stringValue!, now: row["now"]!.numberValue!) == row["expected"]!.numberValue!, "grant expiry differs for \(row["scope"]!.stringValue!)"); count += 1
        }
        assert(CapabilityElevation.grantExpiry("forever", now: 0) == nil)
        return (count, skipped)
    }
    /// Agent-loop half (2026-10-19): shared/protocol/agent-loop.json fixtures, the
    /// same ones src/runtime/agentLoopContract.test.js runs against the desktop.
    static func agentLoopContract() -> Int {
        let text = try! String(contentsOfFile: "shared/protocol/agent-loop.json", encoding: .utf8)
        let file = OrderedJSON.parse(text)!
        let F = file["fixtures"]!
        let c = AgentLoopContract.shared
        var count = 0
        func same(_ a: Any, _ b: Any) -> Bool { NSArray(array: [a]).isEqual(to: [b]) }
        // The embedded copy is the checked-in file without its fixtures.
        var embedded = file.foundation as! [String: Any]; embedded["fixtures"] = nil
        assert(NSDictionary(dictionary: embedded).isEqual(to: c.raw), "AgentLoopContract.swift is stale; run npm run generate:agent-loop-contract")
        assert(c.maxIterations == 40 && c.maxCallsPerResponse == 32 && c.repeatLimit == 2 && c.deadlineMs == 1_800_000 && c.maxInputTokens == 400_000 && c.maxToolCalls == 200)

        for row in F["toolTrace"]!.items {
            let entries = row["records"]!.items.map { record in
                PhoneToolTrace.Entry(toolId: record["toolId"]!.stringValue!, digest: PhoneToolArgs.digest(record["argsRedacted"]!), status: record["resultEnvelope"]!["status"]!.stringValue!, code: record["resultEnvelope"]!["code"]?.stringValue)
            }
            let actual = PhoneToolTrace.text(entries, status: row["status"]!.stringValue!, maxChars: row["maxChars"]?.numberValue.map { Int($0) })
            assert(actual == row["expected"]!.stringValue!, "tool trace differs:\n\(actual)\n\(row["expected"]!.stringValue!)"); count += 1
        }
        let guardian = PhoneRepeatGuard()
        for step in F["repeatGuard"]!.items {
            let name = step["name"]!.stringValue!, args = step["args"]!
            let rejected = guardian.check(name, args)
            let expected = step["expected"]!
            assert((rejected != nil) == expected["rejected"]!.boolValue!, "repeat guard decision differs for \(name) \(args.json)")
            if let rejected {
                assert(rejected.code == expected["code"]!.stringValue! && rejected.output == expected["output"]!.stringValue!, "repeat guard output differs: \(rejected.output)")
            } else if let result = step["result"] {
                guardian.record(name, args, PhoneToolEnvelope.finalize(ok: result["ok"]!.boolValue!, code: result["code"]?.stringValue, output: "", phone: false))
            }
            count += 1
        }
        for row in F["envelope"]!.items {
            let input = row["input"]!
            let outcome = PhoneToolEnvelope.finalize(ok: input["ok"]?.boolValue == true, status: input["status"]?.stringValue, code: input["code"]?.stringValue, error: input["error"]?.stringValue, output: input["output"]?.stringValue ?? "", phone: false)
            let actual = try! JSONSerialization.jsonObject(with: Data(PhoneToolEnvelope.modelFacing(outcome, phone: false).utf8))
            assert(same(actual, row["expected"]!.foundation), "envelope differs for \(input.json.prefix(80)): \(PhoneToolEnvelope.modelFacing(outcome, phone: false).prefix(300))"); count += 1
        }
        for row in F["budget"]!.items {
            let start = row["startedAt"]!.numberValue!, overrides = row["overrides"]!, used = row["used"]!
            let budget = PhoneRunBudget(deadlineMs: overrides["deadlineMs"]?.numberValue, maxToolCalls: overrides["maxToolCalls"]?.numberValue.map { Int($0) }, now: { start })
            budget.record(inputTokens: Int(used["inputTokens"]?.numberValue ?? 0), toolCalls: Int(used["toolCalls"]?.numberValue ?? 0), providerCalls: Int(used["providerCalls"]?.numberValue ?? 0))
            let exhausted = budget.exhausted(at: row["now"]!.numberValue!)
            let expected = row["expected"]!
            if expected == .null { assert(exhausted == nil, "budget should not be exhausted") }
            else {
                assert(exhausted?.reason == expected["reason"]!.stringValue! && exhausted?.limit == expected["limit"]!.numberValue! && exhausted?.used == expected["used"]!.numberValue!, "budget exhaustion differs")
                assert(PhoneRunBudget.describe(exhausted!) == expected["describe"]!.stringValue! && PhoneRunBudget.reply(exhausted!, locale: row["locale"]?.stringValue) == expected["reply"]!.stringValue!, "budget text differs: \(PhoneRunBudget.reply(exhausted!))")
            }
            count += 1
        }
        for row in F["budgetReplies"]!.items {
            let value = row["exhausted"]!, locale = row["locale"]!.stringValue!
            let exhausted = PhoneRunBudget.Exhaustion(reason: value["reason"]!.stringValue!, limit: value["limit"]!.numberValue!, used: value["used"]!.numberValue!, usage: .init())
            assert(PhoneRunBudget.describe(exhausted, locale: locale) == row["description"]!.stringValue!)
            assert(PhoneRunBudget.reply(exhausted, locale: locale) == row["reply"]!.stringValue!)
            count += 1
        }
        do {
            let fixture = F["narrowBudget"]!, expected = fixture["expected"]!
            let parent = PhoneRunBudget(maxToolCalls: Int(fixture["parent"]!["overrides"]!["maxToolCalls"]!.numberValue!), now: { 0 })
            parent.record(inputTokens: Int(fixture["parent"]!["used"]!["inputTokens"]!.numberValue!), toolCalls: Int(fixture["parent"]!["used"]!["toolCalls"]!.numberValue!))
            let child = parent.narrowed(deadlineMs: fixture["child"]!["deadlineMs"]!.numberValue!)
            child.record(toolCalls: Int(fixture["childUsed"]!["toolCalls"]!.numberValue!))
            assert(child.deadlineAt == expected["childDeadlineAt"]!.numberValue! && Double(child.maxToolCalls) == expected["childMaxToolCalls"]!.numberValue! && Double(child.maxInputTokens) == expected["childMaxInputTokens"]!.numberValue!, "narrowed limits differ")
            assert(Double(parent.used.toolCalls) == expected["parentToolCalls"]!.numberValue! && child.exhausted(at: 0)?.reason == expected["childExhausted"]!.stringValue && parent.exhausted(at: 0)?.reason == expected["parentExhausted"]!.stringValue, "narrowed usage differs")
            count += 1
        }
        for row in F["supplement"]!.items { assert(c.supplementMessage(row["entries"]!.items.map { $0.stringValue! }) == row["expected"]!.stringValue!); count += 1 }
        for row in F["toolLimitReply"]!.items { assert(c.toolLimitReply(for: row["question"]!.stringValue!) == row["expected"]!.stringValue!); count += 1 }
        for row in F["uncertainty"]!.items {
            let parsed = PhoneUncertainty.parse(row["text"]!.stringValue!), expected = row["expected"]!
            assert(parsed.hasMarker == expected["hasMarker"]!.boolValue! && parsed.uncertainClaim == expected["uncertainClaim"]!.stringValue! && parsed.cleanReply == expected["cleanReply"]!.stringValue! && parsed.source == expected["source"]!.stringValue!, "marker parse differs for \(row["text"]!.stringValue!): \(parsed)")
            count += 1
        }
        for row in F["applyVerification"]!.items {
            let v = row["verification"]!
            let verification = PhoneUncertainty.Verification(verdict: v["verdict"]!.stringValue!, correction: v["correction"]?.stringValue ?? "", originalClaim: v["originalClaim"]?.stringValue ?? "")
            assert(PhoneUncertainty.apply(row["reply"]!.stringValue!, verification) == row["expected"]!.stringValue!); count += 1
        }
        func evidence(_ value: OrderedJSON) -> PhoneUncertainty.Evidence {
            PhoneUncertainty.Evidence(id: value["id"]!.stringValue!, tool: value["tool"]?.stringValue, ok: value["ok"]!.boolValue!, source: value["source"]?.stringValue, fetchedAt: value["fetchedAt"]?.stringValue, coverage: value["coverage"]?.stringValue ?? "unknown", truncated: value["truncated"]?.boolValue, text: value["text"]!.stringValue!)
        }
        for row in F["verificationSupport"]!.items {
            let payload = row["payload"]!
            assert(PhoneUncertainty.supported(evidenceId: payload["evidenceId"]?.stringValue, quote: payload["evidenceQuote"]?.stringValue, evidence: row["evidence"]!.items.map(evidence)) == row["expected"]!.boolValue!); count += 1
        }
        do {
            let fixture = F["verificationEvidence"]!
            let pairs = fixture["pairs"]!.items.map { pair in
                PhoneUncertainty.ToolPair(callID: pair["call"]!["id"]!.stringValue!, name: pair["call"]!["name"]!.stringValue!, args: pair["call"]!["arguments"]!, ok: pair["result"]!["ok"]!.boolValue!, output: pair["result"]!["output"]!.stringValue!, receivedAt: pair["receivedAt"]!.stringValue!)
            }
            let built = PhoneUncertainty.build(contextBlocks: fixture["contextBlocks"]!.items.map { $0.stringValue! }, toolEvidence: PhoneUncertainty.collect(pairs, query: fixture["query"]!.stringValue!))
            let actual = try! JSONSerialization.jsonObject(with: Data(("[" + built.map(\.json).joined(separator: ",") + "]").utf8))
            assert(same(actual, fixture["expected"]!.foundation), "verification evidence differs"); count += 1
        }
        for row in F["intentRules"]!.items {
            let expected = row["expected"]!.stringValue
            assert(PhoneIntent.rules(row["text"]!.stringValue!) == expected, "intent rule differs for \(row["text"]!.stringValue!): \(String(describing: PhoneIntent.rules(row["text"]!.stringValue!)))"); count += 1
        }
        for row in F["intentContext"]!.items {
            let text = row["text"]!.stringValue!, previous = row["previous"]!.stringValue!
            let history = previous.isEmpty ? [ChatMessage(role: "user", content: text)] : [ChatMessage(role: "user", content: previous), ChatMessage(role: "assistant", content: "x"), ChatMessage(role: "user", content: text)]
            let result = PhoneIntent.classify(text, history: history), expected = row["expected"]!
            assert(result.taskType == expected["taskType"]!.stringValue && result.riskLevel == expected["riskLevel"]!.stringValue! && result.requiresVerification == expected["requiresVerification"]!.boolValue!, "contextual intent differs for \(text): \(result)")
            count += 1
        }
        for row in F["riskLevel"]!.items { assert(PhoneIntent.risk(row["text"]!.stringValue!) == row["expected"]!.stringValue!); count += 1 }
        for row in F["requiresVerification"]!.items {
            let intent = row["intent"]!
            assert(PhoneIntent.requiresVerification(taskType: intent["taskType"]!.stringValue!, riskLevel: intent["riskLevel"]!.stringValue!) == row["expected"]!.boolValue!); count += 1
        }
        for row in F["redaction"]!.items {
            let actual = PhoneToolArgs.redactSecrets(row["text"]!.stringValue!)
            assert(actual == row["expected"]!.stringValue!, "redaction differs:\n\(actual)\n\(row["expected"]!.stringValue!)"); count += 1
        }
        for row in F["args"]!.items {
            let args = OrderedJSON.parse(row["json"]!.stringValue!)!, expected = row["expected"]!
            let redacted = PhoneToolArgs.redact(args)
            assert(PhoneToolArgs.hash(args) == expected["hash"]!.stringValue!, "args hash differs for \(row["json"]!.stringValue!): \(args.canonicalJSON)")
            assert(same(redacted.foundation, expected["redacted"]!.foundation), "redacted args differ for \(row["json"]!.stringValue!)")
            assert(PhoneToolArgs.digest(redacted) == expected["digest"]!.stringValue!, "args digest differs: \(PhoneToolArgs.digest(redacted))")
            count += 1
        }
        let messages = (0..<Int(F["readHistoryMessages"]!.numberValue!)).map { ChatMessage(id: "m\($0)", role: $0 % 2 == 1 ? "assistant" : "user", content: "message \($0)") }
        for row in F["readHistorySlice"]!.items {
            let a = row["args"]!, expected = row["expected"]!
            let slice = PhoneReadHistory.slice(messages, fromMessageId: a["fromMessageId"]?.stringValue, toMessageId: a["toMessageId"]?.stringValue, aroundMessageId: a["aroundMessageId"]?.stringValue, before: a["before"]?.numberValue ?? 0, after: a["after"]?.numberValue ?? 0, limit: a["limit"]?.numberValue)
            assert(slice.messages.map(\.id) == expected["ids"]!.items.map { $0.stringValue! } && slice.hasMore == expected["hasMore"]!.boolValue! && slice.nextMessageId == expected["nextMessageId"]!.stringValue! && slice.missing == expected["missing"]!.stringValue!, "read_history slice differs for \(a.json)")
            count += 1
        }
        for row in F["tokens"]!.items { assert(Double(PhoneTokenEstimate.text(row["text"]!.stringValue!)) == row["expected"]!.numberValue!, "token estimate differs for \(row["text"]!.stringValue!)"); count += 1 }
        return count
    }
}
