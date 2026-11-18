import Foundation

// Live voice call engine shared by the macOS desktop shell and the iPhone app
// (plan A, 2026-11-16, docs/realtime-voice-plan-20261116.md). This file is the
// turn-taking state machine only — Foundation, no audio frameworks — so the
// offline Swift suite (ios/Tests/VoiceCallTests.swift) drives it with a fake
// audio layer and a manual clock. SystemVoiceCallAudio.swift is the real
// microphone / recognizer / playback layer.
//
// Rules: an utterance ends after `endpoint` seconds without a transcript change
// (longer while the energy detector still hears speech, never more than three
// endpoints); a final transcript or `utteranceLimit` ends it at once. While the
// call is speaking, the user interrupts it by talking: a transcript that is not
// the echo of what is being said, or speech energy lasting `bargeIn` seconds.
// Without echo cancellation nothing the microphone hears during playback counts
// (half duplex); the user taps to interrupt. All calls happen on the main thread.

// MARK: Timing

/// Call timings (shared/protocol/agent-loop.json → voiceTurn.timing).
struct VoiceCallTiming: Equatable {
    var endpoint: TimeInterval = 0.8
    var bargeIn: TimeInterval = 0.25
    var utteranceLimit: TimeInterval = 60
    var echoTail: TimeInterval = 1.2
    var echoSimilarity: Double = 0.6

    init() {}

    /// From the milliseconds the contract and the desktop page carry. Missing or
    /// invalid values keep the defaults; the end-of-speech wait is clamped.
    init(endpointMs: Double?, bargeInMs: Double? = nil, utteranceLimitMs: Double? = nil, echoTailMs: Double? = nil,
         echoSimilarity: Double? = nil, endpointRangeMs: ClosedRange<Double> = 400...2000) {
        func seconds(_ value: Double?, _ fallback: TimeInterval) -> TimeInterval {
            guard let value, value.isFinite, value > 0 else { return fallback }
            return value / 1000
        }
        if let endpointMs, endpointMs.isFinite { endpoint = min(endpointRangeMs.upperBound, max(endpointRangeMs.lowerBound, endpointMs)) / 1000 }
        bargeIn = seconds(bargeInMs, bargeIn)
        utteranceLimit = seconds(utteranceLimitMs, utteranceLimit)
        echoTail = seconds(echoTailMs, echoTail)
        if let echoSimilarity, echoSimilarity.isFinite, echoSimilarity > 0, echoSimilarity <= 1 { self.echoSimilarity = echoSimilarity }
    }
}

// MARK: Clock

protocol VoiceCallCancellable: AnyObject { func cancel() }
extension DispatchWorkItem: VoiceCallCancellable {}

protocol VoiceCallScheduling: AnyObject {
    var now: TimeInterval { get }
    func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) -> VoiceCallCancellable
}

final class MainQueueVoiceCallScheduling: VoiceCallScheduling {
    var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
    func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) -> VoiceCallCancellable {
        let item = DispatchWorkItem(block: work)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        return item
    }
}

// MARK: Audio layer

struct VoiceCallClip: Equatable {
    enum Source: Equatable {
        /// Encoded audio (mp3 / wav) synthesized elsewhere, e.g. the desktop server.
        case audio(Data, mimeType: String)
        /// Rendered on the device by the system voice (name or identifier, BCP-47 language).
        case speech(voice: String?, language: String?)
    }
    let id: String
    /// What the clip says: spoken by `.speech`, compared with the microphone to recognize echo.
    let text: String
    let source: Source
    var answerTurn: String? = nil
}

enum VoiceCallAudioEvent: Equatable {
    case ready(echoCancellation: Bool, onDevice: Bool)
    case transcript(String, final: Bool)
    case voiceActivity(Bool)
    case playbackStarted(String)
    case playbackFinished(String)
    case playbackFailed(String, reason: String)
    case failure(String, recoverable: Bool)
}

protocol VoiceCallAudio: AnyObject {
    func start(locale: String, receive: @escaping (VoiceCallAudioEvent) -> Void)
    /// Ends the current recognition request and opens a new one (next utterance).
    func restartRecognition()
    func play(_ clip: VoiceCallClip)
    /// Drops the clip being played and every queued clip; no finished events follow.
    func stopPlayback()
    func setMuted(_ muted: Bool)
    func stop()
}

