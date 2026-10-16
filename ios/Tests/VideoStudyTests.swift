import Foundation

// Phone video study: same frame spacing as the desktop extractor, what the model
// receives, the short chat line, and the knowledge note layout.
@main struct VideoStudyTests {
    static func main() {
        // Desktop: one frame per 15 s, 5–24 frames, times at index × interval (src/media/uploads.test.js).
        assert(VideoStudy.frameTimes(duration: 60) == [0, 12, 24, 36, 48])
        assert(VideoStudy.frameTimes(duration: 120) == [0, 15, 30, 45, 60, 75, 90, 105])
        assert(VideoStudy.frameTimes(duration: 600).count == 24 && VideoStudy.frameTimes(duration: 600)[1] == 25)
        assert(VideoStudy.frameTimes(duration: 0).isEmpty)
        let digest = VideoDigest(name: "课程", duration: 75, frameTimes: [0, 15, 30, 45, 60], frames: Array(repeating: Data([0xFF, 0xD8]), count: 5), transcript: "今天讲排序。", transcriptNote: "")
        let text = VideoStudy.modelText("总结一下", digest: digest)
        assert(text.hasPrefix("总结一下") && text.contains("时长 01:15") && text.contains("随后的 5 张图片") && text.contains("00:00、00:15、00:30、00:45、01:00") && text.hasSuffix("今天讲排序。"))
        assert(VideoStudy.chatLine(digest) == "[视频：课程 · 01:15 · 5 帧]")
        let silent = VideoDigest(name: "风景", duration: 30, frameTimes: [0], frames: [Data()], transcript: "", transcriptNote: "这段视频没有声音")
        assert(VideoStudy.modelText("看看", digest: silent).hasSuffix("（这段视频没有声音）"))
        let note = VideoStudy.knowledge(digest)
        assert(note.title == "视频：课程" && note.kind == "note" && note.content.contains("## 文字稿\n\n今天讲排序。"))
        print("Video study tests passed: frame spacing matches the desktop, model text, chat line, knowledge note")
    }
}
