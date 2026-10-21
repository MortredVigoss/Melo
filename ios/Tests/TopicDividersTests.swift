import Foundation

/// The shared topic cases (also run by src/shared/conversationTopics.test.js) through the
/// bundled agent core: the phone draws the same dividers as the desktop.
@main struct TopicDividersTests {
    static func main() throws {
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("ios/Tests/Fixtures/conversation-topics.json")
        let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
        for fixture in cases {
            let rows = fixture["messages"] as! [[Any]]
            let messages = rows.enumerated().map { index, row in ChatMessage(id: "m\(index)", role: row[0] as! String, content: row[1] as! String) }
            // Expected dividers follow from the expected topic of each question.
            var expected: [String: String?] = [:], firstOfTopic: [Int: String] = [:], previous: Int?
            for (index, row) in rows.enumerated() where row[0] as! String == "user" {
                let topic = row[2] as! Int
                if let previous, previous != topic { expected["m\(index)"] = firstOfTopic[topic] }
                if firstOfTopic[topic] == nil { firstOfTopic[topic] = "m\(index)" }
                previous = topic
            }
            let actual = TopicDividers.compute(messages)
            assert(Set(actual.keys) == Set(expected.keys), "\(fixture["name"]!): \(actual.keys.sorted()) vs \(expected.keys.sorted())")
            for (id, returnsTo) in expected { assert(actual[id]?.returnsTo == returnsTo, "\(fixture["name"]!): return target of \(id)") }
        }
        let first = cases[0]["messages"] as! [[Any]]
        let crawler = TopicDividers.compute(first.enumerated().map { ChatMessage(id: "m\($0.offset)", role: $0.element[0] as! String, content: $0.element[1] as! String) })
        assert(crawler["m8"] == TopicDivider(messageID: "m8", label: "帮我写一个 Python 爬虫，抓取…", returnsTo: "m0"), "\(String(describing: crawler["m8"]))")
        assert(crawler["m4"]?.label == "明天北京天气怎么样" && crawler["m4"]?.returnsTo == nil)
        // A very long message is cut to the shared limit before crossing the bridge.
        let long = [ChatMessage(id: "u1", role: "user", content: "帮我写一个 Python 爬虫"), ChatMessage(id: "u2", role: "user", content: String(repeating: "。", count: TopicDividers.textLimit) + "明天北京天气怎么样，推荐几本科幻小说")]
        assert(TopicDividers.compute(long).isEmpty, "Text past the shared limit must not split a topic")
        print("Topic dividers passed: \(cases.count) shared cases through the agent core, return targets, labels, shared text limit")
    }
}
