import Foundation
import CryptoKit

@main struct SharedAgentCoreTests {
    static func main() async throws {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        func runtime() throws -> SharedAgentCore {
            try SharedAgentCore(bundleURL: root.appendingPathComponent("shared/agent/dist/agent-core.js"), manifestURL: root.appendingPathComponent("shared/agent/dist/manifest.json"))
        }
        let core = try runtime()
        defer { core.close() }
        let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/agent/fixtures/conformance.json"))) as! [[String: Any]]
        for fixture in cases {
            let reply = try await core.evaluate(fixture["input"] as! [String: Any])
            assert(reply["ok"] as? Bool == fixture["ok"] as? Bool, fixture["name"] as! String)
            let result = reply[(reply["ok"] as? Bool == true) ? "value" : "error"]!
            if let expected = fixture["expected"] as? [Any] {
                assert(NSDictionary(dictionary: ["value": result]).isEqual(to: ["value": expected]), fixture["name"] as! String)
                continue
            }
            if let expected = fixture["expected"] as? String {
                assert(result as? String == expected, fixture["name"] as! String)
                continue
            }
            let value = result as! [String: Any]
            for (key, expected) in fixture["expected"] as! [String: Any] {
                guard let actual = value[key] else { fatalError("Missing \(key)") }
                assert(NSDictionary(dictionary: [key: actual]).isEqual(to: [key: expected]), "\(fixture["name"]!): \(key)")
            }
        }
        let sourceURL = "https://fixture.invalid/menu"
        let source: [[String: Any]] = [["id": "read-1", "type": "source", "executed": true, "ok": true, "url": sourceURL, "reading": "extracted", "text": "A local cafe serves a morning meal including eggs and pancakes every day."]]
        let cited = AgentCompletionReceipt.make(goal: "Research Sydney brunch", reply: "A cafe serves breakfast.", observations: source, citations: [["url": sourceURL]])
        assert(cited?.outcome == "completed" && cited?.goalState == "supported", "iOS host must forward displayed citations")
        assert(AgentCompletionReceipt.make(goal: "Research Sydney brunch", reply: "A cafe serves breakfast.", observations: source)?.outcome != "completed")
        let taskData = try Data(contentsOf: root.appendingPathComponent("shared/agent/fixtures/tasks.json"))
        let taskDataset = try JSONSerialization.jsonObject(with: taskData) as! [String: Any]
        let taskStart = Date()
        let taskReply = try await core.evaluate(["version": 1, "op": "taskReplay", "dataset": taskDataset])
        assert(taskReply["ok"] as? Bool == true)
        let taskResult = taskReply["value"] as! [String: Any]
        assert(taskResult["passed"] as? Bool == true)
        let golden = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/agent/fixtures/tasks.expected.json"))) as! [String: Any]
        assert(NSDictionary(dictionary: taskResult).isEqual(to: golden), "Task replay events and metrics must match the shared dataset")
        let bundleData = try Data(contentsOf: root.appendingPathComponent("shared/agent/dist/agent-core.js"))
        func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
        let taskReport: [String: Any] = ["version": 1, "host": "JavaScriptCore", "datasetSha256": digest(taskData), "bundleSha256": digest(bundleData), "replayElapsedMs": Date().timeIntervalSince(taskStart) * 1000, "report": taskResult]
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".tmp"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: taskReport, options: [.sortedKeys]).write(to: root.appendingPathComponent(".tmp/agent-task-eval-jscore.json"))
        print("Shared task replay: \((golden["tasks"] as! [Any]).count) tasks; canonical events and fixture metrics verified")
        let independent = try runtime()
        defer { independent.close() }
        core.close()
        let hello = try await independent.evaluate(["version": 1, "op": "hello"])
        assert(hello["ok"] as? Bool == true)
        let injection = try await independent.evaluate(["version": 1, "op": "plan", "request": ["text": "');throw new Error('injected');// 中文 😀"]])
        assert(injection["ok"] as? Bool == true)
        print("Shared Agent Core JSCore: \(cases.count) conformance fixtures + isolation / data bridge passed")
    }
}
