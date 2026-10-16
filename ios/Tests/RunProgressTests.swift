import Foundation

// Live steps shown in the chat come only from the real execution record; running
// steps are always kept, finished ones trimmed to the most recent.
@main struct RunProgressTests {
    static func main() {
        var record = ExecutionRecord(chatId: "c", query: "q", requestedModel: "m")
        record.pipeline = (1...8).map { ExecutionStage(id: "s\($0)", name: "步骤 \($0)", status: $0 == 3 ? "running" : $0 == 5 ? "failed" : "completed", output: "第 \($0) 步\n详情") }
        record.pipeline?.append(ExecutionStage(id: "reply:render", name: "本机聊天渲染", status: "completed"))
        record.operations = [ExecutionOperation(id: "o1", module: "search", name: "native_web_search", status: "running", query: "悉尼天气")]
        let steps = RunProgress.steps(record, limit: 4)
        assert(steps.count == 4, "\(steps.map(\.title))")
        assert(steps.contains { $0.title == "步骤 3" && $0.state == .running }, "running stage kept even when old")
        assert(steps.contains { $0.title == "联网搜索" && $0.detail == "悉尼天气" && $0.state == .running })
        assert(steps.filter { $0.state != .running }.map(\.title) == ["步骤 7", "步骤 8"], "most recent finished steps")
        assert(!steps.contains { $0.title == "本机聊天渲染" } && !steps.contains { $0.detail.contains("\n") })
        assert(RunProgress.state("cancelled") == .failed && RunProgress.state("queued") == .running)
        print("Run progress tests passed: running kept, recent finished, searches shown, render stage hidden")
    }
}
