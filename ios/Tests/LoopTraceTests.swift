import Foundation

@main struct LoopTraceTests {
    static func main() async throws {
        let repository = URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("melo-loop-trace-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:base) }
        let core = try SharedAgentCore(bundleURL:repository.appendingPathComponent("shared/agent/dist/agent-core.js"),manifestURL:repository.appendingPathComponent("shared/agent/dist/manifest.json"))
        let root = try LoopTrace.Root(runID:"parent",base:base,core:core)
        let scope = LoopTrace.Scope(root:root,runID:"parent",kind:"chat")
        await LoopTrace.$current.withValue(scope) {
            LoopTrace.emit("run.started",payload:["goal":"Read venue then weather"])
            LoopTrace.emit("model.provider.payload",payload:["model":"fixture","tools":[["name":"web_search"]],"apiKey":"DO_NOT_PERSIST","input":[["type":"input_image","image_url":"data:image/png;base64,PRIVATE_PIXELS"]]])
            let child = LoopTrace.Scope(root:root,runID:"child",kind:"skill",parentRunID:"parent",parentSpanID:"tool:call-1")
            await LoopTrace.$current.withValue(child) {
                LoopTrace.emit("run.started",payload:["goal":"Child fixture"])
                await root.finish(child,outcome:"blocked")
            }
            LoopTrace.emit("goal.check",["decision":"partial"])
            await root.finish(scope,outcome:"partial")
        }
        let eventsURL = root.directory.appendingPathComponent("events.jsonl")
        let rows = try String(contentsOf:eventsURL,encoding:.utf8).split(separator:"\n").map { try JSONSerialization.jsonObject(with:Data($0.utf8)) as! [String: Any] }
        assert(rows.count == 6)
        assert(rows.compactMap { $0["sequence"] as? Int } == Array(1...rows.count))
        assert(rows.filter { $0["type"] as? String == "run.finished" }.count == 2)
        let child = rows.first { $0["runId"] as? String == "child" }!
        assert(child["parentRunId"] as? String == "parent")
        for row in rows {
            if let ref = (row["data"] as? [String: Any])?["contentRef"] as? String {
                let content = try String(contentsOf:root.directory.appendingPathComponent(ref),encoding:.utf8)
                assert(!content.contains("DO_NOT_PERSIST") && !content.contains("PRIVATE_PIXELS"))
            }
        }
        let manifest = try JSONSerialization.jsonObject(with:Data(contentsOf:root.directory.appendingPathComponent("manifest.json"))) as! [String: Any]
        assert(manifest["complete"] as? Bool == true)
        assert(manifest["status"] as? String == "partial")
        print("Local shared Loop Trace: JSC schema, JSONL, parent linkage, secret/media exclusion and terminal verified")
    }
}
