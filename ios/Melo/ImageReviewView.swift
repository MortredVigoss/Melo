import SwiftUI

/// User-requested inspection only. It reuses normal image analysis and never
/// schedules another generation or replaces the image being inspected.
struct ImageReviewView: View {
    @EnvironmentObject var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    let image: LocalImage
    let chatID: String
    var completed: () -> Void
    @State private var requirements = ""
    @State private var failure: String?
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            Form {
                Section { LocalImageThumbnail(image: image, library: store.imageLibrary).frame(height: 160) }
                Section("重点检查什么？") {
                    TextField("例如：文字有没有错、手部是否自然、是否符合原要求", text: $requirements, axis: .vertical).lineLimit(3...8).focused($focused)
                }
                Section {
                    Text("使用当前对话的模型分析这张图片，结果回到对话里。检查不会自动改图或重新生成；会使用当前模型的额度。无法确认的细节会标明。")
                        .font(.caption).foregroundStyle(.secondary)
                    if let failure { Text(failure).foregroundStyle(.red).font(.caption) }
                    Button("开始检查") {
                        focused = false
                        let request = ImageReviewRequest(imageID: image.id, requirements: requirements)
                        store.send(request.prompt, chatID: chatID, imageTask: request.plan, onPreflightFailure: { failure = $0 })
                        if store.sendingID == chatID { completed() }
                        else if failure == nil { failure = "尚未开始检查，请确认模型连接后重试。" }
                    }.disabled(store.sendingID != nil || !store.storageReady)
                        .buttonStyle(.borderedProminent).tint(meloAccent).foregroundStyle(.black)
                }
            }.navigationTitle("检查图片").navigationBarTitleDisplayMode(.inline)
                .scrollDismissesKeyboard(.interactively)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }; ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("收起键盘") { focused = false } } }
        }.preferredColorScheme(.dark)
    }
}
