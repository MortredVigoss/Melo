import Foundation

// Live voice call (plan A, 2026-11-16): the shared turn-taking engine with a
// fake audio layer and a manual clock, the energy detector, echo matching, and
// the iPhone rules against the contract fixtures the desktop test also runs.

final class FakeCallAudio: VoiceCallAudio {
    var receive: ((VoiceCallAudioEvent) -> Void)?
    var starts = 0, restarts = 0, stopPlaybacks = 0, stops = 0
    var played: [VoiceCallClip] = []
    var muted: [Bool] = []
    func start(locale: String, receive: @escaping (VoiceCallAudioEvent) -> Void) { starts += 1; self.receive = receive }
    func restartRecognition() { restarts += 1 }
    func play(_ clip: VoiceCallClip) { played.append(clip) }
    func stopPlayback() { stopPlaybacks += 1 }
    func setMuted(_ muted: Bool) { self.muted.append(muted) }
    func stop() { stops += 1 }
    func send(_ event: VoiceCallAudioEvent) { receive?(event) }
}

final class ManualClock: VoiceCallScheduling {
    final class Item: VoiceCallCancellable {
        let due: TimeInterval; let work: () -> Void; var cancelled = false
        init(due: TimeInterval, work: @escaping () -> Void) { self.due = due; self.work = work }
        func cancel() { cancelled = true }
    }
    private(set) var now: TimeInterval = 100
    private var items: [Item] = []
    func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) -> VoiceCallCancellable {
        let item = Item(due: now + delay, work: work); items.append(item); return item
    }
    func advance(_ seconds: TimeInterval) {
        let target = now + seconds
        while let next = items.filter({ !$0.cancelled && $0.due <= target }).min(by: { $0.due < $1.due }) {
            now = next.due
            items.removeAll { $0 === next }
            next.work()
        }
        now = target
        items.removeAll { $0.cancelled }
    }
}

func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    if !condition() { fatalError("VoiceCallTests line \(line): \(message)") }
}

struct Harness {
    let audio = FakeCallAudio()
    let clock = ManualClock()
    let call: VoiceCall
    var utterances: [String] { box.utterances }
    var bargeIns: Int { box.bargeIns }
    var idles: Int { box.idles }
    final class Box { var utterances: [String] = []; var bargeIns = 0; var idles = 0; var failed: [String] = [] }
    let box = Box()
    init(echoCancellation: Bool = true) {
        call = VoiceCall(audio: audio, timing: VoiceCallTiming(), scheduler: clock)
        let box = self.box
        call.onUtterance = { box.utterances.append($0) }
        call.onBargeIn = { box.bargeIns += 1 }
        call.onPlaybackIdle = { box.idles += 1 }
        call.onClipFailed = { id, _ in box.failed.append(id) }
        call.start(id: "call", locale: "zh-CN")
        audio.send(.ready(echoCancellation: echoCancellation, onDevice: true))
    }
    func clip(_ id: String, _ text: String) -> VoiceCallClip { VoiceCallClip(id: id, text: text, source: .speech(voice: nil, language: "zh-CN")) }
}

@main struct VoiceCallTests {
    static func main() {
        endpointing()
        bargeInAndEcho()
        halfDuplexAndMute()
        failuresAndHangUp()
        energyDetector()
        echoMatching()
        timingClamp()
        contractFixtures()
        print("Voice call passed: endpointing, barge-in, echo filtering, half duplex, mute, failures, hang-up, energy detector, timings, \(fixtureCount) contract fixtures")
    }

    static var fixtureCount = 0

