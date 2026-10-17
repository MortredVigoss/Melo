import Foundation

/// The images of one conversation, numbered in order (图1, 图2 …), and which of
/// them a follow-up message means. Without this, later turns only carried text,
/// so the model could not see earlier photos, "第二张" fell back to the most
/// recent result, and an unattached request was drawn from scratch.
struct CatalogImage: Equatable {
    let id: String
    let number: Int
    let messageID: String
    let fromUser: Bool
    /// Position inside its own message (0-based), e.g. the 2nd photo of an upload.
    let position: Int
    /// For a result: the image it was made from.
    let sourceID: String?
}

enum ImageContext {
    static func catalog(_ messages: [ChatMessage], images: (String) -> [LocalImage]) -> [CatalogImage] {
        var result: [CatalogImage] = []
        for message in messages {
            // A follow-up is linked to the earlier images it used; those are not new uploads.
            let fresh = images(message.id).filter { image in !result.contains { $0.id == image.id } }
            for (position, image) in fresh.enumerated() {
                result.append(CatalogImage(id: image.id, number: result.count + 1, messageID: message.id, fromUser: message.role == "user", position: position, sourceID: message.role == "user" ? nil : image.referenceIDs.first))
            }
        }
        return result
    }

    /// One line per message that carries images, so the model knows what exists and by which number.
    static func marker(for messageID: String, in catalog: [CatalogImage]) -> String? {
        let own = catalog.filter { $0.messageID == messageID }
        guard !own.isEmpty else { return nil }
        let names = own.map { image -> String in
            guard !image.fromUser, let source = image.sourceID, let origin = catalog.first(where: { $0.id == source }) else { return "图\(image.number)" }
            return "图\(image.number)（由图\(origin.number)修改）"
        }
        return own[0].fromUser ? "[此消息附带图片：\(names.joined(separator: "、"))]" : "[此回复生成图片：\(names.joined(separator: "、"))]"
    }

    /// The last user upload with images (the "batch" ordinals refer to).
    private static func latestBatch(_ catalog: [CatalogImage]) -> [CatalogImage] {
        guard let last = catalog.last(where: \.fromUser) else { return [] }
        return catalog.filter { $0.messageID == last.messageID }
    }
    /// Newest version of an original: follow results made from it (and from those results).
    static func latestVersion(of original: CatalogImage, in catalog: [CatalogImage]) -> CatalogImage {
        var current = original
        while let next = catalog.last(where: { $0.sourceID == current.id }) { current = next }
        return current
    }

    private static let ordinalWords: [String: Int] = ["一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "first": 1, "second": 2, "third": 3, "fourth": 4]

    static func mentionsImage(_ text: String) -> Bool {
        text.range(of: #"图|照片|相片|画面|这张|那张|这幅|原图|上一张|刚才那|第.张|这几张|这两张|\b(?:image|photo|picture|pic)s?\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Which catalog images a follow-up means (empty when it names none and nothing came before).
    static func resolve(_ text: String, catalog: [CatalogImage]) -> [String] {
        guard !catalog.isEmpty else { return [] }
        let batch = latestBatch(catalog)
        let wantsOriginal = text.range(of: #"原图|原来那|最初|\boriginals?\b"#, options: [.regularExpression, .caseInsensitive]) != nil
        func version(_ image: CatalogImage) -> CatalogImage { wantsOriginal ? image : latestVersion(of: image, in: catalog) }
        // "图3" names a catalog number directly.
        let numbered = matches(#"图\s*([1-9][0-9]?)"#, in: text).compactMap { Int($0) }.compactMap { n in catalog.first { $0.number == n } }
        if !numbered.isEmpty { return numbered.map { wantsOriginal ? original(of: $0, in: catalog) : $0 }.map(\.id) }
        // "第二张" / "the second one" counts within the latest upload.
        let ordinals = (matches(#"第\s*([一二两三四五六七八1-8])\s*张"#, in: text) + matches(#"\b(first|second|third|fourth)\b"#, in: text.lowercased())).compactMap { ordinalWords[$0] }
        if !ordinals.isEmpty, !batch.isEmpty { return ordinals.compactMap { $0 <= batch.count ? version(batch[$0 - 1]).id : nil } }
        // "这几张 / 都 / 每张": every photo of the latest upload, each in its newest version.
        if text.range(of: #"这几张|这两张|这些|全部|所有|每张|都|两张|三张|几张|\b(?:all|both|each|every)\b"#, options: [.regularExpression, .caseInsensitive]) != nil, batch.count > 1 {
            return batch.map { version($0).id }
        }
        if wantsOriginal, !batch.isEmpty { return batch.map(\.id) }
        // Otherwise: the images of the most recent message that had any.
        guard let last = catalog.last else { return [] }
        return catalog.filter { $0.messageID == last.messageID }.map(\.id)
    }
    private static func original(of image: CatalogImage, in catalog: [CatalogImage]) -> CatalogImage {
        var current = image
        while let source = current.sourceID, let parent = catalog.first(where: { $0.id == source }) { current = parent }
        return current
    }
    private static func matches(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
    }
    /// Names the attached images for the model, e.g. "本轮附带：图2（你上传的第 2 张）".
    static func attachmentNote(_ ids: [String], catalog: [CatalogImage]) -> String? {
        let names = ids.compactMap { id in catalog.first { $0.id == id } }.map { image -> String in
            image.fromUser ? "图\(image.number)（你上传的第 \(image.position + 1) 张）" : "图\(image.number)（之前生成的结果）"
        }
        return names.isEmpty ? nil : "[本轮附带：\(names.joined(separator: "、"))，按顺序对应随后的图片]"
    }
}
