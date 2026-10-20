import Foundation

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
            let value = result as! [String: Any]
            for (key, expected) in fixture["expected"] as! [String: Any] {
                guard let actual = value[key] else { fatalError("Missing \(key)") }
                assert(NSDictionary(dictionary: [key: actual]).isEqual(to: [key: expected]), "\(fixture["name"]!): \(key)")
            }
        }
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
