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

        print("Shared contract passed: \(prose.count) prose URL cases, \(identities.count) source identities, tool-call replay")
    }
}
