import SwiftUI
import AVFoundation
import Speech
import Photos
import UserNotifications

enum LocalPermissionState: Equatable {
    case unknown, notRequested, allowed, denied, restricted, quiet
    var title: String {
        switch self {
        case .unknown: return "正在读取"
        case .notRequested: return "尚未申请"
        case .allowed: return "已允许"
        case .denied: return "未允许"
        case .restricted: return "系统限制"
        case .quiet: return "静默通知"
        }
    }
    var color: Color {
        switch self { case .allowed, .quiet: return .green; case .denied, .restricted: return .orange; default: return .secondary }
    }
}

@MainActor final class LocalPermissions: ObservableObject {
    @Published var camera: LocalPermissionState = .unknown
    @Published var microphone: LocalPermissionState = .unknown
    @Published var speech: LocalPermissionState = .unknown
    @Published var addPhotos: LocalPermissionState = .unknown
    @Published var notifications: LocalPermissionState = .unknown
    @Published var requesting = false
    @Published var error: String?
    func refresh() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined: camera = .notRequested
        case .authorized: camera = .allowed
        case .denied: camera = .denied
        case .restricted: camera = .restricted
        @unknown default: camera = .unknown
        }
        switch AVAudioApplication.shared.recordPermission {
        case .undetermined: microphone = .notRequested
        case .granted: microphone = .allowed
        case .denied: microphone = .denied
        @unknown default: microphone = .unknown
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .notDetermined: speech = .notRequested
        case .authorized: speech = .allowed
        case .denied: speech = .denied
        case .restricted: speech = .restricted
        @unknown default: speech = .unknown
        }
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .notDetermined: addPhotos = .notRequested
        case .authorized, .limited: addPhotos = .allowed
        case .denied: addPhotos = .denied
        case .restricted: addPhotos = .restricted
        @unknown default: addPhotos = .unknown
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: notifications = .notRequested
        case .authorized, .ephemeral: notifications = .allowed
        case .provisional: notifications = .quiet
        case .denied: notifications = .denied
        @unknown default: notifications = .unknown
        }
    }
    enum Kind { case camera, microphone, speech, photos, notifications }
    func request(_ kind: Kind) async {
        guard !requesting else { return }; requesting = true; defer { requesting = false }
        switch kind {
        case .camera: _ = await AVCaptureDevice.requestAccess(for: .video)
        case .microphone: _ = await AVAudioApplication.requestRecordPermission()
        case .speech: _ = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        case .photos: _ = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        case .notifications:
            do { _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
            catch { self.error = "无法申请通知权限：\(error.localizedDescription)" }
        }
        await refresh()
    }
    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url) { [weak self] opened in
            if !opened { Task { @MainActor in self?.error = "未能打开设置，请到 iPhone 设置 → App → Melo 查看权限。" } }
        }
    }
}

