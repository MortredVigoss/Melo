import Foundation

// Phone team rules beyond the shared contract: who may lead, the time budget
// actually stops a running member, cancellation starts nobody, and the reply
// never shows raw JSON. Counters prove which member calls happened.
func agent(_ id: String, canDelegate: Bool? = nil, targets: [String] = []) -> AgentProfile {
    var profile = AgentProfile(id: id, name: id.capitalized, subtitle: "", symbol: "sparkles", instructions: "")
    if let canDelegate { profile.collaboration = .object(["canDelegate": .bool(canDelegate), "delegateTargets": .array(targets.map { .string($0) })]) }
    return profile
}
final class Counter: @unchecked Sendable { var calls: [String] = []; let lock = NSLock(); func add(_ v: String) { lock.lock(); calls.append(v); lock.unlock() } }

@main struct AgentTeamTests {
    static func main() async {
        // Lead rules follow the synced collaboration settings.
        let agents = [agent("main"), agent("research"), agent("reviewer")]
        assert(AgentTeam.leadState(agent("melo"), agents: agents) == .delegateOff, "a phone-only Agent without collaboration settings cannot lead")
        assert(AgentTeam.leadState(agent("main", canDelegate: false, targets: ["research"]), agents: agents) == .delegateOff)
        assert(AgentTeam.leadState(agent("main", canDelegate: true, targets: ["gone", "main"]), agents: agents) == .noTargets, "unknown targets and the lead itself are not members")
        let lead = agent("main", canDelegate: true, targets: ["reviewer", "research"])
        assert(AgentTeam.leadState(lead, agents: agents) == .ready(["reviewer", "research"]))
        let plan = try! AgentTeam.validate(templateID: "research-build-review", members: ["research", "reviewer"])
        do { try AgentTeam.authorize(plan, lead: lead, agents: agents) } catch { assertionFailure("chosen members are allowed") }
        let outsider = try! AgentTeam.validate(templateID: "research-build-review", members: ["research", "writer"])
        do { try AgentTeam.authorize(outsider, lead: lead, agents: agents + [agent("writer")]); assertionFailure("unchosen member must be refused") }
        catch { assert(error.localizedDescription.contains("writer")) }

        // Members receive prior handoffs in the desktop's hint format.
        let hints = TeamCall(kind: .member, memberID: "b", round: 1, prior: [AgentTeam.handoff(task: "t", output: #"{"conclusion":"found"}"#, ok: true)]).hints
        assert(hints.hasPrefix("前序交接记录（需要独立核对）：\n[") && hints.contains("found"))
        assert(TeamCall(kind: .member, memberID: "a", round: 1, prior: []).hints.isEmpty)

        // The time budget stops a running member and starts no later one.
        let slow = Counter()
        let timed = await AgentTeam.run(plan, task: "t", deadline: Date().addingTimeInterval(0.2)) { call in
            slow.add(call.memberID)
            try await Task.sleep(nanoseconds: 5_000_000_000)
            return "late"
        }
        assert(slow.calls == ["research"], "only the first member started: \(slow.calls)")
        assert(timed.timedOut && !timed.ok && timed.results.map(\.handoff.status) == ["budget-exceeded", "budget-exceeded"])
        assert(AgentTeam.digest(timed, name: { $0 }).hasPrefix("团队用完了总预算"))

        // Summary shares the original deadline, cancels its provider, and does not
        // invoke a provider after expiry. A second request gets no fresh budget.
        let summaryCalls = Counter()
        let shortDeadline = Date().addingTimeInterval(0.12)
        let summary = try! await AgentTeam.summarize(deadline: shortDeadline) {
            summaryCalls.add("start")
            do { try await Task.sleep(nanoseconds: 5_000_000_000) }
            catch { summaryCalls.add("cancelled"); throw error }
            return "late"
        }
        assert(summary.timedOut && summary.text == nil)
        assert(summaryCalls.calls == ["start", "cancelled"])
        let expired = try! await AgentTeam.summarize(deadline: shortDeadline) { summaryCalls.add("unexpected"); return "x" }
        assert(expired.timedOut && summaryCalls.calls.count == 2)
        let good = try! await AgentTeam.summarize(deadline: Date().addingTimeInterval(2)) { "finished" }
        assert(good.text == "finished" && !good.timedOut)
        let stoppedSummary = Task { try await AgentTeam.summarize(deadline: Date().addingTimeInterval(2)) { summaryCalls.add("unexpected"); return "x" } }
        stoppedSummary.cancel()
        do { _ = try await stoppedSummary.value; assertionFailure("cancel must propagate") } catch { assert(error is CancellationError) }
        assert(summaryCalls.calls.count == 2)

        // Cancellation before start calls no member.
        let none = Counter()
        let cancelled = Task { await AgentTeam.run(plan, task: "t") { call in none.add(call.memberID); return "x" } }
        cancelled.cancel()
        let stopped = await cancelled.value
        assert(none.calls.isEmpty && stopped.cancelled && !stopped.ok && stopped.results.allSatisfy { $0.handoff.status == "cancelled" })

        // A failing member is reported, not hidden; the digest never shows raw JSON.
        let mixed = await AgentTeam.run(plan, task: "t") { call in
            if call.memberID == "reviewer" { throw URLError(.timedOut) }
            return #"{"conclusion":"三处来源","changedFiles":["a.md"],"unfinished":[]}"#
        }
        assert(!mixed.ok && mixed.results[0].ok && !mixed.results[1].ok)
        let digest = AgentTeam.digest(mixed, name: { $0 == "research" ? "调研员" : "复核员" })
        assert(digest.hasPrefix("团队未全部完成。") && digest.contains("**调研员** · 已完成") && digest.contains("三处来源") && digest.contains("a.md") && digest.contains("**复核员** · 未完成"))
        assert(!digest.contains("{") && !digest.contains("}"))
        assert(AgentTeam.summaryInput(task: "整理", outcome: mixed, name: { $0 }).contains("三处来源"))
        assert(AgentTeam.usableSummary("团队已经完成") && !AgentTeam.usableSummary(#" {"a":1}"#) && !AgentTeam.usableSummary("  "))

        // Parallel researchers overlap at most two at a time; the reviewer runs last and alone.
        final class Peak: @unchecked Sendable { var running = 0, peak = 0, order: [String] = []; let lock = NSLock() }
        let peak = Peak()
        let wide = try! AgentTeam.validate(templateID: "parallel-research", members: ["a", "b", "c", "r"])
        _ = await AgentTeam.run(wide, task: "t") { call in
            peak.lock.lock(); peak.running += 1; peak.peak = max(peak.peak, peak.running); peak.order.append(call.memberID); peak.lock.unlock()
            try await Task.sleep(nanoseconds: 30_000_000)
            peak.lock.lock(); peak.running -= 1; peak.lock.unlock()
            return #"{"conclusion":"ok"}"#
        }
        assert(peak.peak == 2 && peak.order.last == "r" && peak.order.count == 4, "parallel bound or order wrong: \(peak.peak) \(peak.order)")
        print("Agent team tests passed: lead rules, hints, time budget, cancellation, failure digest, parallel bound")
    }
}
