import Foundation
import CryptoKit

/// Native file ownership only; the same JS Core normalizes all stored data.
enum LoopTrace {
    final class Scope: @unchecked Sendable {
        let root: Root, runID: String, kind: String, parentRunID: String?, spanID: String, parentSpanID: String?
        let model: Bool
        init(root: Root, runID: String, kind: String, parentRunID: String? = nil, spanID: String? = nil, parentSpanID: String? = nil, model: Bool = false) {
            self.root = root; self.runID = runID; self.kind = kind; self.parentRunID = parentRunID; self.spanID = spanID ?? runID; self.parentSpanID = parentSpanID; self.model = model
        }
        var context: [String: Any] { ["traceId":root.traceID, "runId":runID, "scopeId":kind, "spanId":spanID, "parentRunId":parentRunID as Any? ?? NSNull(), "parentSpanId":parentSpanID as Any? ?? NSNull()] }
    }
    @TaskLocal static var current: Scope?
    final class Root: @unchecked Sendable {
        let traceID: String, directory: URL
        var bundleHash: String { core.bundleHash }
        private let core: SharedAgentCore
        private let lock = NSLock()
        private let writer = DispatchQueue(label: "melo.local-trace.writer")
        private var state: [String: Any]
        private var bytes = 0, pending = 0, failures = 0
        private var closed = false, capped = false, mediaOmitted = false
        private let limits: [String: Any]
        init(runID: String, base: URL, core: SharedAgentCore) throws {
            self.core = core; traceID = UUID().uuidString; directory = base.appendingPathComponent(traceID, isDirectory: true)
            func value(_ fields: [String: Any]) throws -> [String: Any] {
                let reply = try core.evaluateSync(["version":1, "op":"trace"].merging(fields) { _, new in new })
                guard reply["ok"] as? Bool == true, let value = reply["value"] as? [String: Any] else { throw SharedAgentCoreError.invalidReply }
                return value
            }
            state = try value(["action":"create", "context":["traceId":traceID,"runId":runID], "now":ProcessInfo.processInfo.systemUptime * 1000])["trace"] as? [String: Any] ?? [:]
            limits = try value(["action":"limits"])
        }
        private func limit(_ name: String, _ fallback: Int) -> Int { limits[name] as? Int ?? fallback }
        func emit(_ scope: Scope, type: String, data: [String: Any] = [:], payload: Any? = nil, round: Int? = nil) {
            lock.lock(); defer { lock.unlock() }
            if closed || capped && type != "run.finished" { return }
            do {
                var event: [String: Any] = ["type":type,"data":data]
                if let payload { event["payload"] = payload }
                if let round { event["round"] = round }
                let request: [String: Any] = ["version":1,"op":"trace","action":"append","trace":state,"context":scope.context,"event":event,"now":max(state["lastMono"] as? Double ?? 0, ProcessInfo.processInfo.systemUptime * 1000),"at":ISO8601DateFormatter().string(from: Date())]
                let result = try core.evaluateSync(request)
                guard result["ok"] as? Bool == true, let value = result["value"] as? [String: Any] else { failures += 1; return }
                state = value["trace"] as? [String: Any] ?? state
                guard var record = value["record"] as? [String: Any] else { return }
                let artifact = value["artifact"] as? [String: Any], content = artifact?["json"] as? String
                var ref: String?
                if let content {
                    let hash = SHA256.hash(data: Data(content.utf8)).map { String(format: "%02x", $0) }.joined()
                    ref = "artifacts/\(hash).json"
                    var fields = record["data"] as? [String: Any] ?? [:]
                    fields["contentRef"] = ref; fields["contentSha256"] = hash; fields["contentBytes"] = content.utf8.count; record["data"] = fields
                }
                let capture = record["capture"] as? [String: Any] ?? [:]
                mediaOmitted = mediaOmitted || capture["mediaOmitted"] as? Bool == true
                if capture["truncated"] as? Bool == true { failures += 1 }
                var line = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]); line.append(10)
                let size = line.count + (content?.utf8.count ?? 0)
                if (pending >= limit("maxQueue",128) || bytes + size > limit("maxRunBytes",67108864) - 8192) && type != "run.finished" { failures += 1; capped = true; return }
                bytes += size; pending += 1
                let capturedLine = line, capturedRef = ref, capturedContent = content, destination = directory
                writer.async { [self] in
                    defer { lock.lock(); pending -= 1; lock.unlock() }
                    do {
                        let files = FileManager.default
                        try files.createDirectory(at: destination.appendingPathComponent("artifacts"), withIntermediateDirectories: true, attributes: [.posixPermissions:0o700])
                        if let capturedRef, let capturedContent { let file = destination.appendingPathComponent(capturedRef); if !files.fileExists(atPath:file.path) { try Data(capturedContent.utf8).write(to:file,options:.atomic); try? files.setAttributes([.posixPermissions:0o600], ofItemAtPath:file.path) } }
                        let path = destination.appendingPathComponent("events.jsonl")
                        if !files.fileExists(atPath:path.path) { _ = files.createFile(atPath:path.path, contents:nil, attributes:[.posixPermissions:0o600]) }
                        let handle = try FileHandle(forWritingTo:path); defer { try? handle.close() }; try handle.seekToEnd(); try handle.write(contentsOf:capturedLine)
                    } catch { lock.lock(); failures += 1; lock.unlock() }
                }
            } catch { failures += 1 }
        }
        private final class Once: @unchecked Sendable {
            private let lock = NSLock(); private var done = false
            func finish(_ value: Bool, _ continuation: CheckedContinuation<Bool, Never>) { lock.lock(); let first = !done; done = true; lock.unlock(); if first { continuation.resume(returning:value) } }
        }
        func flush() async {
            let once = Once()
            let ok = await withCheckedContinuation { continuation in
                writer.async { once.finish(true,continuation) }
                DispatchQueue.global().asyncAfter(deadline:.now() + .milliseconds(100)) { once.finish(false,continuation) }
            }
            if !ok { lock.lock(); failures += 1; lock.unlock() }
        }
        func finish(_ scope: Scope, outcome: String, reason: String? = nil) async {
            emit(scope,type:"run.finished",data:["outcome":outcome,"reason":reason as Any? ?? NSNull()])
            if scope.parentRunID != nil { await flush(); return }
            lock.lock(); closed = true
            let base: [String: Any] = ["schemaVersion":1,"traceId":traceID,"runId":scope.runID,"host":"ios","status":outcome,"finishedAt":ISO8601DateFormatter().string(from:Date()),"lastSequence":state["sequence"] as Any? ?? 0,"bytes":bytes,"pinned":false,"replayability":["text":"requires_artifact_validation","multimodal":mediaOmitted ? "unavailable" : "not_captured"]]
            lock.unlock()
            writer.async { [self] in
                lock.lock(); let errors = failures; lock.unlock()
                let manifest = base.merging(["complete":errors == 0,"droppedEvents":errors,"problems":errors > 0 ? ["capture_or_io_error"] : []]) { _,new in new }
                do { try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]); try JSONSerialization.data(withJSONObject:manifest,options:[.sortedKeys]).write(to:directory.appendingPathComponent("manifest.json"),options:.atomic) }
                catch { lock.lock(); failures += 1; lock.unlock() }
            }
            await flush(); core.close()
        }
    }
    static func emit(_ type: String, _ data: [String: Any] = [:], payload: Any? = nil, round: Int? = nil) {
        guard let current else { return }
        let target: Scope
        if let call = data["callId"] as? String { target = Scope(root:current.root,runID:current.runID,kind:current.kind,parentRunID:current.parentRunID,spanID:current.runID + ":tool:" + call,parentSpanID:current.runID) } else { target = current }
        target.root.emit(target,type:type,data:data,payload:payload,round:round)
    }
    static func events(_ events: [[String: Any]]) { for event in events { emit(event["type"] as? String ?? "trace.gap",event["data"] as? [String: Any] ?? [:],payload:event["payload"],round:event["round"] as? Int) } }
    static func withRun<T>(runID: String = UUID().uuidString, kind: String = "agent", goal: String, outcome: (T) -> String, work: () async throws -> T) async throws -> T {
        let parent = current
        let root: Root
        if let parent { root = parent.root }
        else {
            guard let base = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask).first,
                  let core = try? SharedAgentCore(), let created = try? Root(runID:runID,base:base.appendingPathComponent("Melo/Traces"),core:core) else { return try await work() }
            root = created
        }
        let scope = Scope(root:root,runID:runID,kind:kind,parentRunID:parent?.runID,parentSpanID:parent?.spanID)
        return try await $current.withValue(scope) {
            emit("run.started",["host":"ios","kind":kind,"coreBundleHash":root.bundleHash,"appVersion":Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "unknown"],payload:["goal":goal])
            do { let result = try await work(); await root.finish(scope,outcome:outcome(result)); return result }
            catch { await root.finish(scope,outcome:error is CancellationError ? "cancelled" : "failed",reason:String(describing:type(of:error))); throw error }
        }
    }
    static func withSpan<T>(_ span: String, model: Bool = false, work: () async throws -> T) async rethrows -> T {
        guard let parent = current else { return try await work() }
        let scope = Scope(root:parent.root,runID:parent.runID,kind:parent.kind,parentRunID:parent.parentRunID,spanID:parent.runID + ":" + span,parentSpanID:parent.spanID,model:model)
        return try await $current.withValue(scope,operation:work)
    }
    static func model<T>(purpose: String, input: Any? = nil, snapshot: (T) -> Any, work: () async throws -> T) async throws -> T {
        if current == nil || current?.model == true { return try await work() }
        return try await withSpan("model:" + UUID().uuidString,model:true) {
            let started = ProcessInfo.processInfo.systemUptime
            emit("model.request.prepared",["purpose":purpose],payload:input)
            emit("model.request.started",["source":"model-adapter","providerDispatch":"unknown"])
            await current?.root.flush()
            do { let result = try await work(); emit("model.response",["durationMs":(ProcessInfo.processInfo.systemUptime-started)*1000,"firstEventMs":NSNull(),"usageOrigin":"unknown"],payload:snapshot(result)); return result }
            catch { emit("model.error",["durationMs":(ProcessInfo.processInfo.systemUptime-started)*1000,"code":String(describing:type(of:error))]); throw error }
        }
    }
    static func providerPayload(_ body: [String: Any]) async {
        guard current != nil else { return }
        emit("context.snapshot",["source":"provider-wire","skillsCapturedInInstructions":true],payload:body)
        emit("capabilities.snapshot",["source":"provider-wire","toolSchemaCaptured":body["tools"] != nil],payload:["tools":body["tools"] ?? NSNull()])
        emit("model.provider.payload",["source":"provider-wire"],payload:body)
        emit("model.transport.started",["source":"provider-wire"]); await current?.root.flush()
    }
}
