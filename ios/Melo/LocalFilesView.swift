import SwiftUI
import UniformTypeIdentifiers
import QuickLook
import PDFKit

@MainActor final class LocalFolderGrants: ObservableObject {
    @Published private(set) var grants: [FolderAccessGrant] = []
    @Published var error: String?
    @Published private(set) var loaded = false
    let storage: FolderGrantStorage
    init(storage: FolderGrantStorage = FolderGrantStorage(url: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("MeloLocalAccess/folders.json"))) {
        self.storage = storage; reload()
    }
    func reload() {
        do { grants = try storage.load(); loaded = true; error = nil }
        catch { loaded = false; self.error = "未能读取本机授权记录，请重试。原记录未被覆盖。\n\(error.localizedDescription)" }
    }
    func add(_ grant: FolderAccessGrant, replacing id: UUID?) throws {
        guard loaded else { throw LocalFileError.message("请先重新载入授权记录。") }
        var next = grants
        if let id, let index = next.firstIndex(where: { $0.id == id }) {
            var renewed = grant; renewed.id = id; next[index] = renewed
        } else { next.append(grant) }
        try storage.save(next); grants = next
    }
    func remove(_ grant: FolderAccessGrant) {
        do { let next = grants.filter { $0.id != grant.id }; try storage.save(next); grants = next }
        catch { self.error = "未能移除授权，记录仍保留，请重试。\n\(error.localizedDescription)" }
    }
}

struct LocalFilesView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var folders = LocalFolderGrants()
    @State private var picker = false
    @State private var pickingFolder = false
    @State private var replacing: UUID?
    @State private var browsing: FolderAccessGrant?
    @State private var preview: LocalFilePreview?
    @State private var previewDirectory: URL?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("选择你想交给 Melo 的文件").font(.title2.bold())
                    Text("支持“我的 iPhone”、iCloud Drive 和已接入“文件”的服务。云端文件可能需要先下载；预览只在本机打开。").font(.subheadline).foregroundStyle(.secondary)
                    HStack {
                        Button { pickingFolder = false; picker = true } label: { Label("选择文件", systemImage: "doc.badge.plus").frame(minHeight: 44) }
                        Spacer()
                        Button { replacing = nil; pickingFolder = true; picker = true } label: { Label("授权文件夹", systemImage: "folder.badge.plus").frame(minHeight: 44) }.disabled(!folders.loaded)
                    }.disabled(busy)
                    if busy { ProgressView("正在读取文件…") }
                    Text("已授权文件夹").font(.headline)
                    if folders.grants.isEmpty { Text("还没有授权文件夹。授权后可以下次继续浏览，不会自动扫描或上传内容。").font(.caption).foregroundStyle(.secondary).meloPanel() }
                    ForEach(folders.grants) { grant in
                        VStack(alignment: .leading, spacing: 10) {
                            Button { browsing = grant } label: { HStack { Label(grant.name, systemImage: "folder").lineLimit(2); Spacer(); Image(systemName: "chevron.right") }.frame(minHeight: 44).contentShape(Rectangle()) }.buttonStyle(.plain)
                            HStack {
                                Button("重新授权") { replacing = grant.id; pickingFolder = true; picker = true }
                                Spacer(); Button("移除授权", role: .destructive) { folders.remove(grant) }
                            }.font(.caption).disabled(busy)
                        }.meloPanel()
                    }
                    if !folders.loaded { Button("重新载入授权记录") { folders.reload() } }
                    Text("文件夹授权只保存在此 iPhone，不随对话同步或导出。移除授权不会删除原文件或已导入的知识资料。单文件预览上限 20 MB。").font(.caption).foregroundStyle(.secondary)
                }.padding(20)
            }.background(MeloTheme.dialog).navigationTitle("本机文件").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(busy) } }
                .fileImporter(isPresented: $picker, allowedContentTypes: pickingFolder ? [.folder] : [.data], allowsMultipleSelection: false) { result in
                    let folder = pickingFolder, replaceID = replacing
                    switch result {
                    case .failure(let failure): if (failure as NSError).code != NSUserCancelledError { error = failure.localizedDescription }
                    case .success(let urls):
                        guard let url = urls.first else { return }; busy = true
                        Task { @MainActor in
                            defer { busy = false }
                            do {
                                if folder {
                                    let grant = try await Task.detached { try LocalFileAccess.grant(url) }.value
                                    try folders.add(grant, replacing: replaceID)
                                } else {
                                    let file = try await Task.detached { try LocalFileAccess.preview(url) }.value
                                    previewDirectory = file.directory; preview = file
                                }
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                }
                .sheet(item: $browsing) { grant in FolderBrowserView(grant: grant) }
                .sheet(item: $preview, onDismiss: cleanPreview) { file in LocalFilePreviewView(file: file) }
                .alert("文件访问", isPresented: Binding(get: { error != nil || folders.error != nil }, set: { if !$0 { error = nil; folders.error = nil } })) { Button("知道了") { error = nil; folders.error = nil } } message: { Text(error ?? folders.error ?? "") }
        }.interactiveDismissDisabled(busy)
    }
    private func cleanPreview() { if let previewDirectory { try? FileManager.default.removeItem(at: previewDirectory) }; previewDirectory = nil }
}

