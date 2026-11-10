import Foundation

/// What a running reply is doing right now, for the chat itself (the task space
/// shows the full record). Built only from the real execution record: model
/// requests, searches, image work, phone data, team members, supplements.
struct RunStep: Equatable, Identifiable {
    enum State: Equatable { case running, done, failed }
    let id: String
    let title: String
    let detail: String
    let state: State
}

enum RunProgress {
    static func state(_ status: String) -> RunStep.State {
        switch status {
        case "completed", "done", "succeeded": return .done
        case "failed", "cancelled", "error", "interrupted": return .failed
        default: return .running
        }
    }
    /// Latest steps first-to-last, at most `limit`, running steps always kept.
    static func steps(_ record: ExecutionRecord, limit: Int = 6) -> [RunStep] {
        var timed: [(step: RunStep, at: String)] = []
        for stage in record.pipeline ?? [] where stage.id != "reply:render" {
            // A stage that is still running has no result yet: it shows what it was asked to do
            // (a member's task), as on the desktop. The row used to be blank until the member reported.
            let text = stage.output.isEmpty ? stage.input : stage.output
            let detail = String(text.replacingOccurrences(of: "\n", with: " ").prefix(80))
            timed.append((RunStep(id: "stage:" + stage.id, title: String(localized: String.LocalizationValue(stage.name)), detail: detail, state: state(stage.status)), stage.startedAt ?? stage.finishedAt ?? ""))
        }
        for operation in record.operations {
            let what: String = operation.query.isEmpty ? operation.input : operation.query
            let summary: String = operation.resultSummary.isEmpty ? what : what + " · " + operation.resultSummary
            let title: String = operation.name == "native_web_search" ? String(localized: "联网搜索") : operation.name
            timed.append((RunStep(id: "op:" + operation.id, title: title, detail: String(summary.prefix(80)), state: state(operation.status)), operation.startedAt ?? operation.finishedAt ?? ""))
        }
        // In the order things happened, as on the desktop (runSteps.js). Stages and tool calls used to be
        // listed one group after the other, so with more steps than fit the most recent stages were the
        // ones cut. Records without times on every step keep the old order.
        let steps = timed.allSatisfy { !$0.at.isEmpty }
            ? timed.enumerated().sorted { ($0.element.at, $0.offset) < ($1.element.at, $1.offset) }.map(\.element.step)
            : timed.map(\.step)
        guard steps.count > limit else { return steps }
        let runningIDs = Set(steps.filter { $0.state == .running }.map(\.id))
        let keepFinished = max(0, limit - runningIDs.count)
        let finishedIDs = Set(steps.filter { $0.state != .running }.suffix(keepFinished).map(\.id))
        return steps.filter { runningIDs.contains($0.id) || finishedIDs.contains($0.id) }
    }

    /// Why the loop stopped itself, in words; the code stays next to them. Unknown codes are shown as they are.
    static let stopReasons: [String: String] = [
        "REPEATED_TOOL_FAILURE": "工具连续失败", "NO_PROGRESS": "连续几轮没有新进展", "GOAL_CHECK_LIMIT": "核对次数已用完",
        "ROUND_LIMIT": "已到执行轮数上限", "DEADLINE_EXCEEDED": "已到运行时限", "GOAL_CHECK_TOOLS": "核对时出现了工具调用",
    ]
    static func stopReason(_ code: String) -> String { stopReasons[code].map { $0 + "（" + code + "）" } ?? code }
    /// The name a tool is shown under, the same one its executed calls carry in the run record.
    static func toolName(_ id: String) -> String {
        if let web = WebPageToolSpec.named(id) { return web.recordName }
        if let device = DeviceToolSpec.named(id) { return "手机数据 · " + device.actionLabel }
        return ["read_history": "早期对话 · 读取原文", "calculator": "计算", "route_task": "派单", "task_progress": "任务进度", "melo_escalate": "切换模型", "web_search": "联网搜索"][id] ?? "工具 · " + id
    }
    /// Why a call did not reach its tool, in words. Codes without an entry are shown as they are.
    static let refusals: [String: String] = [
        "CAPABILITY_DENIED": "当前没有这项权限", "PERMISSION_DENIED": "已被拒绝", "UNKNOWN_TOOL": "没有这个工具", "ROUTE_DENIED": "现在不能派单",
        "ALREADY_EXECUTED": "同样的操作已经完成", "ALREADY_ATTEMPTED": "同样的操作已经尝试过", "REPEATED_FAILURE": "同样的调用已连续失败",
        "BUDGET_EXHAUSTED": "运行预算已用完", "ABORTED": "已停止", "INVALID_TOOL_ARGUMENTS": "参数不符合要求", "INVALID_ARGS": "参数不符合要求",
        "PREREQUISITE_MISSING": "前置步骤尚未完成", "ROUTING_REQUIRES_STRONG": "需要先切换到更强的模型", "TOOL_NOT_PERMITTED": "本轮不允许",
        "TOO_MANY_SCREENSHOTS": "本次回复的截图次数已用完",
    ]
    /// A call the loop answered or refused itself, without reaching a tool, as one row of the record.
    /// A call Melo answered (a saved result reused after a pause, a request to switch model) is not a
    /// failure; it used to be shown as one, like every refusal, under the tool's internal name and
    /// with the bare reason code (2026-11-10).
    static func unexecuted(_ call: ExecutionToolCall) -> (name: String, status: String, output: String) {
        let name = toolName(call.toolId)
        if call.status != "error" { return (name, "completed", call.toolId == "melo_escalate" ? "已记录" : "沿用已保存的结果") }
        let code = call.code ?? "UNKNOWN"
        return (name, "failed", "未执行：" + (refusals[code] ?? code))
    }
}
