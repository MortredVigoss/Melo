import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack { SettingsContent().background(MeloTheme.dialog).toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } } }
    }
}
struct SettingsContent: View {
    @EnvironmentObject var store: ChatStore
    @EnvironmentObject var account: ChatGPTAccount
    @AppStorage("webSearchEnabled") private var webSearchEnabled = true
    @AppStorage("modelAuthMode") private var authMode = "chatgpt"
    @State private var error: String?
    @State private var diagnostics = false
    @State private var sourcePage: SourcePage?
    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版" }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                PageHeading(eyebrow: "SYSTEM", title: "系统设置", detail: "个人资料、使用习惯与模型连接。")
                LocalProfileSettings()
                LocalGeneralSettings()
                LocalVoiceSettings()
                DeviceDataSettings()
                LocalDataSettings()
                Button { diagnostics = true } label: { Label("运行记录与退出排查", systemImage: "waveform.path.ecg").font(.subheadline).frame(minHeight: 44) }
                MobileConnectionStatus().meloPanel()
                CodexLoginCard().meloPanel()
                ModelSettingsSection()
                VStack(alignment: .leading, spacing: 16) {
                    HStack { Label("数据与同步", systemImage: "arrow.triangle.2.circlepath").font(.headline); Spacer(); Text("\(store.chats.count) 段对话").font(.caption).foregroundStyle(meloGold) }
                    if !WorkspaceProjection.pending(store.preferences).isEmpty { Text("部分 Agent 人设或关联配置尚未同步：旧版协议无法无损表示。全文已保留在本机，其他聊天继续同步。").font(.caption).foregroundStyle(.orange) }
                    Group {
                        if store.syncStatus == "聊天已同步 · 部分 Agent 人设或关联配置待同步，全文保留在本机" { Text("聊天已同步 · 部分 Agent 人设或关联配置待同步，全文保留在本机") }
                        else { Text(store.syncStatus) }
                    }.font(.subheadline).foregroundStyle(.secondary)
                    DisclosureGroup("同步服务配置") {
                        SyncSettingsSection()
                    }.font(.subheadline)
                    Text("同步对话、Agent头像、项目与共享资料、对话模型选择、来源记录和任务检查点。Agent 能力范围单独同步；密钥、电脑路径和具体文件授权保存在本机；需配置支持上下文同步的私人服务。").font(.caption).foregroundStyle(MeloTheme.muted)
                    ForEach(store.preferences.personaRecoveries ?? []) { recovery in
                        DisclosureGroup("本机人设恢复副本") {
                            Text(recovery.key + " · " + recovery.createdAt).font(.caption)
                            ForEach(recovery.agents.keys.sorted(), id: \.self) { id in
                                Text(recovery.agents[id]?.instructions ?? "").font(.caption).textSelection(.enabled)
                            }
                        }
                    }
                    ForEach(store.preferences.agentSettingsSync?.conflicts ?? [], id: \.key) { conflict in
                        DisclosureGroup("Agent 能力冲突 · \(conflict.label)") {
                            ForEach(Array(conflict.versions.enumerated()),id: \.offset) { index,version in
                                Text(version.value["content"].string).font(.caption).textSelection(.enabled)
                                Button("采用版本 \(index + 1)") { store.resolveAgentSettingsConflict(conflict.key,choice:index,expected:version) }.disabled(store.syncing)
                            }
                        }
                    }
                    ForEach(store.preferences.workspaceSync?.conflicts ?? [], id: \.key) { conflict in
                        DisclosureGroup("同步冲突 · \(conflict.label)") {
                            Text("各版本均已保留，选择要继续使用的版本。").font(.caption)
                            ForEach(Array(conflict.versions.enumerated()), id: \.offset) { index, version in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("版本 \(index + 1)").font(.headline)
                                    if let data = Data(base64Encoded: version.value["avatarData"].string), let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().frame(width: 56, height: 56) }
                                    Text(version.value.preview).font(.caption).textSelection(.enabled)
                                    Button("采用版本 \(index + 1)") { store.resolveSyncConflict(conflict.key, choice:index, expected:version) }.disabled(store.syncing)
                                }.padding(.vertical,8)
                            }
                        }
                    }
                }.textInputAutocapitalization(.never).autocorrectionDisabled().meloPanel()
                VStack(alignment: .leading, spacing: 14) {
                    Label("当前能力", systemImage: "square.stack.3d.up").font(.headline)
                    capability("文字对话与历史", "已接入", "bubble.left.and.bubble.right")
                    capability("三维任务空间与历史回看", "实际调用记录", "atom")
                    capability("分析与计算详情", "展示服务公开摘要", "text.alignleft")
                    capability("Agent创建与指令", "本机可用", "person.crop.square")
                    capability("任务检查点与接力", "项目中查看", "arrow.triangle.branch")
                    capability("电脑工具、权限与任务验收", "在执行设备处理", "desktopcomputer")
                    capability("记忆来源、范围与停用", "本机可用 · 可同步", "brain")
                    capability("看图、生成与修改图片", "直接描述图片要求", "photo.on.rectangle")
                    capability("本机 OCR、旋转与格式转换", "图片预览中", "viewfinder")
                    capability("画笔遮罩与批量图片", "桌面可用", "paintbrush.pointed")
                    capability("实时搜索与天气", authMode == "chatgpt" && account.signedIn && webSearchEnabled ? "已开启 · 按账号权限" : "未开启", "globe")
                }.meloPanel()
                HStack { Text("MELO FOR IPHONE").tracking(2); Spacer(); Text("\(version) · 本地测试版") }.font(.system(size: 9)).foregroundStyle(.tertiary)
            }.padding(20)
        }
        .environment(\.openURL, OpenURLAction { url in
            guard WebSource.validated(title: "", url: url.absoluteString) != nil else { return .discarded }
            sourcePage = SourcePage(url: url); return .handled
        })
        .sheet(isPresented: $diagnostics) { RuntimeDiagnosticsView() }
        .sheet(item: $sourcePage) { SourceBrowser(url: $0.url).ignoresSafeArea() }
        .task { if account.signedIn && account.models.isEmpty { await account.loadModels() } }
        .alert("Melo 设置", isPresented: Binding(get: { error != nil || account.error != nil }, set: { if !$0 { error = nil; account.error = nil } })) { Button("知道了") { error = nil; account.error = nil } } message: { Text(error ?? account.error ?? "") }
    }
    private func capability(_ name: String, _ status: String, _ symbol: String) -> some View {
        HStack { Label(LocalizedStringKey(name), systemImage: symbol).font(.caption); Spacer(); Text(LocalizedStringKey(status)).font(.caption2).foregroundStyle(.secondary) }
    }
}
