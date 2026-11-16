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
    private var readMessageIDs: Set<String> = []
    private var awaitingTurn = false
    private var repliedSinceSend = false
    private var turnLanguage = "zh"
    private var toolPhraseSpoken = false
    private var promptPhraseSpoken = false
    private var recognitionLanguage = "system"
    private var clipNumber = 0

    var active: Bool { state.active }

    func start(chatID: String, store: ChatStore, locale: String, endpointMs: Double?) {
        end()
        guard let chat = store.chats.first(where: { $0.id == chatID }) else { return }
        self.store = store
        self.chatID = chatID
        recognitionLanguage = locale
        // Replies written before the call are never read out.
        readMessageIDs = Set(chat.messages.map(\.id))
        lines = []; thinking = store.isSending(chatID); message = ""
        awaitingTurn = false; toolPhraseSpoken = false; promptPhraseSpoken = false
        LocalDeviceServices.shared.stopSpeech()
        LocalDeviceServices.shared.callActive = true
        let call = VoiceCall(audio: SystemVoiceCallAudio(), timing: VoiceTurnRules.timing(endpointMs: endpointMs))
        call.onUpdate = { [weak self] snapshot in self?.update(snapshot) }
        call.onUtterance = { [weak self] text in self?.heard(text) }
        call.onClipFailed = { [weak self] _, reason in self?.message = reason }
        self.call = call
        // Published values arrive before the change is stored; read the store on the next turn of the run loop.
        store.$chats.receive(on: RunLoop.main).sink { [weak self] _ in self?.messagesChanged() }.store(in: &observers)
        store.$sendingChats.receive(on: RunLoop.main).sink { [weak self] _ in self?.replyStateChanged() }.store(in: &observers)
        store.$executionRecords.receive(on: RunLoop.main).sink { [weak self] _ in self?.progressChanged() }.store(in: &observers)
        store.$pendingDeviceAction.combineLatest(store.$pendingCapabilityRequest).receive(on: RunLoop.main)
            .sink { [weak self] action, request in self?.promptChanged(action != nil || request != nil) }.store(in: &observers)
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
        store.send(text, chatID: chatID, voiceTurn: true) { [weak self] reason in
            guard let self else { return }
            self.message = reason
            self.say(VoiceTurnRules.phrase("failed", language: language))
        }
        if store.isSending(chatID) { awaitingTurn = true; thinking = true }
    }

    /// Every reply saved in this conversation during the call is read once, as
    /// soon as it is saved (a follow-up for unused supplements included).
    private func messagesChanged() {
        guard active, let store else { return }
        guard let chat = store.chats.first(where: { $0.id == chatID }) else { end(); return }
        for reply in chat.messages where reply.role == "assistant" && !readMessageIDs.contains(reply.id) {
            readMessageIDs.insert(reply.id)
            guard !PhoneToolTrace.isTrace(reply) else { continue }
            repliedSinceSend = true
            read(reply.content)
        }
    }

    private func replyStateChanged() {
        guard active, let store else { return }
        let sending = store.isSending(chatID)
        thinking = sending
        guard !sending else { return }
        toolPhraseSpoken = false; promptPhraseSpoken = false
        if awaitingTurn, !repliedSinceSend {
            // Stopped, failed or interrupted without an answer: the reason is on the screen.
            say(VoiceTurnRules.phrase("failed", language: turnLanguage))
        }
        awaitingTurn = false
    }

    private func progressChanged() {
        guard active, awaitingTurn, !toolPhraseSpoken, let store, store.isSending(chatID), call?.isSpeaking == false,
              store.scenes(for: chatID).last?.toolCalls?.isEmpty == false else { return }
        toolPhraseSpoken = true
        say(VoiceTurnRules.phrase("tools", language: turnLanguage))
    }

    private func promptChanged(_ waiting: Bool) {
        guard active else { return }
        guard waiting else { promptPhraseSpoken = false; return }
        guard !promptPhraseSpoken else { return }
        promptPhraseSpoken = true
        say(VoiceTurnRules.phrase("approval", language: turnLanguage))
    }

    // MARK: Speaking

    private func read(_ reply: String) {
        let speech = VoiceTurnRules.speech(from: reply)
        guard !speech.sentences.isEmpty else { return }
        remember(Line(fromUser: false, text: speech.text))
        let voiceLanguage = SpeechText.voiceLanguage(for: speech.text, preference: recognitionLanguage)
        for sentence in speech.sentences { enqueue(sentence, language: voiceLanguage) }
    }

    private func say(_ phrase: String) {
        guard !phrase.isEmpty else { return }
        enqueue(phrase, language: SpeechText.voiceLanguage(for: phrase, preference: recognitionLanguage))
    }

    private func enqueue(_ text: String, language: String) {
        clipNumber += 1
        call?.speak(VoiceCallClip(id: "clip-\(clipNumber)", text: text, source: .speech(voice: nil, language: language)))
    }

    private func remember(_ line: Line) {
        lines.append(line)
        if lines.count > 6 { lines.removeFirst(lines.count - 6) }
    }
}