    static func endpointing() {
        let h = Harness()
        check(h.call.state.phase == "listening" && h.audio.starts == 1, "ready → listening")
        h.audio.send(.transcript("明天", final: false))
        check(h.call.state.phase == "hearing" && h.call.state.partial == "明天", "partial → hearing")
        h.clock.advance(0.5)
        h.audio.send(.transcript("明天天气怎么样", final: false))
        h.clock.advance(0.7)
        check(h.utterances.isEmpty, "a changing transcript restarts the end-of-speech wait")
        h.clock.advance(0.2)
        check(h.utterances == ["明天天气怎么样"] && h.call.state.phase == "listening" && h.audio.restarts == 1, "0.8 s without change ends the utterance and opens a new request")
        // Energy still above the floor: wait up to three endpoints in total, then commit anyway.
        h.audio.send(.voiceActivity(true))
        h.audio.send(.transcript("还有", final: false))
        h.clock.advance(0.8)
        check(h.utterances.count == 1, "still speaking: the wait is extended")
        h.clock.advance(1.7) // three endpoints after the last change, plus clock rounding
        check(h.utterances.count == 2 && h.utterances[1] == "还有", "the extension is bounded")
        h.audio.send(.voiceActivity(false))
        // A final transcript ends the utterance at once.
        h.audio.send(.transcript("好的", final: true))
        check(h.utterances.last == "好的" && h.audio.restarts == 3, "final transcript commits immediately")
        // The one-minute limit ends a never-ending utterance.
        h.audio.send(.voiceActivity(true))
        for second in 0..<60 { h.audio.send(.transcript("一直在说话\(second)", final: false)); h.clock.advance(1) }
        check(h.utterances.count == 4 && h.utterances[3].hasPrefix("一直在说话"), "the utterance limit commits")
        // An empty final transcript after a cough does not send anything.
        h.audio.send(.voiceActivity(false))
        let before = h.utterances.count
        h.audio.send(.transcript("", final: true))
        check(h.utterances.count == before, "empty transcripts are not utterances")
    }

    static func bargeInAndEcho() {
        let h = Harness()
        h.call.speak(h.clip("a", "好的，明天上午十点提醒你开会。"))
        check(h.audio.played.count == 1, "clip handed to the audio layer")
        h.audio.send(.playbackStarted("a"))
        check(h.call.state.phase == "speaking", "playback → speaking")
        // The microphone hears Melo: ignored, and the recognizer is cleared once.
        h.audio.send(.transcript("明天上午十点", final: false))
        h.audio.send(.transcript("明天上午十点提醒你", final: false))
        check(h.call.state.phase == "speaking" && h.bargeIns == 0 && h.audio.restarts == 1, "echo is ignored; one clean restart per second")
        // The user talks over it.
        h.audio.send(.transcript("等一下换成下午", final: false))
        check(h.bargeIns == 1 && h.audio.stopPlaybacks == 1 && h.call.state.phase == "hearing", "non-echo words interrupt playback")
        check(!h.call.isSpeaking, "the queue is dropped")
        h.audio.send(.playbackFinished("a"))
        check(h.idles == 0, "a finished event after the interruption is stale")
        h.clock.advance(0.8)
        check(h.utterances == ["等一下换成下午"], "the interrupting words become the next utterance")
        // Energy barge-in needs bargeIn seconds of speech; a short burst does nothing.
        h.call.speak(h.clip("b", "下午三点可以吗"))
        h.audio.send(.playbackStarted("b"))
        h.audio.send(.voiceActivity(true))
        h.clock.advance(0.1)
        h.audio.send(.voiceActivity(false))
        h.clock.advance(0.5)
        check(h.bargeIns == 1 && h.call.isSpeaking, "a short burst is not an interruption")
        h.audio.send(.voiceActivity(true))
        h.clock.advance(0.3)
        check(h.bargeIns == 2 && h.audio.stopPlaybacks == 2 && h.call.state.phase == "hearing", "sustained speech interrupts")
        // No words follow: back to listening, nothing sent.
        h.audio.send(.voiceActivity(false))
        h.clock.advance(1)
        check(h.call.state.phase == "listening" && h.utterances.count == 1, "a cough sends nothing")
        // Echo tail: the last words of a finished clip are ignored for a moment, then accepted.
        h.call.speak(h.clip("c", "已经改到下午三点了"))
        h.audio.send(.playbackStarted("c"))
        h.audio.send(.playbackFinished("c"))
        check(h.idles == 1 && h.call.state.phase == "listening", "idle after the last clip")
        h.audio.send(.transcript("下午三点了", final: false))
        check(h.call.state.phase == "listening", "echo tail ignored")
        h.clock.advance(1.5)
        h.audio.send(.transcript("下午三点了", final: false))
        check(h.call.state.phase == "hearing", "after the tail the same words are the user's")
        h.clock.advance(1)
        // stopSpeaking (a new reply) is not an interruption by the user.
        h.call.speak(h.clip("d", "第一句"))
        h.call.speak(h.clip("e", "第二句"))
        h.audio.send(.playbackStarted("d"))
        h.call.stopSpeaking()
        check(h.bargeIns == 2 && h.idles == 2 && h.audio.stopPlaybacks == 3 && h.call.state.phase == "listening", "stopSpeaking drops the queue without a barge-in")
        // A failed clip still empties the queue.
        h.call.speak(h.clip("f", "第三句"))
        h.audio.send(.playbackFailed("f", reason: "decode"))
        check(h.box.failed == ["f"] && h.idles == 3, "failed clips are reported and end playback")
    }

