import Foundation
import Combine

/// The iPhone half of the live voice call (plan A, 2026-11-16,
/// docs/realtime-voice-plan-20261116.md). The engine shared with the desktop
/// (VoiceCall + SystemVoiceCallAudio) listens; a finished utterance becomes a
/// voice turn (`ChatStore.send(…, voiceTurn: true)`), a supplement while a reply
/// is running, or a stop. Every reply written in this conversation during the
/// call is read with the system voice through the call's own audio engine, so
/// the user can talk over it. Approvals stay on screen; the call only says so.
@MainActor final class VoiceCallController: ObservableObject {
    struct Line: Identifiable, Equatable {
        let id = UUID()
        let fromUser: Bool
        let text: String
    }

    @Published private(set) var state = VoiceCallSnapshot()
    @Published private(set) var lines: [Line] = []
    @Published private(set) var thinking = false
    @Published private(set) var message = ""

    private var call: VoiceCall?
    private weak var store: ChatStore?
    private(set) var chatID = ""
    private var observers: Set<AnyCancellable> = []
    private var replyAttempt: UUID?
    private var awaitingTurn = false
    private var repliedSinceSend = false
    private var turnLanguage = "zh"
    private var toolPhraseSpoken = false
    private var promptPhraseSpoken = false
    private var recognitionLanguage = "system"
    private var clipNumber = 0

    private let makeAudio: () -> VoiceCallAudio

    init(makeAudio: @escaping () -> VoiceCallAudio = { SystemVoiceCallAudio() }) {
        self.makeAudio = makeAudio
    }

    var active: Bool { state.active }

    func start(chatID: String, store: ChatStore, locale: String, endpointMs: Double?) {
        end()
        guard store.chats.contains(where: { $0.id == chatID }) else { return }
        self.store = store
        self.chatID = chatID
        recognitionLanguage = locale
        replyAttempt = nil
        lines = []; thinking = store.isSending(chatID); message = ""
        awaitingTurn = false; toolPhraseSpoken = false; promptPhraseSpoken = false
        LocalDeviceServices.shared.stopSpeech()
        LocalDeviceServices.shared.callActive = true
        let call = VoiceCall(audio: makeAudio(), timing: VoiceTurnRules.timing(endpointMs: endpointMs))
        call.onUpdate = { [weak self] snapshot in self?.update(snapshot) }
        call.onUtterance = { [weak self] text in self?.heard(text) }
        call.onClipFailed = { [weak self] _, reason in self?.message = reason }
        call.isStopPhrase = VoiceTurnRules.isStopPhrase
        call.onMetric = SystemVoiceCallAudio.recordTiming
        self.call = call
        store.callReplies.sink { [weak self, weak call] entry in
            guard let self, let call, self.call === call, entry.chat == chatID else { return }
            switch entry.event {
            case .started(let voice):
                self.replyAttempt = entry.attempt
                self.repliedSinceSend = false
                self.toolPhraseSpoken = false
                self.promptPhraseSpoken = false
                self.awaitingTurn = voice
                call.stopSpeaking()
                call.mark(voice ? "voiceTurn" : "typedTurn", turn: entry.attempt.uuidString)
            case .saved(let text):
                guard self.replyAttempt == entry.attempt, !self.repliedSinceSend else { return }
                self.repliedSinceSend = true
                call.mark("firstText", turn: entry.attempt.uuidString)
                call.mark("finalAnswer", turn: entry.attempt.uuidString)
                self.read(text, turn: entry.attempt.uuidString)
            case .finished:
                guard self.replyAttempt == entry.attempt else { return }
                if self.awaitingTurn, !self.repliedSinceSend { self.say(VoiceTurnRules.phrase("failed", language: self.turnLanguage)) }
                self.replyAttempt = nil
                self.awaitingTurn = false
            }
        }.store(in: &observers)
        store.$replyDrafts.sink { [weak self, weak call] drafts in
            guard let self, let call, self.call === call, let attempt = self.replyAttempt,
                  drafts[chatID]?.isEmpty == false else { return }
            call.mark("firstText", turn: attempt.uuidString)
        }.store(in: &observers)
        store.$chats.sink { [weak self, weak call] chats in
            if let self, let call, self.call === call, !chats.contains(where: { $0.id == chatID }) { self.end() }
        }.store(in: &observers)
        store.$sendingChats.sink { [weak self, weak call] sending in
            if let self, let call, self.call === call { self.thinking = sending.contains(chatID) }
        }.store(in: &observers)
        store.$executionRecords.receive(on: RunLoop.main).sink { [weak self, weak call] _ in
            if let self, let call, self.call === call { self.progressChanged() }
        }.store(in: &observers)
        store.$pendingDeviceAction.combineLatest(store.$pendingCapabilityRequest).receive(on: RunLoop.main)
            .sink { [weak self, weak call, weak store] action, request in
                guard let self, let call, self.call === call else { return }
                self.promptChanged((action != nil || request != nil) && store?.approvalChatID == chatID)
            }.store(in: &observers)
        call.start(locale: locale)
    }

