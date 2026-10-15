import SwiftUI
import UniformTypeIdentifiers
import UserNotifications
import AVFoundation

struct LocalProfileBadge: View {
    @AppStorage("melo.localName") private var name = "你"
    @AppStorage("melo.localAvatar") private var avatar = ""
    var size: CGFloat = 28
    var body: some View {
        AgentAvatar(agent: AgentProfile(name: name, subtitle: "", symbol: "person.crop.circle", instructions: "", avatarData: avatar.isEmpty ? nil : Data(base64Encoded: avatar)), size: size)
    }
}

struct ProfileSettingsValue: Equatable, Codable {
    var name = "你"
    var avatar: Data?
    static func read() -> Self { .init(name: UserDefaults.standard.string(forKey: "melo.localName") ?? "你", avatar: Data(base64Encoded: UserDefaults.standard.string(forKey: "melo.localAvatar") ?? "")) }
}
struct LocalProfileSettings: View {
    var body: some View {
        EditableSection("个人资料", read: ProfileSettingsValue.read, commit: { value in
            var value = value; value.name = value.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.name.isEmpty, value.name.count <= 40, !value.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw MeloError.message("昵称请输入 1–40 个字符。") }
            UserDefaults.standard.set(value.name, forKey: "melo.localName"); UserDefaults.standard.set(value.avatar?.base64EncodedString() ?? "", forKey: "melo.localAvatar")
            return value
        }) { value, editing in
            if editing {
                AvatarPicker(agent: Binding(get: { AgentProfile(name: value.wrappedValue.name, subtitle: "", symbol: "person.crop.circle", instructions: "", avatarData: value.wrappedValue.avatar) }, set: { value.wrappedValue.avatar = $0.avatarData }))
                TextField("你的昵称", text: value.name).textContentType(.nickname).meloInput()
            } else { HStack { LocalProfileBadge(size: 56); Text(value.wrappedValue.name).font(.title3) } }
            Text("头像与昵称保存在此 iPhone，与你的角色独立。无需 Melo 账号。").font(.caption).foregroundStyle(.secondary)
        }.meloPanel()
    }
}
struct GeneralSettingsValue: Equatable, Codable {
    var interfaceLanguage = "zh-CN"
    var textSize = "system"
    var reduceMotion = false
    var notifications = false
    init(interfaceLanguage: String = "zh-CN", textSize: String = "system", reduceMotion: Bool = false, notifications: Bool = false) {
        self.interfaceLanguage = interfaceLanguage; self.textSize = textSize
        self.reduceMotion = reduceMotion; self.notifications = notifications
    }
    enum CodingKeys: String, CodingKey { case interfaceLanguage, textSize, reduceMotion, notifications }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        // Existing saved edit drafts predate the interface language preference.
        interfaceLanguage = InterfaceLanguage.resolve(try values.decodeIfPresent(String.self, forKey: .interfaceLanguage)).rawValue
        textSize = try values.decodeIfPresent(String.self, forKey: .textSize) ?? "system"
        reduceMotion = try values.decodeIfPresent(Bool.self, forKey: .reduceMotion) ?? false
        notifications = try values.decodeIfPresent(Bool.self, forKey: .notifications) ?? false
    }
    static func read() -> Self { .init(interfaceLanguage: InterfaceLanguage.resolve(UserDefaults.standard.string(forKey: "melo.interfaceLanguage")).rawValue, textSize: UserDefaults.standard.string(forKey: "melo.textSize") ?? "system", reduceMotion: UserDefaults.standard.bool(forKey: "melo.reduceMotion"), notifications: UserDefaults.standard.bool(forKey: "melo.notifications")) }
}
struct LocalGeneralSettings: View {
    var body: some View {
        DisclosureGroup {
            EditableSection("外观与通知", read: GeneralSettingsValue.read, commit: { value in
                if value.notifications {
                    let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                    guard allowed else { throw MeloError.message("系统未允许通知，其他修改尚未保存。可关闭通知选项后保存，或到系统设置开启权限。") }
                }
                UserDefaults.standard.set(value.interfaceLanguage, forKey: "melo.interfaceLanguage")
                UserDefaults.standard.set(value.textSize, forKey: "melo.textSize")
                UserDefaults.standard.set(value.reduceMotion, forKey: "melo.reduceMotion")
                UserDefaults.standard.set(value.notifications, forKey: "melo.notifications")
                return value
            }) { value, _ in
                Picker("界面语言", selection: value.interfaceLanguage) { ForEach(InterfaceLanguage.allCases) { language in Text(verbatim: language.name).tag(language.rawValue) } }
                Text("仅改变界面文字，聊天内容与模型回复语言不受影响。").font(.caption).foregroundStyle(.secondary)
                Picker("文字大小", selection: value.textSize) { Text("跟随系统").tag("system"); Text("大").tag("large"); Text("更大").tag("larger") }
                Toggle("减少动态效果", isOn: value.reduceMotion)
                Toggle("后台回复完成通知", isOn: value.notifications)
                Text("系统已开启减少动态效果时，Melo 始终遵循。保存时才申请通知权限。").font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 16)
            Button("打开系统权限设置") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }.padding(.top, 12)
        } label: { Label("通用与外观", systemImage: "slider.horizontal.3").font(.headline) }.meloPanel()
    }
}
struct VoiceSettingsValue: Equatable, Codable {
    var language = "zh-CN"
    var autoSpeak = false
    static func read() -> Self { .init(language: UserDefaults.standard.string(forKey: "melo.voiceLanguage") ?? "zh-CN", autoSpeak: UserDefaults.standard.bool(forKey: "melo.autoSpeak")) }
}
struct LocalVoiceSettings: View {
    @ObservedObject private var device = LocalDeviceServices.shared
    @State private var expanded: Bool
    init(initiallyExpanded: Bool = false) { _expanded = State(initialValue: initiallyExpanded) }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            EditableSection("语音偏好", read: VoiceSettingsValue.read, commit: { value in
                UserDefaults.standard.set(value.language, forKey: "melo.voiceLanguage"); UserDefaults.standard.set(value.autoSpeak, forKey: "melo.autoSpeak")
                if !value.autoSpeak { LocalDeviceServices.shared.stopSpeech() }; return value
            }) { value, _ in
                Picker("语音输入语言", selection: value.language) { Text("中文").tag("zh-CN"); Text("English").tag("en-US"); Text("系统语言").tag("system") }
                Toggle("在前台自动朗读回复", isOn: value.autoSpeak)
                Text("此开关仅用于这台 iPhone，点击保存后对新回复生效。朗读使用系统语音，不需要麦克风权限；请检查媒体音量及耳机输出。").font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 16)
            HStack {
                Button("试听朗读") { device.previewSpeech() }
                Button("停止朗读") { device.stopSpeech() }.disabled(!device.speechActive)
            }.padding(.top, 12)
            if !device.speechStatus.isEmpty { Text(device.speechStatus).font(.caption).foregroundStyle(device.speechFailed ? Color.red : .secondary).accessibilityAddTraits(.updatesFrequently) }
            Button("打开麦克风与语音权限设置") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }.padding(.top, 8)
        } label: { Label("语音", systemImage: "waveform").font(.headline) }.meloPanel()
    }
}