    static func halfDuplexAndMute() {
        let h = Harness(echoCancellation: false)
        check(h.call.state.noticeCode == "half-duplex", "no echo cancellation is explained")
        h.call.speak(h.clip("a", "这是 Melo 在说话"))
        h.audio.send(.playbackStarted("a"))
        h.audio.send(.transcript("完全不同的话", final: false))
        h.audio.send(.voiceActivity(true))
        h.clock.advance(1)
        check(h.bargeIns == 0 && h.call.isSpeaking && h.utterances.isEmpty, "half duplex ignores the microphone during playback")
        h.call.interrupt()
        check(h.bargeIns == 1 && h.audio.stopPlaybacks == 1, "tap to interrupt")
        h.audio.send(.voiceActivity(false))
        h.clock.advance(1)
        // Mute: nothing heard counts; unmuting opens a clean request.
        h.call.setMuted(true)
        h.audio.send(.transcript("静音时说的话", final: true))
        check(h.utterances.isEmpty && h.audio.muted == [true], "muted transcripts are ignored")
        let restarts = h.audio.restarts
        h.call.setMuted(false)
        check(h.audio.muted == [true, false] && h.audio.restarts == restarts + 1, "unmute restarts recognition")
    }

    static func failuresAndHangUp() {
        let h = Harness()
        h.audio.send(.transcript("说到一半", final: false))
        h.audio.send(.failure("网络断开", recoverable: true))
        check(h.utterances == ["说到一半"] && h.call.state.active, "a recoverable failure keeps the words")
        h.audio.send(.failure("麦克风被占用", recoverable: false))
        check(h.call.state.phase == "failed" && h.call.state.error == "麦克风被占用" && h.audio.stops == 1, "a fatal failure ends the call and stops the audio")
        let ended = Harness()
        ended.call.speak(ended.clip("a", "正在说"))
        ended.audio.send(.transcript("还没说完", final: false))
        ended.call.end()
        check(ended.call.state.phase == "ended" && ended.audio.stops == 1 && !ended.call.isSpeaking, "hang-up stops everything")
        // Late events from the old session change nothing.
        ended.audio.send(.transcript("挂断后", final: true))
        ended.audio.send(.playbackFinished("a"))
        ended.clock.advance(5)
        check(ended.utterances.isEmpty && ended.idles == 0 && ended.call.state.phase == "ended", "late events are ignored")
        ended.call.end()
        check(ended.audio.stops == 1, "a second hang-up does nothing")
        // Repeated recoverable failures become fatal.
        let flaky = Harness()
        for _ in 0..<6 { flaky.audio.send(.failure("断开", recoverable: true)) }
        check(flaky.call.state.phase == "failed", "more than five recoveries in 30 s end the call")
    }

    static func energyDetector() {
        var detector = VoiceCallEnergyDetector()
        for _ in 0..<40 { check(detector.feed(level: -70, playing: false) == nil, "silence") }
        check(detector.feed(level: -30, playing: false) == nil && detector.feed(level: -30, playing: false) == nil, "onset needs three buffers")
        check(detector.feed(level: -30, playing: false) == true && detector.speaking, "speech starts")
        for _ in 0..<14 { check(detector.feed(level: -70, playing: false) == nil, "offset needs fifteen quiet buffers") }
        check(detector.feed(level: -70, playing: false) == false, "speech stops")
        var playing = VoiceCallEnergyDetector()
        for _ in 0..<5 { check(playing.feed(level: -30, playing: true) == nil, "playback needs six buffers") }
        check(playing.feed(level: -30, playing: true) == true, "speech over playback")
        var loud = VoiceCallEnergyDetector()
        for _ in 0..<200 { _ = loud.feed(level: -10, playing: false) }
        check(loud.noiseFloor <= -20 || loud.speaking, "loud rooms cannot lift the floor past -20 dBFS")
        let samples: [Float] = Array(repeating: 0.5, count: 64)
        let level = samples.withUnsafeBufferPointer { VoiceCallEnergyDetector.level($0) }
        check(abs(level - (-6.0206)) < 0.01, "RMS level in dBFS")
    }

