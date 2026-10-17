import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

struct LocalImage: Codable, Equatable, Identifiable {
    var id: String
    var width: Int
    var height: Int
    var mimeType: String
    var title: String
    var createdAt = timestamp()
    var referenceIDs: [String] = []
    var reportedModel: String = ""
    var revisedPrompt: String = ""
    var fileExtension: String { mimeType == "image/jpeg" ? "jpg" : "png" }
}
struct ImageLibraryIndex: Codable {
    var version = 1
    var assets: [String: LocalImage] = [:]
    var messages: [String: [String]] = [:]
    var requests: [String: ImageTaskPlan] = [:]
    var pendingRemovals: [LocalImage]?
}
final class ImageLibrary {
    let directory: URL
    private(set) var index = ImageLibraryIndex()
    private(set) var ready = true
    init(directory: URL) {
        self.directory = directory
        let file = directory.appendingPathComponent("index.json")
        if FileManager.default.fileExists(atPath: file.path) {
            do {
                let data = try Data(contentsOf: file)
                guard data.count <= 16*1024*1024 else { throw MeloError.message("图片目录过大") }
                index = try JSONDecoder().decode(ImageLibraryIndex.self, from: data)
                guard index.version == 1, index.assets.allSatisfy({ $0.key == $0.value.id && UUID(uuidString: $0.key) != nil && ["image/png","image/jpeg"].contains($0.value.mimeType) }) else { throw MeloError.message("图片目录无效") }
            } catch { ready = false }
        }
    }
    func url(_ image: LocalImage) throws -> URL {
        guard UUID(uuidString: image.id) != nil, ["image/png","image/jpeg"].contains(image.mimeType) else { throw MeloError.message("图片路径无效。") }
        let url = directory.appendingPathComponent(image.id + "." + image.fileExtension)
        guard url.resolvingSymlinksInPath().deletingLastPathComponent().standardizedFileURL.path == directory.resolvingSymlinksInPath().standardizedFileURL.path else { throw MeloError.message("图片文件不在此对话资料库中。") }
        return url
    }
    func data(_ image: LocalImage) throws -> Data {
        let url = try url(image)
        guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= ImageLibrary.storedLimit else { throw MeloError.message("图片文件超过容量限制。") }
        return try Data(contentsOf: url)
    }
    /// Stored copies (≤4096 px) of a 4K result can exceed 24 MB.
    static let storedLimit = 64*1024*1024
    /// Picked photos may be large originals; only a ≤4096 px copy is kept and sent.
    static let importLimit = 100*1024*1024
    /// Sum of the copies sent in one request.
    static let requestLimit = 40*1024*1024
    func images(for message: String) -> [LocalImage] { (index.messages[message] ?? []).compactMap { index.assets[$0] } }
    /// Transfer copies for a request: stored images are sent as-is when small, otherwise
    /// re-encoded (JPEG unless transparent) at most `maxDimension` px. Stored files never change.
    func inputs(_ refs: [ImageReference], maxDimension: Int = 4096) throws -> [ImageInput] {
        if refs.isEmpty { return [] }
        guard ready else { throw MeloError.message("图片目录无法读取，原文件已保留。") }
        var total = 0
        return try refs.map { ref in
            guard let image = index.assets[ref.id] else { throw MeloError.message("参考图已不存在，请重新选择。") }
            var bytes = try data(image), mimeType = image.mimeType
            if bytes.count > 6*1024*1024 || max(image.width, image.height) > maxDimension {
                let copy = try Self.decoded(bytes, maxDimension: maxDimension)
                let jpeg = !Self.hasAlpha(copy)
                bytes = try Self.encoded(copy, jpeg: jpeg); mimeType = jpeg ? "image/jpeg" : "image/png"
            }
            total += bytes.count
            guard total <= Self.requestLimit else { throw MeloError.message("这次附带的图片合计超过 40 MB（已按传输副本压缩），请减少张数；原图已保留。") }
            return ImageInput(data: bytes, mimeType: mimeType, role: ref.role)
        }
    }
    func bind(_ images: [LocalImage], to message: String, request: ImageTaskPlan? = nil) throws {
        var next = index; next.messages[message] = images.map(\.id)
        if let request { next.requests[message] = request }
        try commit(next)
    }
    func removeMessages(_ messages: Set<String>, protecting: Set<String> = []) throws {
        var next = index
        var candidates = Set(messages.flatMap { next.messages[$0] ?? [] })
        candidates.formUnion(messages.flatMap { next.requests[$0]?.references.map(\.id) ?? [] })
        for id in messages { next.messages[id] = nil; next.requests[id] = nil }
        var retained = Set(next.messages.values.flatMap { $0 }).union(protecting)
        retained.formUnion(next.requests.values.flatMap { $0.references.map(\.id) })
        retained.formUnion(Set(next.assets.keys).subtracting(candidates))
        var queue = Array(retained)
        while let id = queue.popLast() {
            for reference in next.assets[id]?.referenceIDs ?? [] where retained.insert(reference).inserted { queue.append(reference) }
        }
        let removed = candidates.subtracting(retained).compactMap { next.assets.removeValue(forKey: $0) }
        next.pendingRemovals = (next.pendingRemovals ?? []) + removed
        if !messages.isEmpty || !removed.isEmpty { try commit(next) }
        for image in index.pendingRemovals ?? [] {
            let file = try url(image)
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
        if index.pendingRemovals?.isEmpty == false { var finished = index; finished.pendingRemovals = nil; try commit(finished) }
    }
    private func commit(_ next: ImageLibraryIndex) throws {
        guard ready else { throw MeloError.message("图片目录无法读取，已停止写入以保留原文件。") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.write(JSONEncoder().encode(next), to: directory.appendingPathComponent("index.json"))
        index = next
    }
    static func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
    func store(_ data: Data, title: String, references: [String] = [], reportedModel: String = "", revisedPrompt: String = "", photo: Bool = false) throws -> LocalImage {
        let image = try Self.decoded(data)
        // Imported photos without transparency are kept as high-quality JPEG; generated results stay PNG.
        return try store(image, title: title, references: references, reportedModel: reportedModel, revisedPrompt: revisedPrompt, jpeg: photo && !Self.hasAlpha(image))
    }
    static func hasAlpha(_ image: CGImage) -> Bool {
        ![.none, .noneSkipFirst, .noneSkipLast].contains(image.alphaInfo)
    }
    func store(_ image: CGImage, title: String, references: [String] = [], reportedModel: String = "", revisedPrompt: String = "", jpeg: Bool = false) throws -> LocalImage {
        let bytes = try Self.encoded(image, jpeg: jpeg)
        guard bytes.count <= ImageLibrary.storedLimit else { throw MeloError.message("处理后的图片超过 64 MB，请缩小尺寸。") }
        let asset = LocalImage(id: UUID().uuidString, width: image.width, height: image.height, mimeType: jpeg ? "image/jpeg" : "image/png", title: title, referenceIDs: references, reportedModel: reportedModel, revisedPrompt: revisedPrompt)
        guard ready else { throw MeloError.message("图片目录不可用。") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = try url(asset); try Self.write(bytes, to: file)
        var next = index; next.assets[asset.id] = asset
        do { try commit(next) } catch { try? FileManager.default.removeItem(at: file); throw error }
        return asset
    }
    static func decoded(_ data: Data, maxDimension: Int = 4096) throws -> CGImage {
        guard data.count <= Self.importLimit,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache:false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString:Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 16000, height <= 16000, width*height <= 80_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:maxDimension,kCGImageSourceShouldCacheImmediately:true] as CFDictionary) else { throw MeloError.message("无法读取这张图片；请选择有效图片，单张不超过 24 MB。") }
        return image
    }
    static func encoded(_ image: CGImage, jpeg: Bool = false) throws -> Data {
        let output = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(output, (jpeg ? UTType.jpeg.identifier : UTType.png.identifier) as CFString, 1, nil) else { throw MeloError.message("无法转换图片。") }
        CGImageDestinationAddImage(dest, image, jpeg ? [kCGImageDestinationLossyCompressionQuality:0.92] as CFDictionary : nil)
        guard CGImageDestinationFinalize(dest) else { throw MeloError.message("无法保存图片。") }
        return output as Data
    }
    func transformed(_ asset: LocalImage, operation: String) throws -> LocalImage {
        let original = try Self.decoded(data(asset)); var output = original
        if operation == "square" {
            let side = min(original.width,original.height)
            guard let crop = original.cropping(to: CGRect(x:(original.width-side)/2,y:(original.height-side)/2,width:side,height:side)) else { throw MeloError.message("裁剪失败。") }
            output = crop
        } else if operation == "rotate" || operation == "1024" || operation == "2048" {
            let rotate = operation == "rotate", scale = rotate ? 1.0 : min(1,Double(Int(operation)!)/Double(max(original.width,original.height)))
            let width = rotate ? original.height : max(1,Int(Double(original.width)*scale))
            let height = rotate ? original.width : max(1,Int(Double(original.height)*scale))
            guard let ctx = CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { throw MeloError.message("图片处理内存不足。") }
            ctx.interpolationQuality = .high
            if rotate { ctx.translateBy(x:CGFloat(width),y:0);ctx.rotate(by:.pi/2);ctx.draw(original,in:CGRect(x:0,y:0,width:original.width,height:original.height)) }
            else { ctx.draw(original,in:CGRect(x:0,y:0,width:width,height:height)) }
            guard let image = ctx.makeImage() else { throw MeloError.message("图片处理失败。") };output=image
        } else if operation != "jpeg" && operation != "png" { throw MeloError.message("不支持的图片操作。") }
        return try store(output,title:"处理后的图片",references:[asset.id],jpeg:operation == "jpeg")
    }
}
