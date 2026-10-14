import Foundation

@main struct ConnectionProbeTests {
    static func main() throws {
        let endpoint = "https://example.invalid/v1/messages", model = "fixture-model", key = "fixture-secret"
        let probe = ConnectionProbe(signature: ConnectionProbe.signature(endpoint: endpoint, model: model, apiProtocol: "anthropic", key: key), requestedModel: model, returnedModel: nil, response: "4", elapsedMS: 12, testedAt: "2026-10-08T00:00:00Z")
        let data = try JSONEncoder().encode(probe)
        let restored = try JSONDecoder().decode(ConnectionProbe.self, from: data)
        assert(restored == probe && restored.returnedModel == nil)
        assert(!String(decoding: data, as: UTF8.self).contains(key))
        assert(restored.matches(endpoint: endpoint, model: model, apiProtocol: "anthropic", key: key))
        assert(!restored.matches(endpoint: endpoint + "/other", model: model, apiProtocol: "anthropic", key: key))
        assert(!restored.matches(endpoint: endpoint, model: "another", apiProtocol: "anthropic", key: key))
        assert(!restored.matches(endpoint: endpoint, model: model, apiProtocol: "chat-completions", key: key))
        assert(!restored.matches(endpoint: endpoint, model: model, apiProtocol: "anthropic", key: "changed"))
        print("Connection probe tests passed: persistence, missing returned model, configuration invalidation and no raw credential")
    }
}
