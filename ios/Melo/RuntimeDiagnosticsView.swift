import SwiftUI

@MainActor enum RuntimeDiagnostics {
    static let journal = LifecycleJournal(file: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo/runtime-events.json"))
}
struct RuntimeDiagnosticsView: View {
    @Environment(\.dismiss) private var dismiss
    private let labels = ["launch":"应用启动", "active":"回到前台", "inactive":"暂时离开活动状态", "background":"进入后台", "termination-callback":"收到系统终止通知", "request-start":"开始请求", "request-end":"结束请求", "memory-warning":"系统内存警告"]
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("用于对照退出或重开时的录屏，只记录最近 80 次启动、前后台和请求状态，不含对话、图片、账号或密钥。系统不保证发出终止通知，记录缺失不能证明发生了崩溃。")
                        .font(.caption).foregroundStyle(.secondary)
                    if let error = RuntimeDiagnostics.journal.error { Text(error).foregroundStyle(.red) }
                    else if FileManager.default.fileExists(atPath: RuntimeDiagnostics.journal.file.path) {
                        ShareLink(item: RuntimeDiagnostics.journal.file) { Label("导出运行记录", systemImage: "square.and.arrow.up") }
                    }
                }
                ForEach(RuntimeDiagnostics.journal.events.reversed()) { event in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack { Text(labels[event.kind] ?? event.kind); Spacer(); if event.requestActive { Text("请求进行中").font(.caption).foregroundStyle(meloGold) } }
                        Text(event.time).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }.navigationTitle("运行记录").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.preferredColorScheme(.dark)
    }
}
