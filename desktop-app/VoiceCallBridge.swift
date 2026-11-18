import Foundation

/// Live voice call for the desktop page (plan A, 2026-11-16,
/// docs/realtime-voice-plan-20261116.md). The page runs the conversation —
/// sending, supplements, synthesis in the Agent's voice — and this bridge owns
/// the call engine shared with the iPhone (ios/Melo/VoiceCall.swift and
/// SystemVoiceCallAudio.swift). Every event goes back to the page as a
/// `melo-voice-call` CustomEvent carrying the session id; messages for any
/// other session are ignored. One call at a time.
final class VoiceCallBridge {
    private var call: VoiceCall?
    private var sessionID = ""
    private let send: (String) -> Void

    init(send: @escaping (String) -> Void) { self.send = send }

    var active: Bool { call != nil }

    func handle(_ payload: [String: Any], action: String) {
        if action == "callStart" { start(payload); return }
        guard let call, payload["sessionID"] as? String == sessionID else { return }
        switch action {
        case "callEnd":
            end()
        case "callMark":
            if let turn = payload["turn"] as? String, let stage = payload["stage"] as? String,
               ["voiceTurn", "typedTurn", "firstText", "finalAnswer"].contains(stage) { call.mark(stage, turn: turn, utterance: payload["utterance"] as? Int) }
        case "callPlay":
            let id = payload["id"] as? String ?? ""
            guard !id.isEmpty, let base64 = payload["data"] as? String, let data = Data(base64Encoded: base64), !data.isEmpty else {
                emit(sessionID, ["type": "clipFailed", "id": id, "reason": "这句语音的数据无效"]); return
            }
            call.speak(VoiceCallClip(id: id, text: payload["text"] as? String ?? "",
                                     source: .audio(data, mimeType: payload["mimeType"] as? String ?? "audio/mpeg"), answerTurn: payload["answerTurn"] as? String))
        case "callSpeak":
            let id = payload["id"] as? String ?? "", text = payload["text"] as? String ?? ""
            guard !id.isEmpty, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                emit(sessionID, ["type": "clipFailed", "id": id, "reason": "没有要朗读的文字"]); return
            }
            call.speak(VoiceCallClip(id: id, text: text, source: .speech(voice: payload["voice"] as? String, language: payload["language"] as? String), answerTurn: payload["answerTurn"] as? String))
        case "callStopPlayback":
            call.stopSpeaking()
        case "callInterrupt":
            call.interrupt()
        case "callMute":
            call.setMuted(payload["muted"] as? Bool ?? false)
        case "callTiming":
            call.updateTiming(Self.timing(payload))
        default:
            break
        }
    }

    /// Hang up (page message, navigation, app exit). The final state still reaches the page.
    func end() {
        let ending = call
        ending?.end()
        if call === ending { call = nil }
    }

    private func start(_ payload: [String: Any]) {
        end()
        guard let id = payload["sessionID"] as? String, !id.isEmpty else { return }
        let call = VoiceCall(audio: SystemVoiceCallAudio(), timing: Self.timing(payload))
        let stopWords = Set((payload["stopPhrases"] as? [String] ?? []).map { String(VoiceCallText.normalized($0)) })
        call.isStopPhrase = { stopWords.contains(String(VoiceCallText.normalized($0))) }
        call.onMetric = SystemVoiceCallAudio.recordTiming
        sessionID = id
        call.onUpdate = { [weak self, weak call] state in
            guard let self else { return }
            self.emit(id, ["type": "state", "phase": state.phase, "partial": state.partial, "muted": state.muted,
                           "echoCancellation": state.echoCancellation, "onDevice": state.onDeviceRecognition,
                           "error": state.error, "notice": state.noticeCode])
            if ["ended", "failed"].contains(state.phase), let call, self.call === call { self.call = nil }
        }
        call.onUtterance = { [weak self, weak call] text in
            guard let call else { return }
            self?.emit(id, ["type": "utterance", "text": text, "utteranceID": call.utteranceNumber])
        }
        call.onBargeIn = { [weak self] in self?.emit(id, ["type": "bargeIn"]) }
        call.onPlaybackIdle = { [weak self] in self?.emit(id, ["type": "playbackIdle"]) }
        call.onClipFinished = { [weak self] clip in self?.emit(id, ["type": "clipFinished", "id": clip]) }
        call.onClipFailed = { [weak self] clip, reason in self?.emit(id, ["type": "clipFailed", "id": clip, "reason": reason]) }
        self.call = call
        call.start(id: id, locale: payload["language"] as? String ?? "system")
    }

    private static func timing(_ payload: [String: Any]) -> VoiceCallTiming {
        func number(_ key: String) -> Double? { (payload[key] as? NSNumber)?.doubleValue }
        return VoiceCallTiming(endpointMs: number("endpointMs"), bargeInMs: number("bargeInMs"), utteranceLimitMs: number("utteranceLimitMs"),
                               echoTailMs: number("echoTailMs"), echoSimilarity: number("echoSimilarity"))
    }

    private func emit(_ id: String, _ fields: [String: Any]) {
        var payload = fields
        payload["sessionID"] = id
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        send(json)
    }
}
