#if DEBUG && targetEnvironment(simulator)
import Foundation
import UIKit
import PDFKit

@MainActor enum LocalFileVerification {
    static func run() async {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let root = support.appendingPathComponent("LocalFilesVerification-" + UUID().uuidString)
        var result: [String: Any] = ["passed": false]
        do {
            let folder = root.appendingPathComponent("权限文件验收")
            try FileManager.default.createDirectory(at: folder.appendingPathComponent("子文件夹"), withIntermediateDirectories: true)
            let text = folder.appendingPathComponent("说明.md")
            try Data("# 本机文件验收\n这份测试资料只用于模拟器。先预览，再确认保存；取消不会导入。".utf8).write(to: text)
            let pdf = folder.appendingPathComponent("PDF资料.pdf")
            let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 360, height: 500))
            try renderer.writePDF(to: pdf) { context in context.beginPage(); ("Local PDF fixture for Melo" as NSString).draw(at: CGPoint(x: 24, y: 40), withAttributes: [.font: UIFont.systemFont(ofSize: 18)]) }
            let blank = folder.appendingPathComponent("扫描件示例.pdf")
            let scanData = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 360, height: 500)).pdfData { context in
                context.beginPage(); UIColor.gray.setFill()
                context.fill(CGRect(x: 20, y: 20, width: 120, height: 80))
            }
            try scanData.write(to: blank)
            guard PDFDocument(url: blank)?.pageCount == 1 else { throw LocalFileError.message("invalid scan fixture") }
            let grant = try LocalFileAccess.grant(folder)
            let storage = FolderGrantStorage(url: root.appendingPathComponent("registry/folders.json"))
            let manager = LocalFolderGrants(storage: storage); try manager.add(grant, replacing: nil)
            let restored = LocalFolderGrants(storage: storage)
            guard restored.grants.count == 1 else { throw LocalFileError.message("grant did not persist") }
            let restoredGrant = restored.grants[0]
            let files = try await Task.detached { try LocalFileAccess.list(restoredGrant, components: []) }.value
            result["listing"] = files.map { ["name": $0.name, "directory": $0.directory] as [String: Any] }
            guard files.count == 4, files.first?.directory == true else { throw LocalFileError.message("folder listing failed") }
            let preview = try LocalFileAccess.preview(grant, components: ["PDF资料.pdf"])
            defer { try? FileManager.default.removeItem(at: preview.directory) }
            guard try LocalFileText.extract(preview).contains("Local PDF fixture") else { throw LocalFileError.message("PDF extraction failed") }
            let scan = try LocalFileAccess.preview(blank)
            defer { try? FileManager.default.removeItem(at: scan.directory) }
            do { _ = try LocalFileText.extract(scan); throw LocalFileError.message("blank PDF accepted") }
            catch { if error.localizedDescription == "blank PDF accepted" { throw error } }
            restored.remove(restored.grants[0])
            guard restored.grants.isEmpty, try storage.load().isEmpty, FileManager.default.fileExists(atPath: text.path) else { throw LocalFileError.message("revoke altered original or did not persist") }
            let brokenStorage = FolderGrantStorage(url: text.appendingPathComponent("bad.json"))
            let broken = LocalFolderGrants(storage: brokenStorage)
            do { try broken.add(grant, replacing: nil); throw LocalFileError.message("failed save accepted") }
            catch { if error.localizedDescription == "failed save accepted" { throw error } }
            guard broken.grants.isEmpty else { throw LocalFileError.message("failed save changed grants") }
            let permissions = LocalPermissions(); await permissions.refresh()
            guard !permissions.requesting, permissions.microphone != .unknown, permissions.speech != .unknown, permissions.addPhotos != .unknown, permissions.notifications != .unknown else { throw LocalFileError.message("permission states unreadable") }
            result["permissionStates"] = ["microphone": permissions.microphone.title, "speech": permissions.speech.title, "photoAdd": permissions.addPhotos.title, "notifications": permissions.notifications.title]
            // Seed only this disposable simulator's local file registry for UI QA.
            let ui = LocalFolderGrants()
            if !ui.grants.contains(where: { $0.name == grant.name }) { try ui.add(grant, replacing: nil) }
            result["passed"] = true
            result["checks"] = ["folder grant persistence", "directory browse", "PDF text", "scan PDF error", "revoke preserves original", "failed grant save", "permission read without requests"]
        } catch { result["error"] = error.localizedDescription }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: support.appendingPathComponent("local-file-verification.json"), options: .atomic) }
    }
}
#endif
