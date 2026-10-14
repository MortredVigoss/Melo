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
                LocalDataSettings()
                Button { diagnostics = true } label: { Label("运行记录与退出排查", systemImage: "waveform.path.ecg").font(.subheadline).frame(minHeight: 44) }
                MobileConnectionStatus().meloPanel()
                VStack(alignment: .leading, spacing: 17) {
                    HStack { Image(systemName: "person.crop.circle").font(.title).foregroundStyle(meloAccent); VStack(alignment: .leading, spacing: 5) { Text(account.signedIn ? "ChatGPT 已连接" : "连接你的 ChatGPT").font(.headline); Text(account.status).font(.caption).foregroundStyle(.secondary) }; Spacer() }
                    Text("在官方页面授权，手机直接连接模型，电脑关机也能聊天。可使用与电脑版相同的账号，也可独立选择。").font(.subheadline).foregroundStyle(.secondary)
                    if !account.registrations.isEmpty {
                        ForEach(Array(account.registrations.enumerated()), id: \.element.id) { index, registration in
                            Button { store.cancel(); account.select(registration.id) } label: {
                                HStack { Image(systemName: account.activeID == registration.id ? "checkmark.circle.fill" : "circle"); VStack(alignment: .leading, spacing: 3) { Text(registration.email).lineLimit(1); Text("账号 \(index + 1) · \(registration.refreshToken.isEmpty ? "待授权" : "已保存")").font(.caption2).foregroundStyle(.secondary) }; Spacer() }.font(.subheadline)
                            }.disabled(account.busy)
                        }
                    }
                    if account.busy { HStack { ProgressView(); Text(account.status).font(.caption).foregroundStyle(.secondary) } }
                    else {
                        Button { Task { await account.signIn(existingID: account.activeID) } } label: { HStack { Image(systemName: "arrow.up.right.circle"); Text("Continue with ChatGPT").fontWeight(.semibold); Spacer(); Image(systemName: "arrow.up.right") }.font(.subheadline).foregroundStyle(.black).padding(16).background(.white, in: RoundedRectangle(cornerRadius: 15)) }
                        if !account.registrations.isEmpty { Button("使用其他 ChatGPT 账号") { Task { await account.signIn() } }.font(.caption) }
                    }
                    if account.signedIn { Button("退出当前账号", role: .destructive) { store.cancel(); Task { await account.signOut() } }.font(.caption).disabled(account.busy) }
                    Link("查看 ChatGPT 用量与应用授权", destination: URL(string: "https://chatgpt.com/settings/usage")!).font(.caption).foregroundStyle(.secondary)
                }.meloPanel()
                ModelSettingsSection()
                VStack(alignment: .leading, spacing: 16) {
                    HStack { Label("数据与同步", systemImage: "arrow.triangle.2.circlepath").font(.headline); Spacer(); Text("\(store.chats.count) 段对话").font(.caption).foregroundStyle(meloGold) }
                    Text(store.syncStatus).font(.subheadline).foregroundStyle(.secondary)
                    DisclosureGroup("同步服务配置") {
                        SyncSettingsSection()
                    }.font(.subheadline)
                    Text("同步对话、角色头像、项目与共享资料、对话模型选择、来源记录和任务检查点。密钥、电脑路径和权限保存在本机；需配置支持上下文同步的私人服务。").font(.caption).foregroundStyle(MeloTheme.muted)
                    ForEach(store.preferences.workspaceSync?.conflicts ?? [], id: \.key) { conflict in
                        DisclosureGroup("同步冲突 · \(conflict.label)") {
                            Text("各版本均已保留，选择要继续使用的版本。").font(.caption)
                            ForEach(Array(conflict.versions.enumerated()), id: \.offset) { index, version in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("版本 \(index + 1)").font(.headline)
                                    if let data = Data(base64Encoded: version.value["avatarData"].string), let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().frame(width: 56, height: 56) }
                                    Text(version.value.preview).font(.caption).textSelection(.enabled)
                                    Button("采用版本 \(index + 1)") { store.resolveSyncConflict(conflict.key, choice:index) }.disabled(store.syncing)
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
                    capability("角色创建与指令", "本机可用", "person.crop.square")
                    capability("任务检查点与接力", "项目中查看", "arrow.triangle.branch")
                    capability("电脑工具、权限与任务验收", "在执行设备处理", "desktopcomputer")
                    capability("记忆来源、范围与停用", "本机可用 · 可同步", "brain")
                    capability("看图、生成与修改图片", "对话图片模式", "photo.on.rectangle")
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
        HStack { Label(name, systemImage: symbol).font(.caption); Spacer(); Text(status).font(.caption2).foregroundStyle(.secondary) }
    }
}
