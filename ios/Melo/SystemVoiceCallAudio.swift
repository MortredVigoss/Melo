import Foundation
import AVFoundation
import Speech

// Microphone, recognizer and playback of a live voice call (plan A, 2026-11-16),
// shared by the macOS desktop shell and the iPhone app; the turn-taking rules
// are in VoiceCall.swift. One audio engine carries both directions: its input
// runs Apple's voice processing (echo cancellation, noise suppression) and the
// call's own playback goes through the same engine, so what Melo says is the
// echo reference and the user can talk over it. Recognition stays on the device
// whenever the recognizer supports that. Audio is never stored: decoded clips
// pass through a temporary file that is deleted as soon as it is read.

/// State the audio thread reads; every access holds the lock.
private final class VoiceCallTapState {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var muted = false
    private var playing = false
    private var detector = VoiceCallEnergyDetector()

    func set(request: SFSpeechAudioBufferRecognitionRequest?) { lock.lock(); self.request = request; lock.unlock() }
    func set(muted: Bool) { lock.lock(); self.muted = muted; detector = VoiceCallEnergyDetector(); lock.unlock() }
    func set(playing: Bool) { lock.lock(); self.playing = playing; lock.unlock() }

    /// Audio thread: feeds the recognizer, returns a speech start / stop change.
    func consume(_ buffer: AVAudioPCMBuffer) -> Bool? {
        lock.lock(); defer { lock.unlock() }
        guard !muted else { return nil }
        request?.append(buffer)
        guard let channel = buffer.floatChannelData?[0] else { return nil }
        let level = VoiceCallEnergyDetector.level(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
        return detector.feed(level: level, playing: playing)
    }
}

/// Converts a stream of buffers of one format to the playback format, keeping
/// the resampler state between chunks (no clicks at chunk boundaries).
private final class VoiceCallChunkConverter {
    private var converter: AVAudioConverter?
    private let output: AVAudioFormat
    init(output: AVAudioFormat) { self.output = output }

    func convert(_ buffer: AVAudioPCMBuffer, last: Bool = false) -> AVAudioPCMBuffer? {
        if buffer.format == output { return buffer }
        if converter == nil || converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: output) }
        guard let converter, buffer.frameLength > 0 else { return nil }
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 2048
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: converted, error: &error) { _, inputStatus in
            if supplied { inputStatus.pointee = last ? .endOfStream : .noDataNow; return nil }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        return status == .error || converted.frameLength == 0 ? nil : converted
    }
}