// MARK: Snapshot

struct VoiceCallSnapshot: Equatable {
    var sessionID = ""
    /// idle · starting · listening · hearing · speaking · ended · failed
    var phase = "idle"
    var partial = ""
    var muted = false
    var echoCancellation = true
    var onDeviceRecognition = false
    var error = ""
    /// A condition the interface explains in its own language: "half-duplex".
    var noticeCode = ""
    var active: Bool { ["starting", "listening", "hearing", "speaking"].contains(phase) }
}

// MARK: Echo

enum VoiceCallText {
    /// Lower-cased characters without whitespace, punctuation or symbols.
    static func normalized(_ text: String) -> [Character] {
        let dropped = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters).union(.symbols)
        return Array(text.lowercased()).filter { character in !character.unicodeScalars.allSatisfy { dropped.contains($0) } }
    }

    /// True when `heard` is (most likely) the microphone picking up `spoken`:
    /// contained in one of them, or sharing at least `threshold` of its
    /// character pairs. `shortIsEcho` treats a single heard character as echo
    /// (used while playback runs; a lone character is noise more often than speech).
    static func isEcho(_ heard: String, of spoken: [String], threshold: Double, shortIsEcho: Bool) -> Bool {
        let probe = normalized(heard)
        guard !spoken.isEmpty, !probe.isEmpty else { return false }
        if probe.count < 2 { return shortIsEcho || spoken.contains { normalized($0).contains(probe[0]) } }
        let probeText = String(probe)
        let pairs = zip(probe, probe.dropFirst()).map { String([$0, $1]) }
        for candidate in spoken {
            let said = normalized(candidate)
            guard !said.isEmpty else { continue }
            if String(said).contains(probeText) { return true }
            let saidPairs = Set(zip(said, said.dropFirst()).map { String([$0, $1]) })
            let shared = pairs.filter { saidPairs.contains($0) }.count
            if Double(shared) / Double(pairs.count) >= threshold { return true }
        }
        return false
    }
}

// MARK: Energy

/// Speech start / stop from buffer levels (dBFS), measured after the voice
/// processing unit removed most of the echo. While playback runs the onset is
/// stricter, because what echo remains still reaches the microphone.
struct VoiceCallEnergyDetector {
    private(set) var speaking = false
    private(set) var noiseFloor = -60.0
    private var above = 0
    private var below = 0
    var onsetMargin = 12.0
    var playbackOnsetMargin = 18.0
    var offsetMargin = 6.0
    var absoluteOnset = -50.0
    var onsetBuffers = 3
    var playbackOnsetBuffers = 6
    var offsetBuffers = 15

    /// Feeds one buffer level; returns the new state when it changed.
    mutating func feed(level: Double, playing: Bool) -> Bool? {
        guard level.isFinite else { return nil }
        if speaking {
            below = level < noiseFloor + offsetMargin ? below + 1 : 0
            guard below >= offsetBuffers else { return nil }
            speaking = false; below = 0; above = 0
            return false
        }
        let onset = max(noiseFloor + (playing ? playbackOnsetMargin : onsetMargin), absoluteOnset)
        if level > onset { above += 1 } else {
            above = 0
            // Follow the room slowly; loud bursts cannot lift the floor above -20 dBFS.
            noiseFloor = noiseFloor * 0.95 + min(level, -20) * 0.05
        }
        guard above >= (playing ? playbackOnsetBuffers : onsetBuffers) else { return nil }
        speaking = true; above = 0; below = 0
        return true
    }

    /// RMS level of float samples in dBFS.
    static func level(_ samples: UnsafeBufferPointer<Float>) -> Double {
        guard !samples.isEmpty else { return -160 }
        var sum: Double = 0
        for sample in samples { sum += Double(sample) * Double(sample) }
        return 20 * log10(max(sqrt(sum / Double(samples.count)), 1e-8))
    }
}

// MARK: Call

final class VoiceCall {
    private(set) var state = VoiceCallSnapshot()
    var onUpdate: ((VoiceCallSnapshot) -> Void)?
    /// A finished user utterance (trimmed, never empty).
    var onUtterance: ((String) -> Void)?
    /// Playback was cut because the user started talking (or tapped interrupt).
    var onBargeIn: (() -> Void)?
    /// Every clip handed to `speak` has finished or failed.
    var onPlaybackIdle: (() -> Void)?
    var onClipFinished: ((String) -> Void)?
    var onClipFailed: ((String, String) -> Void)?

