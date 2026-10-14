import Foundation
import AVFoundation
import Speech

// Apple speech recognition may use Apple's servers depending on device/language.
// Audio is never attached to a chat or forwarded to the selected LLM by this engine.
final class SystemSpeechInput: SpeechInputEngine {
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var generation = UUID()
    private var tapped = false
    private var interruption: NSObjectProtocol?
    #if os(iOS)
    private var audioSessionActive = false
    #endif

    func start(locale: String, receive: @escaping (SpeechInputEvent) -> Void) {
        cancel()
        let token = generation
        SFSpeechRecognizer.requestAuthorization { [weak self] permission in
            DispatchQueue.main.async {
                guard let self, self.generation == token else { return }
                guard permission == .authorized else {
                    receive(.failure("语音识别未获授权，请在系统设置中允许 Melo 使用语音识别。")); return
                }
                AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                    DispatchQueue.main.async {
                        guard let self, self.generation == token else { return }
                        guard granted else {
                            receive(.failure("麦克风未获授权，请在系统设置中允许 Melo 使用麦克风。")); return
                        }
                        self.begin(locale: locale, token: token, receive: receive)
                    }
                }
            }
        }
    }

    private func begin(locale: String, token: UUID, receive: @escaping (SpeechInputEvent) -> Void) {
        let language = locale == "system" ? (Locale.preferredLanguages.first ?? "zh-CN") : locale
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
            receive(.failure("当前语言的语音识别暂不可用，请检查网络或更换语言。")); return
        }
        self.recognizer = recognizer
        do {
            #if os(iOS)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: [])
            audioSessionActive = true
            interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] notification in
                guard Self.interruptionBegan(notification) else { return }
                guard self?.generation == token else { return }
                receive(.failure("录音被系统中断，已保留识别到的文字。"))
            }
            #endif
            let input = audio.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                receive(.failure("没有可用的麦克风，请检查输入设备。")); return
            }
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.taskHint = .dictation
            self.request = request
            // Capture this request, never a mutable property: an old tap cannot feed a new session.
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            tapped = true
            audio.prepare()
            try audio.start()
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard self?.generation == token else { return }
                    if let result { receive(.transcript(result.bestTranscription.formattedString, final: result.isFinal)) }
                    if let error, self?.generation == token { receive(.failure("语音识别中断：\(error.localizedDescription)")) }
                }
            }
            receive(.listening)
        } catch {
            receive(.failure("无法启动麦克风：\(error.localizedDescription)"))
        }
    }

    #if os(iOS)
    static func interruptionBegan(_ notification: Notification) -> Bool {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let kind = AVAudioSession.InterruptionType(rawValue: raw) else { return false }
        return kind == .began
    }
    #endif
    func finish() {
        stopAudio()
        request?.endAudio() // allow the recognizer to flush the last words
    }

    func cancel() {
        generation = UUID()
        stopAudio()
        request?.endAudio(); request = nil
        task?.cancel(); task = nil
        recognizer = nil
    }

    private func stopAudio() {
        if audio.isRunning { audio.stop() }
        if tapped { audio.inputNode.removeTap(onBus: 0); tapped = false }
        if let interruption { NotificationCenter.default.removeObserver(interruption); self.interruption = nil }
        #if os(iOS)
        if audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioSessionActive = false
        }
        #endif
    }
}