// Main-thread confined; the audio thread only touches VoiceCallTapState, which locks.
final class SystemVoiceCallAudio: NSObject, VoiceCallAudio, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let synthesizer = AVSpeechSynthesizer()
    private let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    private let decodeQueue = DispatchQueue(label: "com.melo.voice-call.decode", qos: .userInitiated)
    private let tap = VoiceCallTapState()
    private var receive: ((VoiceCallAudioEvent) -> Void)?
    private var session = UUID()
    private var locale = "system"
    private var running = false
    private var tapInstalled = false
    private var voiceProcessing = false
    private var observers: [NSObjectProtocol] = []
    #if os(iOS)
    private var audioSessionActive = false
    #endif
    // Recognition
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognitionToken = UUID()
    private var lastPartial = ""
    private var watchdog: DispatchWorkItem?
    private var recognitionErrors: [Date] = []
    // Playback
    private var queue: [VoiceCallClip] = []
    private var current: VoiceCallClip?
    private var playbackToken = UUID()
    private var currentScheduled = false
    private var currentClosing = false
    private var speechClips: [ObjectIdentifier: (clip: String, token: UUID)] = [:]
    private var speechTimeout: DispatchWorkItem?
    private var rebuilds: [Date] = []

    override init() {
        super.init()
        synthesizer.delegate = self
        #if os(iOS)
        // The call owns the application audio session; rendering must not open another one.
        synthesizer.usesApplicationAudioSession = true
        #endif
    }

    // MARK: Lifecycle

    func start(locale: String, receive: @escaping (VoiceCallAudioEvent) -> Void) {
        stop()
        let token = UUID()
        session = token
        self.locale = locale
        self.receive = receive
        SFSpeechRecognizer.requestAuthorization { [weak self] permission in
            DispatchQueue.main.async {
                guard let self, self.session == token else { return }
                guard permission == .authorized else {
                    self.emit(.failure("语音识别未获授权，请在系统设置中允许 Melo 使用语音识别。", recoverable: false)); return
                }
                AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                    DispatchQueue.main.async {
                        guard let self, self.session == token else { return }
                        guard granted else {
                            self.emit(.failure("麦克风未获授权，请在系统设置中允许 Melo 使用麦克风。", recoverable: false)); return
                        }
                        self.begin(token: token)
                    }
                }
            }
        }
    }

    private func begin(token: UUID) {
        let language = locale == "system" ? (Locale.preferredLanguages.first ?? Locale.current.identifier) : locale
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
            emit(.failure("当前语言的语音识别暂不可用，请检查网络或更换语言。", recoverable: false)); return
        }
        self.recognizer = recognizer
        do {
            #if os(iOS)
            let audioSession = AVAudioSession.sharedInstance()
            var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker]
            if #available(iOS 26.0, *) { options.insert(.allowBluetoothHFP) } else { options.insert(.allowBluetooth) }
            try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: options)
            try audioSession.setActive(true)
            audioSessionActive = true
            observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: audioSession, queue: .main) { [weak self] notification in
                guard let self, self.session == token,
                      let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
                self.emit(.failure("通话被系统打断（例如来电或其他应用占用了音频），已挂断。", recoverable: false))
            })
            #endif
            let input = engine.inputNode
            do { try input.setVoiceProcessingEnabled(true); voiceProcessing = true } catch { voiceProcessing = false }
            if voiceProcessing, #available(macOS 14.0, iOS 17.0, *) {
                // Keep music and other apps audible during the call.
                input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            }
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                teardown()
                emit(.failure("没有可用的麦克风，请检查输入设备。", recoverable: false)); return
            }
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
            let state = tap
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let change = state.consume(buffer) else { return }
                DispatchQueue.main.async {
                    guard let self, self.session == token else { return }
                    self.emit(.voiceActivity(change))
                }
            }
            tapInstalled = true
            engine.prepare()
            try engine.start()
            player.play()
            running = true
            observers.append(NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                guard let self, self.session == token else { return }
                self.configurationChanged(token: token)
            })
            startRecognition()
            emit(.ready(echoCancellation: voiceProcessing, onDevice: recognizer.supportsOnDeviceRecognition))
        } catch {
            teardown()
            emit(.failure("无法启动通话音频：\(error.localizedDescription)", recoverable: false))
        }
    }

    /// An input / output device came or went; the engine stopped. Clips in flight
    /// are reported failed and the audio graph is rebuilt once.
    private func configurationChanged(token: UUID) {
        let lost = (current.map { [$0] } ?? []) + queue
        resetPlayback()
        for clip in lost { emit(.playbackFailed(clip.id, reason: "音频设备发生变化")) }
        teardown()
        let now = Date()
        rebuilds = rebuilds.filter { now.timeIntervalSince($0) < 10 } + [now]
        guard rebuilds.count <= 3 else {
            emit(.failure("音频设备反复变化，通话已挂断，可以重新开始。", recoverable: false)); return
        }
        begin(token: token)
    }

    func stop() {
        session = UUID()
        resetPlayback()
        teardown()
        rebuilds = []
        receive = nil
    }

    private func teardown() {
        recognitionToken = UUID()
        watchdog?.cancel(); watchdog = nil
        tap.set(request: nil)
        tap.set(playing: false)
        request?.endAudio(); task?.cancel()
        request = nil; task = nil; recognizer = nil
        lastPartial = ""
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if engine.isRunning { player.stop(); engine.stop() }
        if engine.attachedNodes.contains(player) { engine.detach(player) }
        if voiceProcessing { try? engine.inputNode.setVoiceProcessingEnabled(false); voiceProcessing = false }
        running = false
        #if os(iOS)
        if audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioSessionActive = false
        }
        #endif
    }

    func setMuted(_ muted: Bool) {
        tap.set(muted: muted)
        if muted { lastPartial = "" }
    }

    // MARK: Recognition

    private func startRecognition() {
        guard running, let recognizer else { return }
        let token = UUID()
        recognitionToken = token
        lastPartial = ""
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        if #available(macOS 13.0, iOS 16.0, *) { request.addsPunctuation = true }
        self.request = request
        tap.set(request: request)
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.recognitionToken == token else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    self.lastPartial = result.isFinal ? "" : text
                    self.recognitionErrors.removeAll()
                    self.emit(.transcript(text, final: result.isFinal))
                    // The rules may already have opened the next request.
                    if result.isFinal, self.recognitionToken == token { self.restartRecognition() }
                }
                if let error, self.recognitionToken == token { self.recognitionFailed(error) }
            }
        }
        // Server recognition ends after about a minute; renew a quiet request before that.
        let renew = DispatchWorkItem { [weak self] in
            guard let self, self.recognitionToken == token else { return }
            if self.lastPartial.isEmpty { self.restartRecognition() } else { self.startWatchdogAgain(token) }
        }
        watchdog?.cancel()
        watchdog = renew
        DispatchQueue.main.asyncAfter(deadline: .now() + 50, execute: renew)
    }

    private func startWatchdogAgain(_ token: UUID) {
        let renew = DispatchWorkItem { [weak self] in
            guard let self, self.recognitionToken == token else { return }
            self.restartRecognition()
        }
        watchdog?.cancel()
        watchdog = renew
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: renew)
    }

    /// Silence timeouts and dropped connections end a request routinely: words
    /// already heard are kept as a final transcript and a new request opens.
    /// Only repeated failures in a short time end the call.
    private func recognitionFailed(_ error: Error) {
        let words = lastPartial
        let now = Date()
        recognitionErrors = recognitionErrors.filter { now.timeIntervalSince($0) < 10 } + [now]
        if recognitionErrors.count > 5 {
            emit(.failure("语音识别反复中断：\(error.localizedDescription)", recoverable: false)); return
        }
        let token = recognitionToken
        if !words.isEmpty { emit(.transcript(words, final: true)) }
        if running, recognitionToken == token { restartRecognition() }
    }

    func restartRecognition() {
        guard running else { return }
        recognitionToken = UUID()
        watchdog?.cancel(); watchdog = nil
        tap.set(request: nil)
        request?.endAudio(); task?.cancel()
        request = nil; task = nil
        startRecognition()
    }

    // MARK: Playback

    func play(_ clip: VoiceCallClip) {
        guard running else { emit(.playbackFailed(clip.id, reason: "通话音频没有运行")); return }
        queue.append(clip)
        playNext()
    }

    func stopPlayback() {
        resetPlayback()
        if running, engine.isRunning { player.play() }
    }

    private func resetPlayback() {
        playbackToken = UUID()
        queue.removeAll()
        current = nil
        currentScheduled = false
        currentClosing = false
        speechClips.removeAll()
        speechTimeout?.cancel(); speechTimeout = nil
        synthesizer.stopSpeaking(at: .immediate)
        if engine.isRunning { player.stop() }
        tap.set(playing: false)
    }

    private func playNext() {
        guard running, current == nil, !queue.isEmpty else { return }
        let clip = queue.removeFirst()
        let token = playbackToken
        current = clip
        currentScheduled = false
        currentClosing = false
        tap.set(playing: true)
        let format = playbackFormat
        switch clip.source {
        case .audio(let data, let mimeType):
            decodeQueue.async { [weak self] in
                let buffer = Self.decode(data, mimeType: mimeType, to: format)
                DispatchQueue.main.async {
                    guard let self, self.playbackToken == token, self.current?.id == clip.id else { return }
                    guard let buffer else { self.clipFailed(clip, reason: "这句语音无法解码"); return }
                    self.schedule(buffer, clip: clip, token: token, last: true)
                }
            }
        case .speech(let voice, let language):
            let utterance = AVSpeechUtterance(string: clip.text)
            utterance.voice = Self.voice(named: voice, language: language, text: clip.text)
            speechClips[ObjectIdentifier(utterance)] = (clip.id, token)
            // A voice that never renders must not hold the queue.
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, self.playbackToken == token, self.current?.id == clip.id, !self.currentScheduled else { return }
                self.synthesizer.stopSpeaking(at: .immediate)
                self.clipFailed(clip, reason: "系统语音没有生成声音")
            }
            speechTimeout?.cancel()
            speechTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
            let converter = VoiceCallChunkConverter(output: format)
            synthesizer.write(utterance) { [weak self] buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 {
                    DispatchQueue.main.async { self?.speechFinished(clip.id, token: token) }
                    return
                }
                guard let converted = converter.convert(pcm) else { return }
                DispatchQueue.main.async {
                    guard let self, self.playbackToken == token, self.current?.id == clip.id, !self.currentClosing else { return }
                    self.schedule(converted, clip: clip, token: token, last: false)
                }
            }
        }
    }

    private func schedule(_ buffer: AVAudioPCMBuffer, clip: VoiceCallClip, token: UUID, last: Bool) {
        if !currentScheduled {
            currentScheduled = true
            emit(.playbackStarted(clip.id))
        }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard last else { return }
            DispatchQueue.main.async {
                guard let self, self.playbackToken == token, self.current?.id == clip.id else { return }
                self.clipFinished(clip)
            }
        }
        if engine.isRunning, !player.isPlaying { player.play() }
    }

    /// The system voice finished rendering: a one-frame marker after the last
    /// chunk tells when everything rendered has actually been heard.
    private func speechFinished(_ clipID: String, token: UUID) {
        guard playbackToken == token, let clip = current, clip.id == clipID, !currentClosing else { return }
        currentClosing = true
        guard currentScheduled, let marker = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: 1) else {
            clipFailed(clip, reason: "系统语音没有生成声音"); return
        }
        marker.frameLength = 1
        schedule(marker, clip: clip, token: token, last: true)
    }

    private func clipFinished(_ clip: VoiceCallClip) {
        current = nil
        emit(.playbackFinished(clip.id))
        if queue.isEmpty { tap.set(playing: false) }
        playNext()
    }

    private func clipFailed(_ clip: VoiceCallClip, reason: String) {
        current = nil
        emit(.playbackFailed(clip.id, reason: reason))
        if queue.isEmpty { tap.set(playing: false) }
        playNext()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        DispatchQueue.main.async { [weak self] in
            guard let self, let entry = self.speechClips.removeValue(forKey: key) else { return }
            self.speechFinished(entry.clip, token: entry.token)
        }
    }

    // MARK: Helpers

    private func emit(_ event: VoiceCallAudioEvent) { receive?(event) }

    /// The voice named by the interface (a `say` name such as "Tingting", or an
    /// identifier); otherwise the first installed voice of the text's language.
    static func voice(named name: String?, language: String?, text: String) -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices()
        if let name = name?.trimmingCharacters(in: .whitespaces), !name.isEmpty,
           let match = voices.first(where: { $0.name == name || $0.identifier == name }) { return match }
        let wanted = language.flatMap { $0.isEmpty ? nil : SpeechText.normalizedLanguage($0) }
            ?? SpeechText.voiceLanguage(for: text, preference: "system")
        return SpeechText.matchingVoiceLanguage(wanted, available: voices.map(\.language)).flatMap { AVSpeechSynthesisVoice(language: $0) }
    }

    /// Encoded audio → one buffer in the playback format. The temporary file is
    /// removed before returning, whatever happens.
    static func decode(_ data: Data, mimeType: String, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let lower = mimeType.lowercased()
        let ext = lower.contains("wav") ? "wav" : lower.contains("aac") || lower.contains("mp4") ? "m4a" : "mp3"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("melo-call-\(UUID().uuidString).\(ext)")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            try data.write(to: url)
            let file = try AVAudioFile(forReading: url)
            guard file.length > 0, let source = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { return nil }
            try file.read(into: source)
            return VoiceCallChunkConverter(output: format).convert(source, last: true)
        } catch {
            return nil
        }
    }
}
