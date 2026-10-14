import SwiftUI

@main struct MeloApp: App {
    @Environment(\.dynamicTypeSize) private var systemTextSize
    @AppStorage("melo.textSize") private var textSize = "system"
    private var effectiveTextSize: DynamicTypeSize { textSize == "large" ? max(systemTextSize,.xLarge) : textSize == "larger" ? max(systemTextSize,.xxxLarge) : systemTextSize }
    @StateObject private var store = ChatStore()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(store).environmentObject(store.account).preferredColorScheme(.dark)
                .environment(\.dynamicTypeSize,effectiveTextSize)
                .tint(meloAccent).foregroundStyle(MeloTheme.text)
                .task {
                    RuntimeDiagnostics.journal.record("launch", requestActive: store.sendingID != nil)
                    #if DEBUG && targetEnvironment(simulator)
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-interactions") { InteractionVerification.run(); InteractionVerification.seed(store); InteractionVerification.seedReview(store) }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-sync-audit") { await SyncAuditVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-images") { await ImageWorkflowVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-preview-images") { ImageWorkflowVerification.seedPreview(store) }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-speech-playback") { await SpeechPlaybackVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-local-settings") { await LocalSettingsVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-conversation") { await ConversationVerification.run() }
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-background") { await ReplyBackgroundVerification.run() }
                    #endif
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("-melo-verify-search") {
                        await store.verifySearch()
                    }
                    #endif
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.willTerminateNotification)) { _ in RuntimeDiagnostics.journal.record("termination-callback", requestActive: store.sendingID != nil) }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in RuntimeDiagnostics.journal.record("memory-warning", requestActive: store.sendingID != nil) }
                .onChange(of: store.sendingID) { _, id in RuntimeDiagnostics.journal.record(id == nil ? "request-end" : "request-start", requestActive: id != nil) }
                .onChange(of: scenePhase) { _, phase in
                    RuntimeDiagnostics.journal.record(phase == .background ? "background" : phase == .active ? "active" : "inactive", requestActive: store.sendingID != nil)
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