struct FolderBrowserView: View {
    let grant: FolderAccessGrant
    @Environment(\.dismiss) private var dismiss
    @State private var components: [String] = []
    @State private var entries: [LocalFileEntry] = []
    @State private var busy = false
    @State private var readID = UUID()
    @State private var error: String?
    @State private var preview: LocalFilePreview?
    @State private var previewDirectory: URL?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(([grant.name] + components).joined(separator: " / ")).font(.caption).foregroundStyle(.secondary)
                    if !components.isEmpty { Button("返回上一级") { components.removeLast() }.disabled(busy) }
                }
                if busy { ProgressView("正在读取…") }
                else if let error {
                    Section { Text(error).foregroundStyle(.orange); Button("重试") { Task { await load() } }; Text("如果授权已失效，请返回文件列表点击“重新授权”。").font(.caption) }
                } else if entries.isEmpty { Text("文件夹为空，或仅含隐藏文件与符号链接。").foregroundStyle(.secondary) }
                ForEach(entries) { entry in
                    Button {
                        if entry.directory { components = entry.components }
                        else { open(entry) }
                    } label: {
                        HStack {
                            Image(systemName: entry.directory ? "folder" : "doc").foregroundStyle(meloGold)
                            Text(entry.name).foregroundStyle(.primary).lineLimit(2)
                            Spacer()
                            if let size = entry.size, !entry.directory { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption2).foregroundStyle(.secondary) }
                            Image(systemName: "chevron.right").font(.caption2)
                        }.frame(minHeight: 36)
                    }.disabled(busy)
                }
            }.scrollContentBackground(.hidden).background(MeloTheme.dialog)
                .navigationTitle(components.last ?? grant.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(busy) } }
                .task(id: components) { await load() }
                .sheet(item: $preview, onDismiss: { if let previewDirectory { try? FileManager.default.removeItem(at: previewDirectory) }; previewDirectory = nil }) { file in LocalFilePreviewView(file: file) }
        }.interactiveDismissDisabled(busy)
    }
    private func load() async {
        let token = UUID(); readID = token
        busy = true; error = nil; entries = []; let path = components
        defer { if readID == token { busy = false } }
        do { let items = try await Task.detached { try LocalFileAccess.list(grant, components: path) }.value; guard !Task.isCancelled, readID == token else { return }; entries = items }
        catch { if !Task.isCancelled, readID == token { self.error = error.localizedDescription } }
    }
    private func open(_ entry: LocalFileEntry) {
        busy = true; error = nil
        Task { @MainActor in
            defer { busy = false }
            do { let file = try await Task.detached { try LocalFileAccess.preview(grant, components: entry.components) }.value; previewDirectory = file.directory; preview = file }
            catch { self.error = error.localizedDescription }
        }
    }
}

enum LocalFileText {
    static func extract(_ file: LocalFilePreview) throws -> String {
        if file.url.pathExtension.lowercased() == "pdf" {
            guard let document = PDFDocument(url: file.url), !document.isLocked else { throw LocalFileError.message("PDF 无法读取或已加密，请先解锁后再导入。") }
            var parts: [String] = []; var count = 0
            guard document.pageCount <= 200 else { throw LocalFileError.message("PDF 超过 200 页，请拆分后导入。") }
            for i in 0..<document.pageCount {
                let text = document.page(at: i)?.string ?? ""; count += text.count + 1
                guard count <= LocalFileAccess.maximumTextCharacters else { throw LocalFileError.message("PDF 文字超过 12,000 字，请拆分后导入；未保存任何内容。") }
                parts.append(text)
            }
            return try LocalFileAccess.validatedText(parts.joined(separator: "\n"))
        }
        return try LocalFileAccess.text(Data(contentsOf: file.url))
    }
}

struct LocalFilePreviewView: View {
    let file: LocalFilePreview
    @Environment(\.dismiss) private var dismiss
    @State private var note: KnowledgeNote?
    @State private var busy = false
    @State private var error: String?
    private var canExtract: Bool { ["txt", "md", "markdown", "text", "pdf"].contains(file.url.pathExtension.lowercased()) }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if QLPreviewController.canPreview(file.url as NSURL) { LocalQuickLook(url: file.url) }
                else { ContentUnavailableView("此格式暂不支持预览", systemImage: "doc.questionmark", description: Text("可使用原文件所属的 App 查看；文件未发送给模型。")) }
                VStack(alignment: .leading, spacing: 8) {
                    if canExtract {
                        Button { extract() } label: { Label(busy ? "正在提取文字…" : "添加到知识资料", systemImage: "text.badge.plus").frame(minHeight: 44) }.disabled(busy)
                        Text("下一步可检查文字并确认保存，最多 12,000 字。保存后在对话“项目与资料”里选用。").font(.caption).foregroundStyle(.secondary)
                    } else { Text("当前仅预览。TXT、Markdown 和有文字层的 PDF 可添加为知识资料；Office 文件暂不提取正文。").font(.caption).foregroundStyle(.secondary) }
                }.padding(16)
            }.background(MeloTheme.dialog).navigationTitle(file.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(busy) } }
                .sheet(item: $note) { KnowledgeEditor(note: $0) }
                .alert("导入资料", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("知道了") { error = nil } } message: { Text(error ?? "") }
        }.interactiveDismissDisabled(busy)
    }
    private func extract() {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { let text = try await Task.detached { try LocalFileText.extract(file) }.value; note = KnowledgeNote(title: file.url.deletingPathExtension().lastPathComponent, content: text) }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct LocalQuickLook: UIViewControllerRepresentable {
    let url: URL
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController { let view = QLPreviewController(); view.dataSource = context.coordinator; return view }
    func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {}
}