    /// Hang up. Safe to call at any time; a failed call has already released everything.
    func end() {
        call?.end()
        release()
    }

    func toggleMute() { call?.setMuted(!state.muted) }
    func interrupt() { call?.interrupt() }
    func updateEndpoint(_ endpointMs: Double) { call?.updateTiming(VoiceTurnRules.timing(endpointMs: endpointMs)) }

    // MARK: Events

    private func update(_ snapshot: VoiceCallSnapshot) {
        state = snapshot
        if !snapshot.error.isEmpty { message = snapshot.error }
        if ["ended", "failed"].contains(snapshot.phase) { release() }
    }

    private func release() {
        observers.removeAll()
        call = nil
        replyAttempt = nil
        awaitingTurn = false
        thinking = false
        LocalDeviceServices.shared.callActive = false
    }

    private func heard(_ text: String) {
        guard active, let store, let call else { return }
        let language = VoiceTurnRules.language(text)
        if VoiceTurnRules.isStopPhrase(text) {
            if store.isSending(chatID) {
                awaitingTurn = false
                replyAttempt = nil
                call.stopSpeaking()
                store.cancel(chatID: chatID)
                say(VoiceTurnRules.phrase("stopped", language: language))
            } else {
                call.stopSpeaking()
            }
            return
        }
        remember(Line(fromUser: true, text: text))
        if store.isSending(chatID) {
            // The running reply takes it before its next model call (desktop parity).
            store.supplement(text, chatID: chatID)
            return
        }
        // A new question replaces whatever is left of the previous answer.
        call.stopSpeaking()
        message = ""
        turnLanguage = language
        toolPhraseSpoken = false; promptPhraseSpoken = false
        repliedSinceSend = false
        store.send(text, chatID: chatID, voiceTurn: true) { [weak self, weak call] reason in
            guard let self, let call, self.call === call else { return }
            self.message = reason
            self.say(VoiceTurnRules.phrase("failed", language: language))
        }
        if store.isSending(chatID) { awaitingTurn = true; thinking = true }
    }

    private func progressChanged() {
        guard active, awaitingTurn, !toolPhraseSpoken, let store, store.isSending(chatID), call?.isSpeaking == false,
              store.scenes(for: chatID).last?.toolCalls?.isEmpty == false else { return }
        toolPhraseSpoken = true
        say(VoiceTurnRules.phrase("tools", language: turnLanguage))
    }

    private func promptChanged(_ waiting: Bool) {
        guard active, replyAttempt != nil else { return }
        guard waiting else { promptPhraseSpoken = false; return }
        guard !promptPhraseSpoken else { return }
        promptPhraseSpoken = true
        say(VoiceTurnRules.phrase("approval", language: turnLanguage))
    }

    // MARK: Speaking

    private func read(_ reply: String, turn: String) {
        let speech = VoiceTurnRules.speech(from: reply)
        guard !speech.sentences.isEmpty else { return }
        call?.stopSpeaking()
        remember(Line(fromUser: false, text: speech.text))
        let voiceLanguage = SpeechText.voiceLanguage(for: speech.text, preference: recognitionLanguage)
        for (index, sentence) in speech.sentences.enumerated() { enqueue(sentence, language: voiceLanguage, answerTurn: index == 0 ? turn : nil) }
    }

    private func say(_ phrase: String) {
        guard !phrase.isEmpty else { return }
        enqueue(phrase, language: SpeechText.voiceLanguage(for: phrase, preference: recognitionLanguage))
    }

    private func enqueue(_ text: String, language: String, answerTurn: String? = nil) {
        clipNumber += 1
        call?.speak(VoiceCallClip(id: "clip-\(clipNumber)", text: text, source: .speech(voice: nil, language: language), answerTurn: answerTurn))
    }

    private func remember(_ line: Line) {
        lines.append(line)
        if lines.count > 6 { lines.removeFirst(lines.count - 6) }
    }
}
