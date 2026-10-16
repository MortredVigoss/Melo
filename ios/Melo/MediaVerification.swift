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
            try await Task.sleep(nanoseconds: 80_000_000)
            let midRun = store.liveSteps(for: chat)
            guard midRun.contains(where: { $0.title.hasPrefix("第 1/3 张") && $0.state == .running }) else { throw MeloError.message("进行中没有显示步骤：\(midRun.map(\.title))") }
            result["liveSteps"] = midRun.map { "\($0.title):\($0.state)" }
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
            // 6. Follow-ups across turns: each message knows the numbered images, "第二张" means photo 2's
            //    newest version, and a question about the first original attaches that original.
            var prompts: [String] = []
            let flow = ChatStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("media-flow-" + UUID().uuidString), replyLoader: { messages, instructions in
                prompts.append(messages.map(\.content).joined(separator: "\n---\n"))
                if instructions.contains("图片创作助手") { return ModelReply(text: "", images: [ImagePayload(data: png(.systemTeal), mimeType: "image/png")]) }
                return ModelReply(text: "看到了。")
            })
            guard let flowChat = flow.newChat() else { throw MeloError.message("无法创建对话") }
            let pair = try [UIColor.red, .green].map { try flow.importImage(png($0)) }
            flow.send("都换成晴天", chatID: flowChat, imageTask: ImageTaskPlan(references: pair.map { ImageReference(id: $0.id) }))
            for _ in 0..<300 where flow.anySending { try? await Task.sleep(nanoseconds: 25_000_000) }
            guard let firstAnswer = flow.chats.first(where: { $0.id == flowChat })?.messages.last, flow.imageLibrary.images(for: firstAnswer.id).count == 2 else { throw MeloError.message("两张都应返回结果") }
            let resultForB = flow.imageLibrary.images(for: firstAnswer.id)[1]
            flow.send("第二张再亮一点", chatID: flowChat)
            for _ in 0..<300 where flow.anySending { try? await Task.sleep(nanoseconds: 25_000_000) }
            let secondQuestion = flow.chats.first(where: { $0.id == flowChat })!.messages.dropLast().last!
            guard flow.imageLibrary.index.requests[secondQuestion.id]?.references.map(\.id) == [resultForB.id] else { throw MeloError.message("“第二张”没有指向第二张的最新结果") }
            flow.send("第一张的原图是什么天气？", chatID: flowChat)
            for _ in 0..<300 where flow.anySending { try? await Task.sleep(nanoseconds: 25_000_000) }
            let thirdQuestion = flow.chats.first(where: { $0.id == flowChat })!.messages.dropLast().last!
            guard flow.imageLibrary.index.requests[thirdQuestion.id]?.references.map(\.id) == [pair[0].id] else { throw MeloError.message("提问没有带上第一张原图") }
            guard let lastPrompt = prompts.last, lastPrompt.contains("[此消息附带图片：图1、图2]"), lastPrompt.contains("[本轮附带：图1（你上传的第 1 张）") else { throw MeloError.message("模型没有收到图片编号：\(prompts.last?.suffix(200) ?? "")") }
            result["followUps"] = ["requests": prompts.count, "secondPhotoResolved": true, "originalAttached": true]
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
