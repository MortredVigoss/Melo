import Foundation

// From codex/reply-latency-20261109 (merged 2026-11-14), for the parts of it that master took: the draft
// of an answer while it is written, a sent-back answer that comes in again unchanged, the pages a reply
// keeps for their later parts, and the time a reply ran and waited. The branch's cases for two members
// at once and for a page read over plain HTTP are not here: neither was taken (see
// docs/reply-latency-implementation-20261109.md).

let openURL = WebPageToolSpec.all[0].definition
func verdict(_ decision: String, evidence: [String] = [], next: String = "") -> String {
    let requirement: [String: Any] = ["text": "requested result", "kind": "external_fact", "status": decision == "complete" ? "met" : "missing", "evidenceIds": evidence]
    let object: [String: Any] = ["decision": decision, "reasonType": decision == "complete" ? "fulfilled" : "lookup_missing", "nextStep": next, "requirements": [requirement]]
    return String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
}
func read(_ id: String, _ url: String) -> ResponsesFunctionCall { ResponsesFunctionCall(callID: id, name: "open_url", arguments: "{\"url\":\"\(url)\"}") }

final class ReadTransport: AgentModelTransport, @unchecked Sendable {
    let offersTools = true; let timeoutCap: TimeInterval = 10
    var requests = 0
    func round(_ request: AgentLoopRequest) async throws -> AgentRound {
        requests += 1
        if request.goalReview != nil { return AgentRound(text: verdict("complete", evidence: ["a", "b"])) }
        if requests == 1 { return AgentRound(calls: [read("a", "https://a.example"), read("b", "https://b.example")]) }
        return AgentRound(text: "The first page says A, the second says B.")
    }
    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String { "" }
}
/// Reads one page, then offers an answer that its check sends back: the same answer every time, or a
/// reworded one every time.
final class SentBackTransport: AgentModelTransport, @unchecked Sendable {
    let offersTools = true; let timeoutCap: TimeInterval = 10
    let reworded: Bool
    var work = 0, checks = 0
    init(reworded: Bool) { self.reworded = reworded }
    func round(_ request: AgentLoopRequest) async throws -> AgentRound {
        if request.goalReview != nil { checks += 1; return AgentRound(text: verdict("continue", next: "Read the second page")) }
        work += 1
        if work == 1 { return AgentRound(calls: [read("a", "https://a.example")]) }
        return AgentRound(text: reworded ? "The page says A (wording \(work))." : "The page says A.")
    }
    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String { "" }
}
/// Writes its answer in two pieces through the request's draft callback, as a streaming transport does.
final class DraftTransport: AgentModelTransport, @unchecked Sendable {
    let offersTools = true; let timeoutCap: TimeInterval = 10
    var work = 0, checkHadDraft = false, leadHadDraft = [Bool]()
    func round(_ request: AgentLoopRequest) async throws -> AgentRound {
        if request.goalReview != nil { checkHadDraft = checkHadDraft || request.onDraft != nil; return AgentRound(text: verdict("complete", evidence: ["a"])) }
        work += 1; leadHadDraft.append(request.onDraft != nil)
        if work == 1 {
            await request.onDraft?("Let me look.")
            await request.onDraft?("")
            return AgentRound(text: "Let me look.", calls: [read("a", "https://a.example")])
        }
        await request.onDraft?("The page")
        await request.onDraft?("The page says A. [UNCERTAIN: the page is cur")
        return AgentRound(text: "The page says A. [UNCERTAIN: the page is current]")
    }
    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String { "" }
}
final class RefusedRouteTransport: AgentModelTransport, @unchecked Sendable {
    let offersTools = true; let timeoutCap: TimeInterval = 10
    var requests = 0
    func round(_ request: AgentLoopRequest) async throws -> AgentRound {
        requests += 1
        if requests > 8 { return AgentRound(text: "Unable to read source.") }
        return AgentRound(calls: [1, 2].map { ResponsesFunctionCall(callID: "invalid-\(requests)-\($0)", name: "route_task", arguments: #"{"role":"unknown","task":"Read source"}"#) })
    }
    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String { "" }
}

@main struct ReplyLatencyTests {
    @MainActor static func main() async throws {
        // Two page reads asked for in one response run side by side (master, 2026-11-10) and both are recorded.
        var active = 0, peak = 0, performed = [String](), records = [ExecutionToolCall]()
        let tools = AgentLoopTools(definitions: [openURL], instructions: "read", perform: { call in
            active += 1; peak = max(peak, active); defer { active -= 1 }; performed.append(call.callID)
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return PhoneToolResult(output: PhoneToolEnvelope.success("cancelled")) }
            return PhoneToolResult(output: PhoneToolEnvelope.success("Page " + call.callID + ": verified body"))
        })
        let reply = try await AgentLoop(transport: ReadTransport(), tools: tools, budget: PhoneRunBudget(), latestUserMessage: "Read both pages", hooks: AgentLoopHooks(onToolCall: { records.append($0) })).run()
        assert(peak == 2 && performed.sorted() == ["a", "b"] && records.count == 2)
        assert(reply.completion?.outcome == "completed" && active == 0)

        // An answer that its check sent back and that comes in again unchanged gets the same verdict
        // without a check request; it still counts against the correction allowance, and the turn ends
        // at the allowance's limit. An answer whose wording changed is checked every time.
        let quick = AgentLoopTools(definitions: [openURL], instructions: "read", perform: { call in PhoneToolResult(output: PhoneToolEnvelope.success("Page " + call.callID + " says A.")) })
        for reworded in [false, true] {
            let transport = SentBackTransport(reworded: reworded)
            var checkStages = [(String, String)](), reviews = 0
            var hooks = AgentLoopHooks()
            hooks.onStageEvent = { event in if event.id.hasPrefix("goal-check:") { checkStages.append((event.id, event.status)); if event.goalReview != nil { reviews += 1 } } }
            let outcome = try await AgentLoop(transport: transport, tools: quick, budget: PhoneRunBudget(), latestUserMessage: "Read the two pages and report", hooks: hooks).run()
            assert(transport.work == 4, "one read and three answers either way: the allowance is the same (\(transport.work))")
            assert(transport.checks == (reworded ? 3 : 1), "check requests: \(transport.checks)")
            assert(outcome.completion?.outcome == "partial", "outcome: \(outcome.completion?.outcome ?? "nil")")
            assert(outcome.text == (reworded ? "The page says A (wording 4)." : "The page says A."))
            assert(checkStages.count == 3 && checkStages.allSatisfy { $0.1 == "failed" } && Set(checkStages.map(\.0)).count == 3 && reviews == 3, "every verdict is shown, the reused ones too: \(checkStages)")
        }

        // The draft: only the lead's own answer, never a check; empty when a new request starts and
        // when the response turns out to be tool calls; the note for the check is not shown.
        let drafting = DraftTransport()
        var drafts = [(String, Bool)]()
        var draftHooks = AgentLoopHooks()
        draftHooks.onDraft = { text, whole in drafts.append((text, whole)) }
        let drafted = try await AgentLoop(transport: drafting, tools: quick, budget: PhoneRunBudget(), latestUserMessage: "Read the page and report", hooks: draftHooks).run()
        assert(drafting.leadHadDraft == [true, true] && !drafting.checkHadDraft)
        let shown = drafts.map { $0.0 + ($0.1 ? "|whole" : "|part") }
        assert(shown == ["|whole", "Let me look.|part", "|part", "|whole", "|whole", "The page|part", "The page says A. |part", "The page says A. |whole", "The page says A. |whole"], "\(shown)")
        assert(drafted.text.hasPrefix("The page says A."))
        assert(AgentLoop.draftText("Fact. [UNCERTAIN: claim]") == "Fact. " && AgentLoop.draftText("Fact. [uncertain: cla") == "Fact. ")
        assert(AgentLoop.draftText("See [UNCERTAIN: x] in the text, then more.") == "See [UNCERTAIN: x] in the text, then more.", "only a note at the end is the check's note")
        assert(AgentLoop.draftText("No note here.") == "No note here." && AgentLoop.draftText("") == "")

        // A response whose assignments are all refused runs nothing, and the turn ends by the ordinary
        // failure count instead of going on for as long as the model repeats it.
        var routed = [String]()
        let routeTools = AgentLoopTools(definitions: [openURL], instructions: "Read source", perform: { call in routed.append(call.callID); return PhoneToolResult(output: PhoneToolEnvelope.success("Source")) })
        var routeHooks = AgentLoopHooks(); routeHooks.internalRouting = true
        let refusedTransport = RefusedRouteTransport()
        let refused = try await AgentLoop(transport: refusedTransport, tools: routeTools, budget: PhoneRunBudget(), latestUserMessage: "Read both sources", hooks: routeHooks).run()
        assert(refusedTransport.requests == 3 && refused.stop == .toolLimit, "requests \(refusedTransport.requests), stop \(refused.stop)")
        assert(routed.isEmpty, "Refused assignments must execute zero member tools")

        // The pages a reply keeps for their later parts: a whole, successful read only, for 30 seconds,
        // and a failed fresh read leaves nothing behind.
        let cache = PhonePageCache(), now = Date()
        let first = cache.store("https://a.example", finalURL: "https://a.example/v1", title: "A", description: "", text: "first complete body", status: 200, complete: true, now: now)!
        assert(cache.get("https://a.example", now: now.addingTimeInterval(29))?.version == first.version)
        assert(cache.get("https://a.example", now: now.addingTimeInterval(31)) == nil)
        assert(cache.get("https://b.example", now: now) == nil && PhonePageCache().get("https://a.example", now: now) == nil)
        assert(cache.store("https://partial.example", finalURL: "", title: "", description: "", text: "unfinished", status: 200, complete: false) == nil)
        assert(cache.store("https://failed.example", finalURL: "", title: "", description: "", text: "Error", status: 503, complete: true) == nil)
        assert(cache.store("https://empty.example", finalURL: "", title: "", description: "", text: "", status: 200, complete: true) == nil)
        let changed = cache.store("https://a.example", finalURL: "https://a.example/v1", title: "A", description: "", text: "updated body", status: 200, complete: true, now: now)!
        assert(changed.version != first.version && cache.get("https://a.example", now: now)?.text == "updated body")
        cache.invalidate("https://a.example")
        assert(cache.store("https://a.example", finalURL: "", title: "", description: "", text: "failed refresh", status: 503, complete: true) == nil)
        assert(cache.get("https://a.example", now: now) == nil, "A failed fresh page-one read cannot leave an older snapshot available as page two")
        let full = PhonePageCache()
        for index in 0..<(PhonePageCache.capacity + 1) { full.store("https://p\(index).example", finalURL: "", title: "", description: "", text: "body \(index)", status: 200, complete: true, now: now.addingTimeInterval(Double(index))) }
        assert(full.get("https://p0.example", now: now.addingTimeInterval(10)) == nil && full.get("https://p\(PhonePageCache.capacity).example", now: now.addingTimeInterval(10)) != nil, "the oldest page makes room")
        // A later part says it was cut from the kept read; the first part of a fresh read does not.
        let keptPart = (try JSONSerialization.jsonObject(with: Data(WebPageText.openResult(url: "https://a.example", finalURL: changed.finalURL, title: changed.title, description: "", text: String(repeating: "字", count: 30_000), page: 2, status: 200, snapshot: changed, reused: true).utf8))) as! [String: Any]
        assert(keptPart["reusedSourceSnapshot"] as? Bool == true && keptPart["contentVersion"] as? String == changed.version && keptPart["fetchedAt"] as? String == changed.fetchedAt && keptPart["page"] as? Int == 2)
        let freshPart = (try JSONSerialization.jsonObject(with: Data(WebPageText.openResult(url: "https://a.example", finalURL: "https://a.example", title: "A", description: "", text: "body", page: 1, status: 200).utf8))) as! [String: Any]
        assert(freshPart["reusedSourceSnapshot"] == nil && freshPart["contentVersion"] == nil)

        // How long a reply ran and how long it waited between a pause and its continuation.
        var clock = ExecutionRecord(chatId: "test", query: "hello", requestedModel: "fixture")
        clock.startedAt = "2026-11-09T10:00:00Z"; clock.finishedAt = "2026-11-09T10:01:00Z"; clock.status = "completed"
        assert(clock.activeMilliseconds() == nil && clock.pausedMilliseconds() == nil, "a record without intervals says nothing about pauses")
        clock.activeIntervals = [ExecutionActivity(startedAt: "2026-11-09T10:00:00Z", finishedAt: "2026-11-09T10:00:10Z"), ExecutionActivity(startedAt: "2026-11-09T10:00:40Z", finishedAt: "2026-11-09T10:01:00Z")]
        assert(clock.elapsedMilliseconds() == 60000 && clock.activeMilliseconds() == 30000 && clock.pausedMilliseconds() == 30000)
        let decoded = try JSONDecoder().decode(ExecutionRecord.self, from: JSONEncoder().encode(clock))
        assert(decoded.pausedMilliseconds() == 30000)
        var live = ExecutionRecord(chatId: "test", query: "hello", requestedModel: "fixture")
        live.beginActivity(newRun: true)
        assert(live.activeIntervals?.count == 1 && live.activeIntervals?.first?.finishedAt == nil)
        live.beginActivity(); assert(live.activeIntervals?.count == 1, "a stretch that is still open is not opened twice")
        live.finish("interrupted"); assert(live.activeIntervals?.first?.finishedAt == live.finishedAt)
        live.status = "running"; live.finishedAt = nil; live.beginActivity(); assert(live.activeIntervals?.count == 2)
        var old = ExecutionRecord(chatId: "test", query: "hello", requestedModel: "fixture")
        old.beginActivity(); assert(old.activeIntervals == nil, "a reply that started before intervals were recorded gets none on continuation")
        print("Reply latency: side-by-side page reads, reused verdicts, drafts, refused assignments, kept pages and run/pause time passed")
    }
}
