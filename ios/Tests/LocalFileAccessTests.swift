import Foundation

@main struct LocalFileAccessTests {
    static func check(_ value: @autoclosure () throws -> Bool) throws { let result = try value(); assert(result) }
    static func expectFailure(_ block: () throws -> Void) {
        do { try block(); fatalError("Expected rejection") } catch {}
    }
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("MeloFilesTest-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("allowed"); let nested = folder.appendingPathComponent("nested")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("hello.md"); try Data("你好，Melo\n".utf8).write(to: file)
        let outside = root.appendingPathComponent("outside.txt"); try Data("outside".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("link"), withDestinationURL: outside)
        try check(try LocalFileAccess.child(root: folder, components: ["hello.md"]) == file)
        expectFailure { _ = try LocalFileAccess.child(root: folder, components: ["..", "outside.txt"]) }
        expectFailure { _ = try LocalFileAccess.child(root: folder, components: ["nested/../../outside.txt"]) }
        expectFailure { _ = try LocalFileAccess.child(root: folder, components: ["link"]) }
        expectFailure { _ = try LocalFileAccess.child(root: folder, components: ["\0"]) }

        let grant = try LocalFileAccess.grant(folder)
        let storage = FolderGrantStorage(url: root.appendingPathComponent("private/folders.json"))
        try check(try storage.load().isEmpty)
        try storage.save([grant])
        let reopened = try FolderGrantStorage(url: storage.url).load()
        try check(reopened == [grant])
        let entries = try LocalFileAccess.list(reopened[0], components: [])
        try check(entries.map(\.name) == ["nested", "hello.md"])
        try check(try LocalFileAccess.list(grant, components: ["nested"]).isEmpty)
        let preview = try LocalFileAccess.preview(grant, components: ["hello.md"])
        defer { try? FileManager.default.removeItem(at: preview.directory) }
        try check(try LocalFileAccess.text(Data(contentsOf: preview.url)) == "你好，Melo")
        try check(preview.url != file)
        try storage.save([]); try check(try storage.load().isEmpty)
        try check(FileManager.default.fileExists(atPath: file.path))
        expectFailure { _ = try LocalFileAccess.resolve(FolderAccessGrant(name: "bad", bookmark: Data([1, 2, 3]))) }
        expectFailure { _ = try LocalFileAccess.text(Data([0xff, 0xfe, 0x00])) }
        expectFailure { _ = try LocalFileAccess.text(Data("  \n ".utf8)) }
        expectFailure { _ = try LocalFileAccess.text(Data(String(repeating: "文", count: 12_001).utf8)) }
        try check(try LocalFileAccess.text(Data(String(repeating: "文", count: 12_000).utf8)).count == 12_000)

        let large = folder.appendingPathComponent("large.txt")
        try Data(count: LocalFileAccess.maximumBytes + 1).write(to: large)
        expectFailure { _ = try LocalFileAccess.preview(large) }
        expectFailure { _ = try LocalFileAccess.preview(folder.appendingPathComponent("link")) }
        expectFailure { _ = try LocalFileAccess.preview(folder) }
        try Data("not json".utf8).write(to: storage.url)
        expectFailure { _ = try storage.load() }
        let blocked = FolderGrantStorage(url: file.appendingPathComponent("folders.json"))
        expectFailure { try blocked.save([grant]) }
        try check(try String(contentsOf: file, encoding: .utf8) == "你好，Melo\n")
        print("Local file access passed: scoped folder persistence, revoke, traversal/symlink guards, bounded preview, malformed grants, encoding and text limits, save failures")
    }
}
