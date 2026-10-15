import SwiftUI
import WebKit

struct ExecutionWorkspace: View {
    @EnvironmentObject var store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage("melo.reduceMotion") private var localReduceMotion = false
    private var reduceMotion: Bool { systemReduceMotion || localReduceMotion }
    @Environment(\.scenePhase) private var phase
    let chatID: String
    var runID: String?
    @State private var sourcePage: SourcePage?
    @State private var showSpeechSettings = false
    @State private var renderFailed = false
    @State private var loading = true
    @State private var generation = 0
    private var records: [ExecutionRecord] { store.scenes(for: chatID) }
    var body: some View {
        NavigationStack {
            ZStack {
                meloBackground.ignoresSafeArea()
                if renderFailed {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("三维画面暂不可用，执行记录仍可查看。").foregroundStyle(.secondary)
                            Button("重新加载场景") { renderFailed = false; loading = true; generation += 1 }.buttonStyle(.bordered)
                            if records.isEmpty { Text("当前对话还没有任务记录。").foregroundStyle(.secondary) }
                            ForEach(records.reversed()) { record in
                                Text(record.query).font(.headline)
                                Text("\(record.status) · \(record.operations.count) 次实际调用").font(.caption)
                                ForEach(record.sources) { source in
                                    Button(source.title) { if let url = URL(string: source.citationUrl ?? source.url) { sourcePage = SourcePage(url: url) } }.multilineTextAlignment(.leading)
                                }
                            }
                        }.padding()
                    }
                } else {
                    ExecutionWebView(chatID: chatID, runID: runID, records: records, views: store.preferences.executionViews ?? [:], saveView: { id, value in
                        guard records.contains(where: { $0.runId == id }) else { return }
                        store.updatePreferences { if $0.executionViews == nil { $0.executionViews = [:] }; $0.executionViews?[id] = value }
                    }, still: reduceMotion || phase != .active, open: { sourcePage = SourcePage(url: $0) }, speechSettings: { showSpeechSettings = true }, loaded: { loading = false }, failure: { loading = false; renderFailed = true }).id(generation)
                    if loading { ProgressView("正在加载任务空间…").tint(meloAccent).padding(24).background(meloBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 18)) }
                }
            }
            .navigationTitle("任务空间").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("回到对话") { dismiss() } } }
            .sheet(item: $sourcePage) { SourceBrowser(url: $0.url).ignoresSafeArea() }
            .sheet(isPresented: $showSpeechSettings) {
                NavigationStack {
                    ScrollView { LocalVoiceSettings(initiallyExpanded: true).padding() }
                        .background(meloBackground).navigationTitle("语音设置").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showSpeechSettings = false } } }
                }.preferredColorScheme(.dark).tint(meloAccent)
            }
        }.tint(meloAccent).preferredColorScheme(.dark)
    }
}