    var onMetric: ((Int, String, Int) -> Void)?
    var isStopPhrase: (String) -> Bool = { _ in false }
    private var metricTurn = ""
    private var metricSequence = 0
    private var metricStart: TimeInterval = 0
    private var measured: Set<String> = []
    private var lastVoiceEnd: TimeInterval?
    private var measureVoiceEnd = false
    private(set) var utteranceNumber = 0
    private var commits: [(id: Int, committed: TimeInterval, voiceEnd: TimeInterval?)] = []
    private var voiceOnset: TimeInterval?
    private let audio: VoiceCallAudio
    private let scheduler: VoiceCallScheduling
    private(set) var timing: VoiceCallTiming
    private var activeID: String?
    private var endpointTimer: VoiceCallCancellable?
    private var limitTimer: VoiceCallCancellable?
    private var bargeInTimer: VoiceCallCancellable?
    private var endpointExtendedAt: TimeInterval?
    private var userSpeaking = false
    private var queued: [VoiceCallClip] = []
    private var submitted: Set<String> = []
    private var playing: VoiceCallClip?
    private var recentlySpoken: [(text: String, until: TimeInterval)] = []
    private var lastEchoRestart: TimeInterval = -.infinity
    private var recoveries: [TimeInterval] = []

    init(audio: VoiceCallAudio, timing: VoiceCallTiming = VoiceCallTiming(), scheduler: VoiceCallScheduling = MainQueueVoiceCallScheduling()) {
        self.audio = audio
        self.timing = timing
        self.scheduler = scheduler
    }

    var isSpeaking: Bool { !queued.isEmpty }

    func start(id: String = UUID().uuidString, locale: String) {
        guard activeID == nil else { return }
        activeID = id
        state = VoiceCallSnapshot(sessionID: id, phase: "starting")
        publish()
        audio.start(locale: locale) { [weak self] event in self?.receive(event, id: id) }
    }

    /// Hang up: microphone, recognizer and playback stop; late audio events are ignored.
    func end() {
        guard activeID != nil else { return }
        finish(phase: "ended")
    }

    func setMuted(_ muted: Bool) {
        guard activeID != nil, state.muted != muted else { return }
        state.muted = muted
        if muted {
            endpointTimer?.cancel(); limitTimer?.cancel(); cancelBargeIn()
            endpointExtendedAt = nil
            state.partial = ""
            if state.phase == "hearing" { state.phase = isSpeaking ? "speaking" : "listening" }
        }
        audio.setMuted(muted)
        if !muted { audio.restartRecognition() }
        publish()
    }

    func updateTiming(_ next: VoiceCallTiming) { timing = next }

    /// Hosts only mark the turn that owns a reply. Metrics carry elapsed time and a
    /// local sequence number; the chat, recognized words and audio stay out of logs.
    func mark(_ stage: String, turn: String, utterance: Int? = nil) {
        guard activeID != nil, !turn.isEmpty else { return }
        if stage == "voiceTurn" || stage == "typedTurn" {
            metricTurn = turn
            metricSequence += 1
            measured.removeAll()
            let commit = stage == "voiceTurn" ? commits.first { $0.id == (utterance ?? utteranceNumber) } : nil
            metricStart = commit?.committed ?? scheduler.now
            if let end = commit?.voiceEnd, end <= metricStart {
                onMetric?(metricSequence, "voiceEndToCommit", milliseconds(metricStart - end))
            }
        }
        guard metricTurn == turn, measured.insert(stage).inserted else { return }
        onMetric?(metricSequence, stage, milliseconds(scheduler.now - metricStart))
    }

    private func milliseconds(_ time: TimeInterval) -> Int { Int((max(0, time) * 1000).rounded()) }

    func speak(_ clip: VoiceCallClip) {
        guard activeID != nil, state.active else { return }
        queued.append(clip)
        submitAvailable()
    }

    private func submitAvailable() {
        while submitted.count < 2, let clip = queued.first(where: { !submitted.contains($0.id) }) {
            submitted.insert(clip.id)
            if let turn = clip.answerTurn { mark("submitted", turn: turn) }
            audio.play(clip)
        }
    }