    static func echoMatching() {
        let spoken = ["好的，明天上午十点提醒你开会。"]
        check(VoiceCallText.isEcho("明天上午十点", of: spoken, threshold: 0.6, shortIsEcho: true), "contained")
        check(VoiceCallText.isEcho("明天上午时点提醒", of: spoken, threshold: 0.6, shortIsEcho: true), "near miss of the recognizer")
        check(!VoiceCallText.isEcho("等一下换成下午", of: spoken, threshold: 0.6, shortIsEcho: true), "different words")
        check(VoiceCallText.isEcho("嗯", of: spoken, threshold: 0.6, shortIsEcho: true), "one character during playback is noise")
        check(!VoiceCallText.isEcho("嗯", of: spoken, threshold: 0.6, shortIsEcho: false), "one character after playback is the user")
        check(!VoiceCallText.isEcho("hello", of: [], threshold: 0.6, shortIsEcho: true), "nothing spoken, nothing echoed")
        check(VoiceCallText.isEcho("Meeting at TEN.", of: ["The meeting is at ten tomorrow."], threshold: 0.6, shortIsEcho: true), "case and punctuation ignored")
    }

    static func timingClamp() {
        check(VoiceCallTiming(endpointMs: 100).endpoint == 0.4, "lower bound")
        check(VoiceCallTiming(endpointMs: 9000).endpoint == 2.0, "upper bound")
        check(VoiceCallTiming(endpointMs: .nan).endpoint == 0.8, "invalid keeps the default")
        check(VoiceCallTiming(endpointMs: nil, bargeInMs: -5).bargeIn == 0.25, "invalid barge-in keeps the default")
    }

    static func contractFixtures() {
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("shared/protocol/agent-loop.json")
        guard let data = try? Data(contentsOf: url),
              let file = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let fixtures = (file["fixtures"] as? [String: Any])?["voiceTurn"] as? [String: Any] else {
            fatalError("VoiceCallTests: run from the repository root; shared/protocol/agent-loop.json fixtures.voiceTurn is required")
        }
        for entry in fixtures["speech"] as? [[String: Any]] ?? [] {
            let text = entry["text"] as? String ?? ""
            let speech = VoiceTurnRules.speech(from: text)
            check(speech.sentences == (entry["sentences"] as? [String] ?? []), "speech sentences for \(text.prefix(30)): \(speech.sentences)")
            check(speech.condensed == (entry["condensed"] as? Bool ?? false), "speech condensed for \(text.prefix(30))")
            check(speech.language == (entry["language"] as? String ?? ""), "speech language for \(text.prefix(30))")
            fixtureCount += 1
        }
        for entry in fixtures["stop"] as? [[String: Any]] ?? [] {
            let text = entry["text"] as? String ?? ""
            check(VoiceTurnRules.isStopPhrase(text) == (entry["stop"] as? Bool ?? false), "stop phrase \(text)")
            fixtureCount += 1
        }
        for entry in fixtures["instruction"] as? [[String: Any]] ?? [] {
            let text = entry["text"] as? String ?? "", style = entry["style"] as? String ?? ""
            check(VoiceTurnRules.instruction(for: text, style: style) == (entry["expected"] as? String ?? ""), "instruction for \(text)")
            fixtureCount += 1
        }
        for entry in fixtures["timing"] as? [[String: Any]] ?? [] {
            let endpoint = (entry["endpointMs"] as? NSNumber)?.doubleValue
            let expected = (entry["expected"] as? NSNumber)?.doubleValue ?? -1
            check(abs(VoiceTurnRules.timing(endpointMs: endpoint).endpoint * 1000 - expected) < 0.5, "timing for \(String(describing: endpoint))")
            fixtureCount += 1
        }
        check(fixtureCount >= 20, "fixtures were read")
    }
}
