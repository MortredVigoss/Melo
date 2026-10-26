import SwiftUI

@main struct MeloApp: App {
    init() {
        PhoneAgentPermissions.initializeAtLaunch()
    }

    @Environment(\.dynamicTypeSize) private var systemTextSize
    @AppStorage("melo.interfaceLanguage") private var interfaceLanguage = InterfaceLanguage.system.rawValue
    @AppStorage("melo.textSize") private var textSize = "system"
    private var effectiveTextSize: DynamicTypeSize { textSize == "large" ? max(systemTextSize,.xLarge) : textSize == "larger" ? max(systemTextSize,.xxxLarge) : systemTextSize }
    @StateObject private var store: ChatStore = {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-melo-preview-device-approval") { return DeviceDataVerification.approvalStore() }
        if ProcessInfo.processInfo.arguments.contains("-melo-preview-team") { return TeamVerification.previewStore() }
        if ProcessInfo.processInfo.arguments.contains("-melo-preview-topics") { return TopicPreview.store() }
        #endif
        return ChatStore()
    }()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(store).environmentObject(store.account).preferredColorScheme(.dark)
                .environment(\.dynamicTypeSize,effectiveTextSize)
                .environment(\.locale, Locale(identifier: InterfaceLanguage.resolve(interfaceLanguage).localeID))
                .tint(meloAccent).foregroundStyle(MeloTheme.text)
                .task {
                    RuntimeDiagnostics.journal.record("launch", requestActive: store.anySending)
                    #if DEBUG && targetEnvironment(simulator)
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-interactions") { InteractionVerification.run(); InteractionVerification.seed(store); InteractionVerification.seedReview(store) }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-sync-audit") { await SyncAuditVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-images") { await ImageWorkflowVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-preview-images") { ImageWorkflowVerification.seedPreview(store) }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-speech-playback") { await SpeechPlaybackVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-local-settings") { await LocalSettingsVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-local-files") { await LocalFileVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-conversation") { await ConversationVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-background") { await ReplyBackgroundVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-device-data") { await DeviceDataVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-team") { await TeamVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-parity") { await ParityVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-concurrency") { await ConcurrencyVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-media") { await MediaVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-preview-device-approval") { DeviceDataVerification.startApproval(store) }
                    #endif
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-search") {
                        await store.verifySearch()
                    }
                    #endif
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.willTerminateNotification)) { _ in RuntimeDiagnostics.journal.record("termination-callback", requestActive: store.anySending) }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in RuntimeDiagnostics.journal.record("memory-warning", requestActive: store.anySending) }
                .onChange(of: store.sendingChats.isEmpty) { _, idle in RuntimeDiagnostics.journal.record(idle ? "request-end" : "request-start", requestActive: !idle) }
                .onChange(of: scenePhase) { _, phase in
                    RuntimeDiagnostics.journal.record(phase == .background ? "background" : phase == .active ? "active" : "inactive", requestActive: store.anySending)
                    store.account.setApplicationActive(phase == .active)
                    if phase == .background { store.enteredBackground() }
                    if phase == .active {
                        store.becameActive()
                        // Keep account authorization and its settings view stable on return.
                        if !store.account.busy { Task { await store.sync() } }
                    }
                }
        }
    }
}