    /// Stops playback without treating it as an interruption by the user.
    func stopSpeaking() {
        guard activeID != nil, isSpeaking else { return }
        dropPlayback()
        if state.phase == "speaking" { state.phase = "listening" }
        publish()
        onPlaybackIdle?()
    }

    /// The user tapped "interrupt" (the only way in half-duplex calls).
    func interrupt() {
        guard activeID != nil, isSpeaking else { return }
        bargeIn()
    }

    // MARK: Events

    private func receive(_ event: VoiceCallAudioEvent, id: String) {
        guard activeID == id else { return }
        switch event {
        case .ready(let echoCancellation, let onDevice):
            if state.phase == "starting" { state.phase = isSpeaking ? "speaking" : "listening" }
            state.echoCancellation = echoCancellation
            state.onDeviceRecognition = onDevice
            state.noticeCode = echoCancellation ? "" : "half-duplex"
            publish()
        case .transcript(let raw, let final):
            heard(raw.trimmingCharacters(in: .whitespacesAndNewlines), final: final)
        case .voiceActivity(let speaking):
            if speaking {
                voiceOnset = scheduler.now
                measureVoiceEnd = true
                lastVoiceEnd = nil
            } else if userSpeaking {
                if measureVoiceEnd { lastVoiceEnd = scheduler.now }
                voiceOnset = nil
            }
            userSpeaking = speaking
            if !speaking { cancelBargeIn() }
            else if isSpeaking, state.echoCancellation, !state.muted, state.phase == "speaking" { armBargeIn() }
        case .playbackStarted(let clipID):
            guard submitted.contains(clipID), let clip = queued.first(where: { $0.id == clipID }) else { return }
            playing = clip
            if let turn = clip.answerTurn { mark("firstBuffer", turn: turn) }
            if state.phase == "listening" { state.phase = "speaking"; publish() }
        case .playbackFinished(let clipID):
            guard clipEnded(clipID) else { return }
            onClipFinished?(clipID)
        case .playbackFailed(let clipID, let reason):
            guard clipEnded(clipID) else { return }
            onClipFailed?(clipID, reason)
        case .failure(let message, let recoverable):
            if recoverable, allowRecovery() {
                let words = state.partial
                if !words.isEmpty { commit() } else { audio.restartRecognition() }
                if words.isEmpty { publish() }
            } else {
                finish(phase: "failed", error: message)
            }
        }
    }

    private func heard(_ text: String, final: Bool) {
        guard !state.muted, state.phase != "starting" else { return }
        guard !text.isEmpty else {
            if final, state.phase == "hearing" { commit() }
            return
        }
        if isSpeaking {
            // Half duplex: what the microphone hears while Melo talks is Melo.
            guard state.echoCancellation else { return }
            let audible = (playing.map { [$0.text] } ?? []) + echoTail()
            let confirmedStop = (final || userSpeaking) && isStopPhrase(text)
            if VoiceCallText.isEcho(text, of: audible, threshold: timing.echoSimilarity, shortIsEcho: !confirmedStop) {
                discardEchoWords()
                return
            }
            bargeIn()
        } else if state.phase != "hearing", VoiceCallText.isEcho(text, of: echoTail(), threshold: timing.echoSimilarity, shortIsEcho: false) {
            // The last words of a clip that just ended, still in the room.
            discardEchoWords()
            return
        }
        state.partial = text
        if state.phase != "hearing" { state.phase = "hearing"; armUtteranceLimit() }
        if final { commit(); return }
        armEndpoint()
        publish()
    }

    // MARK: Utterance

    private func armEndpoint() {
        endpointTimer?.cancel()
        // New words: any extension granted for the previous silence starts over.
        endpointExtendedAt = nil
        endpointTimer = scheduler.schedule(after: timing.endpoint) { [weak self] in self?.endpointElapsed() }
    }

    private func endpointElapsed() {
        guard activeID != nil, state.phase == "hearing" else { return }
        if userSpeaking, !state.partial.isEmpty {
            let now = scheduler.now
            let since = endpointExtendedAt ?? now
            endpointExtendedAt = since
            if now - since < timing.endpoint * 2 {
                endpointTimer = scheduler.schedule(after: timing.endpoint / 2) { [weak self] in self?.endpointElapsed() }
                return
            }
        }
        commit()
    }

