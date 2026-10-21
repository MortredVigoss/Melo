import Foundation

final class FakeSpeech: SpeechInputEngine {
    var callbacks: [(SpeechInputEvent) -> Void] = []
    var finishes = 0
    var cancels = 0
    func start(locale: String, receive: @escaping (SpeechInputEvent) -> Void) { callbacks.append(receive) }
    func finish() { finishes += 1 }
    func cancel() { cancels += 1 }
}

@main struct VoiceInputTests {
    static func main() {
        let engine = FakeSpeech()
        let voice = VoiceInput(engine: engine, recordingLimit: 0.03, finalWait: 0.02)
        var draft = "原来的草稿", commits = 0
        func commit(_ text: String) { draft += "\n" + text; commits += 1 }
        voice.start(id: "first", commit: commit)
        voice.start(id: "duplicate", commit: commit)
        assert(engine.callbacks.count == 1)
        voice.cancel()
        engine.callbacks[0](.listening)
        assert(!voice.state.active)
        voice.start(id: "second", commit: commit)
        engine.callbacks[0](.transcript("旧文本", final: true))
        engine.callbacks[1](.listening)
        engine.callbacks[1](.transcript("新的", final: false))
        voice.stop()
        assert(engine.finishes == 1 && voice.state.status == "stopping" && commits == 0)
        engine.callbacks[1](.transcript("新的尾字", final: true))
        engine.callbacks[1](.failure("取消后的迟到错误"))
        assert(draft == "原来的草稿\n新的尾字" && commits == 1 && voice.state.error.isEmpty)
        voice.start(id: "third", commit: commit)
        engine.callbacks[2](.listening)
        engine.callbacks[2](.transcript("网络断开前", final: false))
        engine.callbacks[2](.failure("网络断开"))
        assert(commits == 2 && voice.state.error == "网络断开")
        voice.start(id: "fourth", commit: commit)
        engine.callbacks[3](.listening)
        engine.callbacks[3](.transcript("计时结束", final: false))
        let deadline = Date().addingTimeInterval(2)
        while voice.state.active && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        assert(commits == 3 && !voice.state.active && !voice.state.notice.isEmpty)
        voice.start(id: "fifth", commit: commit)
        engine.callbacks[4](.transcript("", final: true))
        assert(commits == 3 && voice.state.notice.contains("没有识别"))
        print("Voice input passed: draft preservation, final tail, cancellation, stale callbacks, errors, deadlines")
    }
}