struct ExecutionWebView: UIViewRepresentable {
    @AppStorage("melo.interfaceLanguage") private var interfaceLanguage = "zh-CN"
    let chatID: String
    let runID: String?
    let records: [ExecutionRecord]
    let views: [String: ExecutionViewPreference]
    let saveView: (String, ExecutionViewPreference) -> Void
    let still: Bool
    let open: (URL) -> Void
    let speechSettings: () -> Void
    let loaded: () -> Void
    let failure: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(open: open, loaded: loaded, failure: failure, saveView: saveView, speechSettings: speechSettings) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator, name: "meloScene")
        let bootstrap = """
        window.__meloPost = value => window.webkit.messageHandlers.meloScene.postMessage({...value, bridgeToken: '\(context.coordinator.bridgeToken)'});
        window.addEventListener('error', () => window.__meloPost({type:'renderError', stage:'script-error'}));
        window.addEventListener('unhandledrejection', () => window.__meloPost({type:'renderError', stage:'script-rejection'}));
        """
        config.userContentController.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false; view.navigationDelegate = context.coordinator
        context.coordinator.view = view
        guard let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Scene") else { DispatchQueue.main.async { failure() }; return view }
        context.coordinator.entry = url
        context.coordinator.begin()
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        let encoder = JSONEncoder()
        guard let data = try? encoder.encode(records), let array = try? JSONSerialization.jsonObject(with: data) else { return }
        var value: [String: Any] = ["interfaceLanguage": InterfaceLanguage.resolve(interfaceLanguage).rawValue, "chat": ["id": chatID, "messages": []], "scenes": array, "runId": runID as Any? ?? NSNull(), "still": still]
        if let viewData = try? encoder.encode(views), let saved = try? JSONSerialization.jsonObject(with: viewData) { value["views"] = saved }
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-melo-preview-execution") { value["preview"] = ProcessInfo.processInfo.arguments.contains("-melo-preview-sources") ? "sources" : "overview" }
        #endif
        context.coordinator.payload = value; context.coordinator.send()
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.timeout?.cancel()
        view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "meloScene")
        view.navigationDelegate = nil; coordinator.view = nil
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var view: WKWebView?
        var entry: URL?
        let bridgeToken = UUID().uuidString
        var timeout: Task<Void, Never>?
        var ready = false
        var presented = false
        var payload: [String: Any] = [:]
        var lastPayload: Data?
        let open: (URL) -> Void
        let loaded: () -> Void
        let failure: () -> Void
        let saveView: (String, ExecutionViewPreference) -> Void
        let speechSettings: () -> Void
        init(open: @escaping (URL) -> Void, loaded: @escaping () -> Void, failure: @escaping () -> Void, saveView: @escaping (String, ExecutionViewPreference) -> Void, speechSettings: @escaping () -> Void) { self.open = open; self.loaded = loaded; self.failure = failure; self.saveView = saveView; self.speechSettings = speechSettings }
        private var health: [[String: Any]] = []
        func note(_ stage: String, details: [String: Any] = [:]) {
            var item = details; item["stage"] = stage; item["at"] = timestamp()
            health.append(item); health = Array(health.suffix(20))
            let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Melo")
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            if let data = try? JSONSerialization.data(withJSONObject: health) { try? data.write(to: folder.appendingPathComponent("scene-health.json"), options: [.atomic, .completeFileProtection]) }
        }
        func begin() {
            note("loading")
            timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(12)) } catch { return }
                guard let self, !self.presented else { return }
                self.fail("loading-timeout")
            }
        }
        func fail(_ stage: String) { timeout?.cancel(); note(stage); failure() }
        func send() {
            guard ready, payload["chat"] != nil, let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]), data != lastPayload else { return }
            lastPayload = data
            let value = payload
            Task { @MainActor [weak self] in
                do { _ = try await self?.view?.callAsyncJavaScript("window.meloReceive(value)", arguments: ["value": value], in: nil, contentWorld: .page); self?.note("payload-applied") }
                catch { self?.note("javascript-call-error", details: ["code": (error as NSError).code]); self?.fail("render-failed") }
            }
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.webView === view, message.frameInfo.isMainFrame, let body = message.body as? [String: Any], body["bridgeToken"] as? String == bridgeToken else { return }
            switch body["type"] as? String {
            case "view":
                if let id = body["runID"] as? String, let value = body["value"] as? [String: Any],
                   let data = try? JSONSerialization.data(withJSONObject: value), var preference = try? JSONDecoder().decode(ExecutionViewPreference.self, from: data) {
                    preference.zoom = min(2.6, max(0.65, preference.zoom.isFinite ? preference.zoom : 1))
                    if !["search", "compute", "files", "tools", "create"].contains(preference.focus ?? "") { preference.focus = nil }
                    saveView(id, preference)
                }
            case "testReport":
                #if DEBUG && targetEnvironment(simulator)
                if ProcessInfo.processInfo.arguments.contains("-melo-preview-execution"), let data = try? JSONSerialization.data(withJSONObject: body) {
                    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("scene-preview-report.json")
                    try? data.write(to: url, options: .atomic)
                }
                #endif
            case "ready": note("bridge-ready"); ready = true; send()
            case "rendered":
                guard !presented else { return }
                presented = true; timeout?.cancel()
                note("rendered", details: ["modules": body["modules"] as? Int ?? 0, "frames": body["frames"] as? String ?? "0", "fallback": body["fallback"] as? Bool ?? false])
                loaded()
            case "renderError": fail("script-error")
            case "openURL":
                if let text = body["url"] as? String, WebSource.validated(title: "", url: text) != nil, let url = URL(string: text) { open(url) }
            case "speechSettings": speechSettings()
            default: break
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let allowed = ExecutionPagePolicy.allows(navigationAction.request.url, entry: entry)
            note(allowed ? "navigation-allowed" : "navigation-rejected")
            decisionHandler(allowed ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            note("navigation-finished")
            webView.evaluateJavaScript("typeof window.meloReceive === 'function'") { [weak self] result, error in
                guard let self else { return }
                guard error == nil, result as? Bool == true else { self.fail("bundle-not-ready"); return }
                self.ready = true; self.send()
            }
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("web-content-terminated") }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("navigation-failed") }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("navigation-failed") }
    }
}

struct AtomicButton: View {
    var busy: Bool
    var action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @AppStorage("melo.reduceMotion") private var localReduceMotion = false
    private var reduceMotion: Bool { systemReduceMotion || localReduceMotion }
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Button(action: action) {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || phase != .active)) { time in
                Canvas { context, size in
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    let t = reduceMotion ? 0 : time.date.timeIntervalSinceReferenceDate
                    let colors = [meloAccent, Color.cyan.opacity(0.8), Color.purple.opacity(0.8)]
                    for i in 0..<3 {
                        let angle = Double(-26 + i * 65) * .pi / 180
                        func point(_ a: Double) -> CGPoint { let x = cos(a) * 17, y = sin(a) * 7; return CGPoint(x: center.x + x*cos(angle)-y*sin(angle), y: center.y + x*sin(angle)+y*cos(angle)) }
                        var path = Path(); path.move(to: point(0)); for step in 1...70 { path.addLine(to: point(Double(step) / 70 * .pi * 2)) }
                        context.stroke(path, with: .color(colors[i].opacity(0.5)), lineWidth: 0.6)
                        let electron = point(t * .pi * 2 / (busy ? 1.7 : [3.4,4.4,5.1][i]) + Double(i))
                        context.drawLayer { layer in layer.addFilter(.shadow(color: colors[i], radius: 3)); layer.fill(Path(ellipseIn: CGRect(x: electron.x-1.6,y: electron.y-1.6,width:3.2,height:3.2)),with:.color(colors[i])) }
                    }
                    context.drawLayer { layer in layer.addFilter(.shadow(color: meloAccent, radius: 6)); layer.fill(Path(ellipseIn: CGRect(x:center.x-4,y:center.y-4,width:8,height:8)),with:.color(meloAccent)) }
                }.frame(width: 44, height: 44)
            }
        }.background(meloGold.opacity(0.07), in: RoundedRectangle(cornerRadius: 14)).accessibilityLabel("打开任务空间")
    }
}