struct PortableArchive: Codable {
    var format = "melo-portable-workspace"
    var version = 1
    var exportedAt = timestamp()
    var snapshot: SyncSnapshot
    func validate() throws {
        guard format == "melo-portable-workspace", version == 1, snapshot.version == 1 else { throw MeloError.message("请选择 Melo 导出的可迁移资料文件。") }
        _ = try merge([], snapshot.chats, deletedChats: snapshot.deletedChats ?? [])
        if let workspace = snapshot.workspace { _ = try SyncWorkspace().merging(workspace) }
    }
}
struct LocalArchiveDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data = Data()) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
struct LocalDataSettings: View {
    @EnvironmentObject var store: ChatStore
    @State private var exporting = false
    @State private var importing = false
    @State private var document = LocalArchiveDocument()
    @State private var pending: PortableArchive?
    @State private var status = ""
    @State private var error: String?
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 14) {
                Text("\(store.chats.count) 段对话 · \(store.preferences.agents.count) 个角色").font(.subheadline)
                Text("可导出对话、角色、项目、共享资料与来源记录。不包含模型密钥、原始附件、电脑文件与权限；这不是整机备份。").font(.caption).foregroundStyle(.secondary)
                Button("导出可迁移资料") { do { document = LocalArchiveDocument(data: try store.exportLocalArchive()); exporting = true } catch { self.error = error.localizedDescription } }.disabled(store.sendingID != nil || store.syncing)
                Button("导入资料文件") { importing = true }.disabled(store.sendingID != nil || store.syncing)
                if let value = pending {
                    Text("将合并 \(value.snapshot.chats.count) 段对话，保留当前资料与模型连接。").font(.caption)
                    Button("确认合并") { do { try store.importLocalArchive(value); pending = nil; status = "资料已合并；冲突可在同步区域查看。" } catch { self.error = error.localizedDescription } }.disabled(store.sendingID != nil || store.syncing)
                    Button("取消") { pending = nil }
                }
                Button("清理网页临时缓存") { Task { await LocalDeviceServices.clearWebCache(); status = "网页临时缓存已清理，聊天与登录凭据保留。" } }
                if !status.isEmpty { Text(status).font(.caption).foregroundStyle(meloGold) }
            }.padding(.top, 16)
        } label: { Label("本机数据管理", systemImage: "externaldrive").font(.headline) }.meloPanel()
        .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "Melo-资料") { result in if case .failure(let e) = result { error = e.localizedDescription } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get(), access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 16 * 1024 * 1024 else { throw MeloError.message("资料文件超过 16 MB。") }
                let data = try Data(contentsOf: url); guard data.count <= 16 * 1024 * 1024 else { throw MeloError.message("资料文件超过 16 MB。") }
                let archive = try JSONDecoder().decode(PortableArchive.self, from: data); try archive.validate(); pending = archive
            } catch { self.error = error.localizedDescription }
        }
        .alert("资料管理", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("好") { error = nil } } message: { Text(error ?? "") }
    }
}

