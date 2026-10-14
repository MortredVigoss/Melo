import SwiftUI
import WebKit

struct NeuralWebView: UIViewRepresentable {
    var selected: Int
    var transmitting: Bool
    var compact: Bool
    var frames: [Int: CGRect]
    var hover: Int
    var tap: NeuralTap?
    var still: Bool
    var select: (Int) -> Void
    var failure: () -> Void
    var loaded: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(select: select, failure: failure, loaded: loaded) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator, name: "meloNeural")
        config.userContentController.addUserScript(WKUserScript(source: """
        window.__meloNeuralPost = value => window.webkit.messageHandlers.meloNeural.postMessage({...value, bridgeToken: '\(context.coordinator.token)'});
        window.addEventListener('error', () => window.__meloNeuralPost({type:'renderError'}));
        window.addEventListener('unhandledrejection', () => window.__meloNeuralPost({type:'renderError'}));
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false; view.scrollView.contentInsetAdjustmentBehavior = .never
        view.navigationDelegate = context.coordinator
        context.coordinator.view = view
        context.coordinator.load()
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.select = select; coordinator.failure = failure; coordinator.loaded = loaded
        var rectangles: [String: Any] = [:]
        for (id, f) in frames where [f.minX, f.minY, f.width, f.height].allSatisfy({ $0.isFinite }) {
            rectangles[String(id)] = ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height]
        }
        var value: [String: Any] = ["selected": selected, "transmitting": transmitting, "compact": compact, "frames": rectangles, "hover": hover, "still": still]
        if let tap { value["tap"] = ["id": tap.id, "x": tap.point.x, "y": tap.point.y] }
        coordinator.payload = value; coordinator.send()
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.timeout?.cancel()
        view.evaluateJavaScript("window.meloNeuralDispose?.()")
        view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "meloNeural")
        view.navigationDelegate = nil; coordinator.view = nil
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var view: WKWebView?
        let token = UUID().uuidString
        var entry: URL?
        var payload: [String: Any] = [:]
        var lastPayload: Data?
        var ready = false
        var recoveries = 0
        var timeout: Task<Void, Never>?
        var select: (Int) -> Void
        var failure: () -> Void
        var loaded: () -> Void
        init(select: @escaping (Int) -> Void, failure: @escaping () -> Void, loaded: @escaping () -> Void) {
            self.select = select; self.failure = failure; self.loaded = loaded
        }
        func load() {
            ready = false; lastPayload = nil; timeout?.cancel()
            guard let url = Bundle.main.url(forResource: "neural", withExtension: "html", subdirectory: "Scene") else {
                DispatchQueue.main.async { [weak self] in self?.failure() }; return
            }
            entry = url
            timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(12)) } catch { return }
                self?.failure()
            }
            view?.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        func send() {
            guard ready, let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]), data != lastPayload else { return }
            lastPayload = data
            let value = payload
            Task { @MainActor [weak self] in
                do { _ = try await self?.view?.callAsyncJavaScript("window.meloNeuralReceive(value)", arguments: ["value": value], in: nil, contentWorld: .page) }
                catch { self?.lastPayload = nil; self?.failure() }
            }
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.webView === view, message.frameInfo.isMainFrame,
                  ExecutionPagePolicy.allows(message.frameInfo.request.url, entry: entry),
                  let body = message.body as? [String: Any], body["bridgeToken"] as? String == token else { return }
            switch body["type"] as? String {
            case "ready": ready = true; send()
            case "rendered": timeout?.cancel(); loaded()
            case "select": if let id = body["id"] as? Int, NeuralModule.all.contains(where: { $0.id == id }) { select(id) }
            case "renderError": timeout?.cancel(); failure()
            default: break
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(ExecutionPagePolicy.allows(action.request.url, entry: entry) ? .allow : .cancel)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // Recover only this off-line view, never the app or the in-flight reply.
            if recoveries < 1 { recoveries += 1; load() } else { timeout?.cancel(); failure() }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { timeout?.cancel(); failure() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { timeout?.cancel(); failure() }
    }
}
