#if DEBUG && targetEnvironment(simulator)
import UIKit
import AVFoundation

// Runs only on a disposable simulator; no model request or microphone permission.
@MainActor enum SpeechPlaybackVerification {
    static func run() async {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let defaults = UserDefaults.standard
        let originalAuto = defaults.object(forKey: "melo.autoSpeak")
        let originalNotifications = defaults.object(forKey: "melo.notifications")
        let device = LocalDeviceServices.shared, audio = AVAudioSession.sharedInstance()
        var result: [String: Any] = ["passed": false]
        func check(_ condition: Bool, _ message: String) throws { if !condition { throw MeloError.message(message) } }
        defer {
            device.stopSpeech()
            defaults.set(originalAuto, forKey: "melo.autoSpeak"); defaults.set(originalNotifications, forKey: "melo.notifications")
            try? audio.setCategory(.ambient)
        }
        do {
            for _ in 0..<100 {
                if UIApplication.shared.applicationState == .active { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            try check(UIApplication.shared.applicationState == .active, "Simulator app is not foreground")
            defaults.set(false, forKey: "melo.autoSpeak"); defaults.set(false, forKey: "melo.notifications")
            device.completed(text: "不应朗读", background: false)
            try check(!device.speechActive, "Disabled setting started speech")
            defaults.set(true, forKey: "melo.autoSpeak")
            device.completed(text: "后台不应朗读", background: true)
            try check(!device.speechActive, "Background completion started speech")
            // Reproduce the session category left by SystemSpeechInput after stop.
            try audio.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try check(device.usesIndependentSpeechSession, "Speech inherited the record-only application session")
            device.completed(text: "你好，这是录音结束后的朗读验证。", background: false)
            try check(device.speechActive, "Foreground reply did not enqueue speech")
            for _ in 0..<200 {
                if device.speechStatus == "正在朗读" || device.speechStatus == "朗读已完成" || device.speechFailed { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            try check(device.speechStatus == "正在朗读" || device.speechStatus == "朗读已完成", "Speech engine did not acknowledge playback: " + device.speechStatus)
            result["engineAcknowledgedPlayback"] = true
            try check(audio.category == .record, "Speech modified the recording session")
            NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
            try check(!device.speechActive, "Speech continued on leaving foreground")
            defaults.set(false, forKey: "melo.autoSpeak")
            device.previewSpeech()
            try check(device.speechActive, "Explicit preview should not require auto-read enabled")
            device.stopSpeech(); try check(!device.speechActive, "Stop did not clear playback")
            result["passed"] = true
            result["checks"] = ["saved toggle gating", "background gating", "independent playback after record", "speech delegate start", "foreground exit stops", "preview without auto-read", "stop"]
            result["physicalAudibilityVerified"] = false
        } catch { result["error"] = error.localizedDescription }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted,.sortedKeys]) { try? data.write(to: directory.appendingPathComponent("speech-playback-verification.json"), options: .atomic) }
    }
}
#endif