struct LocalPermissionsCard: View {
    @State private var showing = false
    var body: some View {
        Button { showing = true } label: {
            HStack(spacing: 14) {
                Image(systemName: "hand.raised").foregroundStyle(meloGold)
                VStack(alignment: .leading, spacing: 6) {
                    Text("权限与文件").font(.headline)
                    Text("系统授权 · 本机文件 · 文件夹访问").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(); Image(systemName: "chevron.right").font(.caption)
            }.frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(.plain).meloPanel()
            .sheet(isPresented: $showing) { LocalPermissionsView() }
    }
}

struct LocalPermissionsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var permissions = LocalPermissions()
    @State private var files = false
    @AppStorage("melo.notifications") private var notificationsEnabled = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("按需授权，随时查看").font(.title2.bold())
                    Text("进入此页面不会申请权限。只有你点击允许或使用相应功能时，才会出现系统确认。").font(.subheadline).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 14) {
                        Label("文件与文件夹", systemImage: "folder").font(.headline)
                        Text("通过系统“文件”选择器访问你选中的内容。可记住指定文件夹，也可随时移除授权；无法读取其他 App 的私有数据。").font(.caption).foregroundStyle(.secondary)
                        Button { files = true } label: { Label("打开本机文件", systemImage: "folder.badge.plus").frame(minHeight: 44) }
                        Text("预览在本机完成。添加为知识资料并在对话中选用后，相关文字才会随请求发送给模型；已配置的资料同步也适用。").font(.caption).foregroundStyle(.secondary)
                    }.meloPanel()
                    permissionRow("麦克风", symbol: "mic", state: permissions.microphone, detail: Text("仅用于点击语音输入后的录音。自动朗读不需要麦克风。"), kind: .microphone)
                    permissionRow("相机", symbol: "camera", state: permissions.camera, detail: Text("确认照片后加入草稿，点击发送才会交给模型。"), kind: .camera)
                    permissionRow("语音识别", symbol: "waveform", state: permissions.speech, detail: Text("把说话内容转为可编辑文字。依语言和设备情况，Apple 识别服务可能联网处理音频。"), kind: .speech)
                    VStack(alignment: .leading, spacing: 10) {
                        Label("选择照片", systemImage: "photo.on.rectangle").font(.headline)
                        Text("仅访问你选中的照片").font(.caption.bold()).foregroundStyle(.green)
                        Text("对话选图使用系统照片选择器，无需允许读取整个相册，也不需要先打开相册权限。").font(.caption).foregroundStyle(.secondary)
                    }.meloPanel()
                    permissionRow("保存到照片", symbol: "square.and.arrow.down", state: permissions.addPhotos, detail: Text("只添加你点击保存的图片，不读取相册其他内容。"), kind: .photos)
                    VStack(alignment: .leading, spacing: 10) {
                        Label("网页访问", systemImage: "globe").font(.headline)
                        Text("随 Agent 的“联网搜索”开关").font(.caption.bold()).foregroundStyle(.secondary)
                        Text("开启后，Melo 可在这台 iPhone 上后台打开网页读取正文或截图，用来查看链接内容；只接受公开的 http/https 地址，会拒绝 localhost、私网和链路本地地址，但不能防范 DNS 重绑定等解析层绕过。网页正文和截图会随本次请求发送给当前模型服务。").font(.caption).foregroundStyle(.secondary)
                    }.meloPanel()
                    CapabilityGrantsPanel()
                    permissionRow("通知", symbol: "bell", state: permissions.notifications, detail: Text("后台回复完成时提醒。Melo 的通知偏好目前\(notificationsEnabled ? Text("已开启") : Text("未开启，可在通用与外观中编辑保存"))；系统允许通知不会自动修改该偏好。"), kind: .notifications)
                    Text("系统权限只影响对应功能，拒绝后仍可使用其他功能。后台执行仍受 iOS 调度、低电量和强制退出等限制。").font(.caption).foregroundStyle(.secondary)
                }.padding(20)
            }.background(MeloTheme.dialog).navigationTitle("权限与文件").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .task { await permissions.refresh() }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await permissions.refresh() } } }
                .sheet(isPresented: $files) { LocalFilesView() }
                .alert("权限设置", isPresented: Binding(get: { permissions.error != nil }, set: { if !$0 { permissions.error = nil } })) { Button("知道了") { permissions.error = nil } } message: { Text(permissions.error ?? "") }
        }
    }
    /// `title` and the state title are catalog keys (LocalizedStringKey), so
    /// the rows follow the interface language like the rest of the page.
    private func permissionRow(_ title: String, symbol: String, state: LocalPermissionState, detail: Text, kind: LocalPermissions.Kind) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Label(LocalizedStringKey(title), systemImage: symbol).font(.headline); Spacer(); Text(LocalizedStringKey(state.title)).font(.caption.bold()).foregroundStyle(state.color) }
            detail.font(.caption).foregroundStyle(.secondary)
            if state == .notRequested {
                Button { Task { await permissions.request(kind) } } label: { Text("允许\(Text(LocalizedStringKey(title)))") }.disabled(permissions.requesting).frame(minHeight: 40)
            } else if state == .restricted {
                Button("查看系统限制") { permissions.openSettings() }.frame(minHeight: 40)
            } else if state != .unknown {
                Button("在系统设置中管理") { permissions.openSettings() }.frame(minHeight: 40)
            }
        }.meloPanel()
    }
}
