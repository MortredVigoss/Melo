#if DEBUG && targetEnvironment(simulator)
import UIKit

/// Simulator-only acceptance for photo and video handling through the real
/// ChatStore send path, with a counting fake model (no account or network).
@MainActor enum MediaVerification {
    final class Calls: @unchecked Sendable {
        var prompts: [String] = []; let lock = NSLock()
        func add(_ value: String) { lock.lock(); prompts.append(value); lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return prompts.count }
    }
    static func png(_ color: UIColor, size: CGSize = CGSize(width: 320, height: 240)) -> Data {
        UIGraphicsImageRenderer(size: size).pngData { context in color.setFill(); context.fill(CGRect(origin: .zero, size: size)) }
    }
    static func run() async {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/media-verification.json")
        var result: [String: Any] = ["passed": false]
        let calls = Calls()
        let store = ChatStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("media-verify-" + UUID().uuidString), replyLoader: { _, instructions in
            calls.add(instructions)
            try await Task.sleep(nanoseconds: 150_000_000)
            return ModelReply(text: "", images: [ImagePayload(data: png(.systemBlue), mimeType: "image/png", reportedModel: "fixture")])
        })
        func settle() async { for _ in 0..<300 where store.anySending { try? await Task.sleep(nanoseconds: 25_000_000) } }
        do {
            guard let chat = store.newChat() else { throw MeloError.message("无法创建对话") }
            // 1. Three photos + an edit request: three requests, each result paired with its own original.
            let originals = try [UIColor.red, .green, .orange].map { try store.importImage(png($0)) }
            store.send("都调亮一点", chatID: chat, imageTask: ImageTaskPlan(references: originals.map { ImageReference(id: $0.id) }))
            await settle()
            guard calls.count == 3 else { throw MeloError.message("逐张修改应发 3 次请求，实际 \(calls.count)") }
            guard let reply = store.chats.first(where: { $0.id == chat })?.messages.last, reply.role == "assistant" else { throw MeloError.message("没有保存回复") }
            let results = store.imageLibrary.images(for: reply.id)
            guard results.map({ $0.referenceIDs.first }) == originals.map({ Optional($0.id) }) else { throw MeloError.message("结果没有对应各自的原图：\(results.map(\.referenceIDs))") }
            guard reply.content.contains("3/3") else { throw MeloError.message("回复没有说明逐张结果：\(reply.content)") }
            result["perPhoto"] = ["requests": calls.count, "results": results.count]
            // 1b. Combining wording sends one request with every photo.
            let before = calls.count
            store.send("把这三张合成一张海报", chatID: chat, imageTask: ImageTaskPlan(references: originals.map { ImageReference(id: $0.id) }))
            await settle()
            guard calls.count == before + 1 else { throw MeloError.message("合成应只发 1 次请求，实际 \(calls.count - before)") }
            result["combine"] = ["requests": calls.count - before]
            // 5. A real video (pushed into Documents by the test script): frames + transcript note,
            //    sent as frames with the transcript text, and only a short line kept in the chat.
            let sample = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("media-verification-sample.mp4")
            if FileManager.default.fileExists(atPath: sample.path) {
                let digest = try await VideoStudy.digest(url: sample, name: "sample.mp4")
                guard digest.frameTimes == [0, 12, 24, 36, 48], digest.frames.count == 5 else { throw MeloError.message("视频抽帧不对：\(digest.frameTimes)") }
                let videoCalls = calls.count
                var lastPrompt = ""
                let videoStore = ChatStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("media-video-" + UUID().uuidString), replyLoader: { messages, _ in
                    lastPrompt = messages.last?.content ?? ""; return ModelReply(text: "视频讲的是测试画面。")
                })
                guard let videoChat = videoStore.newChat() else { throw MeloError.message("无法创建对话") }
                videoStore.pendingVideos[videoChat] = digest
                videoStore.send("", chatID: videoChat)
                for _ in 0..<200 where videoStore.anySending { try? await Task.sleep(nanoseconds: 25_000_000) }
                let messages = videoStore.chats.first(where: { $0.id == videoChat })?.messages ?? []
                guard lastPrompt.contains("随后的 5 张图片"), lastPrompt.contains("视频语音文字稿") else { throw MeloError.message("模型没有收到视频画面说明：\(lastPrompt.prefix(120))") }
                guard messages.first?.content.hasSuffix(VideoStudy.chatLine(digest)) == true, messages.last?.role == "assistant", videoStore.pendingVideos[videoChat] == nil else { throw MeloError.message("视频消息保存不对") }
                guard videoStore.saveVideoKnowledge(digest), videoStore.preferences.knowledge?.last?.title == "视频：sample.mp4" else { throw MeloError.message("视频没有存入知识") }
                result["video"] = ["frames": digest.frames.count, "times": digest.frameTimes, "transcriptNote": digest.transcriptNote, "imageCallsUnchanged": calls.count == videoCalls]
            } else { result["video"] = "未提供样例视频" }
            result["passed"] = true
        } catch { result["error"] = error.localizedDescription }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
    }
}
#endif
