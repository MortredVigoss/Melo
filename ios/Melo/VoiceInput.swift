import Foundation
import Combine

enum SpeechInputEvent {
    case listening
    case transcript(String, final: Bool)
    case failure(String)
}

protocol SpeechInputEngine: AnyObject {
    func start(locale: String, receive: @escaping (SpeechInputEvent) -> Void)
    func finish()
    func cancel()
}

struct VoiceInputSnapshot: Equatable {
    var sessionID = ""
    var status = "idle"
    var partial = ""
    var finalText = ""
    var error = ""
    var notice = ""
    var active: Bool { ["requesting", "listening", "stopping"].contains(status) }
    var recording: Bool { status == "listening" }
}

// Shared by macOS and iPhone. All engine callbacks and UI calls run on main.
// Session identity prevents a late permission/result callback from changing a new draft.
final class VoiceInput: ObservableObject {
    @Published private(set) var state = VoiceInputSnapshot()
    var onUpdate: ((VoiceInputSnapshot) -> Void)?
    private let engine: SpeechInputEngine
    private var activeID: String?
    private var deadline: DispatchWorkItem?
    private var finalDeadline: DispatchWorkItem?
    private var commit: ((String) -> Void)?
    private let recordingLimit: TimeInterval
    private let finalWait: TimeInterval

    init(engine: SpeechInputEngine, recordingLimit: TimeInterval = 60, finalWait: TimeInterval = 2) {
        self.engine = engine
        self.recordingLimit = recordingLimit
        self.finalWait = finalWait
    }

    func start(id: String = UUID().uuidString, locale: String = "zh-CN", commit: ((String) -> Void)? = nil) {
        guard activeID == nil else { return }
        activeID = id
        self.commit = commit
        state = VoiceInputSnapshot(sessionID: id, status: "requesting")
        publish()
        engine.start(locale: locale) { [weak self] event in self?.receive(event, id: id) }
    }

    private func receive(_ event: SpeechInputEvent, id: String) {
        guard activeID == id else { return }
        switch event {
        case .listening:
            guard state.status == "requesting" else { return }
            state.status = "listening"
            let timer = DispatchWorkItem { [weak self] in
                guard let self, self.activeID == id else { return }
                self.stop()
            }
            deadline = timer
            DispatchQueue.main.asyncAfter(deadline: .now() + recordingLimit, execute: timer)
            publish()
        case .transcript(let text, let final):
            state.partial = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if final { complete() } else { publish() }
        case .failure(let message):
            // Keep recognized words available for correction even if the service disconnects.
            complete(error: message)
        }
    }

    func stop() {
        guard let id = activeID else { return }
        if state.status == "requesting" { cancel(); return }
        guard state.status == "listening" else { return }
        deadline?.cancel()
        state.status = "stopping"
        publish()
        let timer = DispatchWorkItem { [weak self] in
            guard let self, self.activeID == id else { return }
            self.complete(notice: "已保留当前转写，未收到最终确认，请核对文字。")
        }
        finalDeadline = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + finalWait, execute: timer)
        engine.finish()
    }

    func cancel() {
        activeID = nil
        commit = nil
        deadline?.cancel(); finalDeadline?.cancel()
        engine.cancel()
        state = VoiceInputSnapshot()
        publish()
    }

    private func complete(error: String = "", notice: String = "") {
        guard activeID != nil else { return }
        activeID = nil // invalidate before engine.cancel() can emit its own error
        deadline?.cancel(); finalDeadline?.cancel()
        engine.cancel()
        let text = state.partial
        state.status = error.isEmpty ? "ready" : "error"
        state.partial = ""
        state.finalText = text
        state.error = error
        state.notice = text.isEmpty && error.isEmpty ? "没有识别到文字，请重试。" : notice
        let apply = commit
        commit = nil
        if !text.isEmpty { apply?(text) }
        publish()
    }

    private func publish() { onUpdate?(state) }
}