import WebKit
@MainActor final class LocalDeviceServices: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = LocalDeviceServices()
    private let speaker = AVSpeechSynthesizer()
    @Published private(set) var speechStatus = ""
    @Published private(set) var speechFailed = false
    @Published private(set) var speechActive = false
    private var currentUtterance: AVSpeechUtterance?
    private var startTimeout: Task<Void, Never>?

    override init() {
        super.init()
        // Speech owns a system-managed playback session. Dictation may leave
        // the application session in .record; it must not mute synthesis.
        speaker.usesApplicationAudioSession = false
        speaker.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(leavingForeground), name: UIApplication.willResignActiveNotification, object: nil)
    }
    @objc private func leavingForeground() { stopSpeech() }
    func stopSpeech() {
        let wasActive = currentUtterance != nil
        currentUtterance = nil; startTimeout?.cancel(); startTimeout = nil
        speaker.stopSpeaking(at: .immediate)
        speechActive = false
        if wasActive { speechStatus = "已停止朗读"; speechFailed = false }
    }
    func previewSpeech() { speak("你好，这是 Melo 的朗读试听。你可以用手机媒体音量调整声音。") }
    private func speak(_ text: String) {
        guard UIApplication.shared.applicationState == .active else { return }
        let plain = ReplyDocument.plainText(text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !plain.isEmpty else { return }
        stopSpeech()
        let utterance = AVSpeechUtterance(string: plain)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.preferredLanguages.first)
        currentUtterance = utterance; speechActive = true; speechFailed = false; speechStatus = "正在准备朗读…"
        speaker.speak(utterance)
        startTimeout = Task { [weak self, weak utterance] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled, let self, let utterance, self.currentUtterance === utterance else { return }
            self.stopSpeech(); self.speechFailed = true
            self.speechStatus = "系统朗读未能启动，请重试试听或在 iPhone 设置中检查语音资源。回复已保留。"
        }
    }
    func completed(text: String, background: Bool) {
        if background {
            guard UserDefaults.standard.bool(forKey: "melo.notifications") else { return }
            let content = UNMutableNotificationContent(); content.title = "Melo 回复已完成"; content.body = "打开 Melo 查看结果。"; content.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        } else if UserDefaults.standard.bool(forKey: "melo.autoSpeak") { speak(text) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.currentUtterance === utterance else { return }
            self.startTimeout?.cancel(); self.startTimeout = nil; self.speechStatus = "正在朗读"
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finish(utterance, status: "朗读已完成") }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finish(utterance, status: "朗读已中断，可重新试听") }
    nonisolated private func finish(_ utterance: AVSpeechUtterance, status: String) {
        Task { @MainActor [weak self] in
            guard let self, self.currentUtterance === utterance else { return }
            self.currentUtterance = nil; self.startTimeout?.cancel(); self.startTimeout = nil
            self.speechActive = false; self.speechStatus = status
        }
    }
    #if DEBUG && targetEnvironment(simulator)
    var usesIndependentSpeechSession: Bool { !speaker.usesApplicationAudioSession }
    #endif
    static func clearWebCache() async {
        await WKWebsiteDataStore.default().removeData(ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache], modifiedSince: .distantPast)
    }
}
