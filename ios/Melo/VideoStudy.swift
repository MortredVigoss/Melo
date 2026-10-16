import Foundation
import CoreTransferable
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
#if canImport(Speech)
import Speech
#endif

/// A video studied on this iPhone: evenly spaced frames plus a speech transcript.
/// The model sees frames + text (it does not receive the video file), the same
/// shape the desktop produces. Videos longer than 10 minutes go to the computer.
struct VideoDigest: Equatable {
    var name: String
    var duration: Double
    var frameTimes: [Int]
    var frames: [Data]
    var transcript: String
    var transcriptNote: String
}

enum VideoStudy {
    static let maxDuration: Double = 600
    static let maxFrames = 24, minFrames = 5, secondsPerFrame = 15.0, frameWidth: CGFloat = 768

    /// Same spacing rule as the desktop extractor (one frame per 15 s, 5–24 frames).
    static func frameTimes(duration: Double) -> [Int] {
        guard duration > 0 else { return [] }
        let count = min(maxFrames, max(minFrames, Int((duration / secondsPerFrame).rounded())))
        let interval = duration / Double(count)
        return (0..<count).map { Int((Double($0) * interval).rounded()) }
    }
    static func clock(_ seconds: Double) -> String { String(format: "%02d:%02d", Int(seconds) / 60, Int(seconds) % 60) }

    /// What the model receives alongside the frames.
    static func modelText(_ question: String, digest: VideoDigest) -> String {
        let times = digest.frameTimes.map { clock(Double($0)) }.joined(separator: "、")
        let transcript = digest.transcript.isEmpty ? "（\(digest.transcriptNote)）" : digest.transcript
        return question + "\n\n[附带视频「\(digest.name)」，时长 \(clock(digest.duration))。随后的 \(digest.frames.count) 张图片是按时间抽取的画面（\(times)）。]\n视频语音文字稿：\n" + transcript
    }
    /// The short line kept in the visible chat message.
    static func chatLine(_ digest: VideoDigest) -> String { "[视频：\(digest.name) · \(clock(digest.duration)) · \(digest.frames.count) 帧]" }
    /// A reusable knowledge note, same layout as the desktop's.
    static func knowledge(_ digest: VideoDigest) -> KnowledgeNote {
        let times = digest.frameTimes.map { clock(Double($0)) }.joined(separator: "、")
        let body = ["# 视频资料：\(digest.name)", "", "- 时长：\(clock(digest.duration))", "- 关键画面：\(digest.frames.count) 张，时间点 \(times)", "", "## 文字稿", "", digest.transcript.isEmpty ? "（\(digest.transcriptNote)）" : digest.transcript]
        return KnowledgeNote(title: String("视频：\(digest.name)".prefix(120)), content: body.joined(separator: "\n"), kind: "note", language: "markdown")
    }

    static func digest(url: URL, name: String, locale: String = Locale.preferredLanguages.first ?? "zh-CN") async throws -> VideoDigest {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0 else { throw MeloError.message("无法读取这段视频。") }
        guard duration <= maxDuration else { throw MeloError.message("这段视频超过 10 分钟，请在电脑上发送；电脑会完整抽帧并转写，结果可存入知识后在手机上使用。") }
        let times = frameTimes(duration: duration)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: frameWidth, height: frameWidth)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
        var frames: [Data] = []
        for second in times {
            try Task.checkCancellation()
            let (image, _) = try await generator.image(at: CMTime(seconds: Double(second), preferredTimescale: 600))
            frames.append(try jpeg(image))
        }
        let (transcript, note) = await transcribe(asset: asset, locale: locale)
        return VideoDigest(name: name, duration: duration, frameTimes: times, frames: frames, transcript: transcript, transcriptNote: note)
    }

    static func jpeg(_ image: CGImage) throws -> Data {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { throw MeloError.message("无法转换视频画面。") }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw MeloError.message("无法转换视频画面。") }
        return output as Data
    }

    /// Speech from the video's audio track. Prefers on-device recognition; a missing
    /// permission or audio track leaves the frames usable with an explanatory note.
    static func transcribe(asset: AVURLAsset, locale: String) async -> (String, String) {
        #if canImport(Speech)
        guard (try? await asset.loadTracks(withMediaType: .audio))?.isEmpty == false else { return ("", "这段视频没有声音") }
        let status = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        guard status == .authorized else { return ("", "语音识别未获授权，只使用了画面") }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else { return ("", "当前语言的语音识别暂不可用，只使用了画面") }
        let audioURL = FileManager.default.temporaryDirectory.appendingPathComponent("melo-video-audio-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: audioURL) }
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else { return ("", "无法读取视频声音，只使用了画面") }
        if #available(iOS 18, macOS 15, *) {
            do { try await export.export(to: audioURL, as: .m4a) } catch { return ("", "无法读取视频声音，只使用了画面") }
        } else {
            export.outputURL = audioURL; export.outputFileType = .m4a
            await export.export()
            guard export.status == .completed else { return ("", "无法读取视频声音，只使用了画面") }
        }
        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.shouldReportPartialResults = false
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let text: String? = await withCheckedContinuation { continuation in
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !finished else { return }
                if let result, result.isFinal { finished = true; continuation.resume(returning: result.bestTranscription.formattedString) }
                else if error != nil { finished = true; continuation.resume(returning: nil) }
            }
        }
        guard let text, !text.isEmpty else { return ("", "没有识别到语音") }
        return (text, "")
        #else
        return ("", "此设备不支持语音识别，只使用了画面")
        #endif
    }
}

/// A picked video copied to a temporary file the app can read.
struct PickedVideo: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { video in SentTransferredFile(video.url) } importing: { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("melo-video-\(UUID().uuidString).\(received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedVideo(url: copy)
        }
    }
}
