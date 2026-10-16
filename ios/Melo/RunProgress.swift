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
        var steps: [RunStep] = []
        for stage in record.pipeline ?? [] where stage.id != "reply:render" {
            let detail = String(stage.output.replacingOccurrences(of: "\n", with: " ").prefix(80))
            steps.append(RunStep(id: "stage:" + stage.id, title: stage.name, detail: detail, state: state(stage.status)))
        }
        for operation in record.operations {
            let what: String = operation.query.isEmpty ? operation.input : operation.query
            let summary: String = operation.resultSummary.isEmpty ? what : what + " · " + operation.resultSummary
            let title: String = operation.module == "search" ? String(localized: "联网搜索") : operation.name
            steps.append(RunStep(id: "op:" + operation.id, title: title, detail: String(summary.prefix(80)), state: state(operation.status)))
        }
        guard steps.count > limit else { return steps }
        let runningIDs = Set(steps.filter { $0.state == .running }.map(\.id))
        let keepFinished = max(0, limit - runningIDs.count)
        let finishedIDs = Set(steps.filter { $0.state != .running }.suffix(keepFinished).map(\.id))
        return steps.filter { runningIDs.contains($0.id) || finishedIDs.contains($0.id) }
    }
}