    private func armUtteranceLimit() {
        limitTimer?.cancel()
        limitTimer = scheduler.schedule(after: timing.utteranceLimit) { [weak self] in
            guard let self, self.activeID != nil, self.state.phase == "hearing" else { return }
            self.commit()
        }
    }

    private func commit() {
        endpointTimer?.cancel(); limitTimer?.cancel()
        endpointExtendedAt = nil
        let text = state.partial
        state.partial = ""
        state.phase = isSpeaking ? "speaking" : "listening"
        audio.restartRecognition()
        publish()
        if !text.isEmpty {
            utteranceNumber += 1
            commits.append((utteranceNumber, scheduler.now, lastVoiceEnd))
            if commits.count > 8 { commits.removeFirst() }
            measureVoiceEnd = false
            onUtterance?(text)
            lastVoiceEnd = nil
        }
    }

    // MARK: Playback

    private func armBargeIn() {
        guard bargeInTimer == nil else { return }
        bargeInTimer = scheduler.schedule(after: timing.bargeIn) { [weak self] in
            guard let self else { return }
            self.bargeInTimer = nil
            guard self.activeID != nil, self.userSpeaking, self.isSpeaking, !self.state.muted, self.state.echoCancellation else { return }
            self.bargeIn()
        }
    }

    private func cancelBargeIn() { bargeInTimer?.cancel(); bargeInTimer = nil }

    private func bargeIn() {
        let start = voiceOnset ?? scheduler.now
        let stage = voiceOnset == nil ? "interruptToStop" : "voiceOnsetToStop"
        dropPlayback()
        onMetric?(metricSequence, stage, milliseconds(scheduler.now - start))
        state.phase = "hearing"
        // No words may follow (a cough): the endpoint then returns to listening.
        armEndpoint()
        armUtteranceLimit()
        publish()
        onBargeIn?()
    }

    private func dropPlayback() {
        cancelBargeIn()
        retainEchoTail()
        submitted.removeAll()
        queued.removeAll()
        audio.stopPlayback()
    }

    private func retainEchoTail() {
        recentlySpoken.removeAll { $0.until < scheduler.now }
        if let clip = playing { recentlySpoken.append((clip.text, scheduler.now + timing.echoTail)) }
        playing = nil
    }

    private func clipEnded(_ clipID: String) -> Bool {
        guard submitted.remove(clipID) != nil, let index = queued.firstIndex(where: { $0.id == clipID }) else { return false }
        queued.remove(at: index)
        if playing?.id == clipID { retainEchoTail() }
        if !queued.isEmpty { submitAvailable(); return true }
        cancelBargeIn()
        if state.phase == "speaking" { state.phase = "listening"; publish() }
        onPlaybackIdle?()
        return true
    }

    private func echoTail() -> [String] {
        let now = scheduler.now
        recentlySpoken.removeAll { $0.until < now }
        return recentlySpoken.map(\.text)
    }

    /// Echo words sit in the recognizer's running transcript; start a clean one
    /// (at most once a second) so the user's next words are not glued to them.
    private func discardEchoWords() {
        let now = scheduler.now
        guard now - lastEchoRestart >= 1 else { return }
        lastEchoRestart = now
        audio.restartRecognition()
    }

    private func allowRecovery() -> Bool {
        let now = scheduler.now
        recoveries = recoveries.filter { now - $0 < 30 } + [now]
        return recoveries.count <= 5
    }

    private func finish(phase: String, error: String = "") {
        activeID = nil
        endpointTimer?.cancel(); limitTimer?.cancel(); cancelBargeIn()
        endpointTimer = nil; limitTimer = nil
        endpointExtendedAt = nil
        queued.removeAll(); submitted.removeAll(); recentlySpoken.removeAll(); playing = nil
        recoveries.removeAll(); lastEchoRestart = -.infinity
        commits.removeAll(); measureVoiceEnd = false; voiceOnset = nil; lastVoiceEnd = nil; metricTurn = ""; measured.removeAll()
        userSpeaking = false
        audio.stop()
        state.phase = phase
        state.partial = ""
        state.error = error
        publish()
    }

    private func publish() { onUpdate?(state) }
}
