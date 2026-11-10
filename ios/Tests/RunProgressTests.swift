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
        // 2026-11-10. A running member shows its task; steps are in the order they happened, so the newest
        // stage is not the one that is cut; a call the loop answered or refused reads in words.
        var live = ExecutionRecord(chatId: "c", query: "q", requestedModel: "m")
        live.pipeline = [ExecutionStage(id: "internal:1", name: "检索成员", status: "running", input: "读场馆页面，找今天的营业时间", startedAt: "2026-11-10T01:00:05.000Z")]
        assert(RunProgress.steps(live).first?.detail == "读场馆页面，找今天的营业时间", "a running member shows what it was asked to do")
        var ordered = ExecutionRecord(chatId: "c", query: "q", requestedModel: "m")
        ordered.pipeline = [ExecutionStage(id: "model:response", name: "模型请求", status: "completed", startedAt: "2026-11-10T01:00:01.000Z"),
                            ExecutionStage(id: "limit:delivery", name: "整理已确认的内容", status: "completed", output: "已通过核对", startedAt: "2026-11-10T01:00:09.000Z")]
        ordered.operations = (2...7).map { ExecutionOperation(id: "o\($0)", module: "search", name: "网页 · 打开", status: "completed", input: "https://a.example/\($0)", startedAt: "2026-11-10T01:00:0\($0).000Z") }
        let recent = RunProgress.steps(ordered, limit: 3)
        assert(recent.map(\.id) == ["op:o6", "op:o7", "stage:limit:delivery"], "the last thing that happened is the last row: \(recent.map(\.id))")
        func refused(_ name: String, _ code: String?, ok: Bool = false) -> ExecutionToolCall {
            ExecutionToolCall(iteration: 0, call: ResponsesFunctionCall(callID: "x", name: name, arguments: "{}"), args: OrderedJSON.arguments("{}"),
                              outcome: PhoneToolEnvelope.finalize(ok: ok, error: code, output: ""), executed: false, started: Date(), finished: Date())
        }
        let denied = RunProgress.unexecuted(refused("open_url", "CAPABILITY_DENIED"))
        assert(denied.name == "网页 · 打开" && denied.status == "failed" && denied.output == "未执行：当前没有这项权限", "\(denied)")
        let reused = RunProgress.unexecuted(refused("reminders_create", nil, ok: true))
        assert(reused.status == "completed" && reused.output == "沿用已保存的结果" && reused.name.hasPrefix("手机数据 · "), "a result reused after a pause is not a failure: \(reused)")
        assert(RunProgress.unexecuted(refused("melo_escalate", nil, ok: true)).output == "已记录")
        assert(RunProgress.stopReason("NO_PROGRESS") == "连续几轮没有新进展（NO_PROGRESS）" && RunProgress.stopReason("SOMETHING_NEW") == "SOMETHING_NEW")
        assert(RunProgress.unexecuted(refused("web_screenshot", "TOO_MANY_SCREENSHOTS")).output == "未执行：本次回复的截图次数已用完")
        let unknown = RunProgress.unexecuted(refused("mystery_tool", "SOME_NEW_CODE"))
        assert(unknown.name == "工具 · mystery_tool" && unknown.output == "未执行：SOME_NEW_CODE", "a code without wording is shown as it is")
        print("Run progress tests passed: running kept, recent finished, searches shown, render stage hidden")
    }
}
