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

        print("Shared contract passed: \(prose.count) prose URL cases, \(identities.count) source identities, tool-call replay, \(handoffs.count) handoffs, \(plans.count) team plans, \(schedules.count) team schedules")
    }
}
