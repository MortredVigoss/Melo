import Foundation

private final class CountingTransport: AgentModelTransport {
    let offersTools = true
    let timeoutCap: TimeInterval = 10
    var calls = 0
    func round(_ input: AgentLoopRequest) async throws -> AgentRound { calls += 1; return AgentRound(text: "Must never run") }
    func complete(system: String, messages: [ChatMessage], timeout: TimeInterval) async throws -> String { calls += 1; return "Must never run" }
}

@main struct SharedPolicyUnavailableTests {
    static func main() async throws {
        // This suite is a separate process. Only MELO_TEST builds may look for
        // fixture resources in cwd; production loads its signed app resources.
        let original = FileManager.default.currentDirectoryPath
        let empty = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        defer { FileManager.default.changeCurrentDirectoryPath(original); try? FileManager.default.removeItem(at: empty) }
        assert(FileManager.default.changeCurrentDirectoryPath(empty.path))
        let budget = PhoneRunBudget()
        assert(budget.exhausted()?.reason == "policy-unavailable")
        assert(budget.remainingMs() == 0 && budget.requestTimeout(cap: 100) == 0)
        let member = budget.narrowed(maxToolCalls: 100)
        assert(member.exhausted()?.reason == "policy-unavailable")
        for locale in ["zh", "en", "ja", "ko", "es"] {
            let transport = CountingTransport()
            let outcome = try await PhoneReplyLanguage.$current.withValue(locale) {
                try await AgentLoop(transport: transport, tools: nil, budget: budget, latestUserMessage: "test").run()
            }
            assert(outcome.stop == .budget && transport.calls == 0)
            assert(outcome.text == AgentLoopContract.shared.budgetUnavailableReply[locale])
        }
        print("Missing shared policy fails closed: root/member budgets and model calls remain blocked")
    }
}
