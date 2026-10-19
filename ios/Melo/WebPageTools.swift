import Foundation
import UIKit
import WebKit

// Phone-side web page tools: a hidden WKWebView loads a public page, returns
// its readable text (open_url) or a JPEG screenshot (web_screenshot). Policy,
// paging and JSON shapes are in WebPageText.swift; this file is WebKit only.

struct WebPageToolResult {
    var output: String
    var image: UIImage? = nil
    var jpeg: Data? = nil
    var url: String = ""
    var phoneResult: PhoneToolResult { PhoneToolResult(output: output, imageJPEG: jpeg, imageURL: url) }
}

enum WebPageLoadError: Error {
    case invalidURL, timeout, failed(String)
}

/// One WKWebView per load. It is attached to the key window while loading
/// because WebKit only renders (and runs layout for innerText and snapshots)
/// when the view is in a visible window; a hidden view's layer tree is frozen
/// and snapshots come back blank, so the view is kept technically visible
/// (alpha 0.02, placed far off-screen, no touches) and removed when done.
@MainActor final class WebPageLoader: NSObject, WKNavigationDelegate {
    static let viewportSize = CGSize(width: 430, height: 932)
    static let offScreenOrigin = CGPoint(x: -10_000, y: 0)
    static let timeoutSeconds: Double = 20
    static let settleMilliseconds = 600
    /// Full-page capture height in points; at the 1× capture width this stays
    /// inside WebPageText.maxImageLongSide without rescaling.
    static let maxFullPageHeight: CGFloat = 4096
    nonisolated static let jpegQuality: CGFloat = 0.8
    static let noWindowMessage = "App 不在前台，无法渲染网页"
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    private let webView: WKWebView
    private var continuation: CheckedContinuation<Void, Error>?
    private var attachedTo: UIWindow?
    /// HTTP status of the main-frame response, when the server sent one.
    private(set) var statusCode: Int?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        webView = WKWebView(frame: CGRect(origin: Self.offScreenOrigin, size: Self.viewportSize), configuration: configuration)
        webView.isHidden = false
        webView.alpha = 0.02 // WebKit treats alpha < 0.01 like hidden
        webView.isUserInteractionEnabled = false
        webView.isAccessibilityElement = false
        webView.customUserAgent = Self.userAgent
        webView.isOpaque = true
        super.init()
        webView.navigationDelegate = self
    }

    private static var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first
    }
    /// False when no window is available (app not in the foreground): the page would never render.
    private func attach() -> Bool {
        if webView.superview != nil { return true }
        guard let window = Self.keyWindow else { return false }
        window.insertSubview(webView, at: 0)
        attachedTo = window
        return true
    }
    func detach() {
        webView.stopLoading()
        webView.removeFromSuperview()
        attachedTo = nil
    }

    /// Loads the page with a 20 s budget and a 600 ms settle after didFinish.
    /// Cancelling the task resumes the wait immediately instead of waiting
    /// for didFinish or the timeout.
    func load(_ url: URL) async throws {
        guard attach() else { throw WebPageLoadError.failed(Self.noWindowMessage) }
        try Task.checkCancellation()
        var request = URLRequest(url: url)
        request.timeoutInterval = Self.timeoutSeconds
        request.setValue("zh-CN,zh;q=0.9,en;q=0.8", forHTTPHeaderField: "Accept-Language")
        let timeout = Task { [weak self] in
            try await Task.sleep(for: .seconds(Self.timeoutSeconds))
            self?.finish(.failure(WebPageLoadError.timeout))
        }
        defer { timeout.cancel() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                self.continuation = continuation
                self.webView.load(request)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.webView.stopLoading()
                self?.finish(.failure(CancellationError()))
            }
        }
        try await Task.sleep(for: .milliseconds(Self.settleMilliseconds))
    }
    private func finish(_ result: Result<Void, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success(())) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(WebPageLoadError.failed(error.localizedDescription))) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(WebPageLoadError.failed(error.localizedDescription))) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Redirects and frames stay on public http/https pages; anything else is cancelled.
        let allowed = navigationAction.request.url.map { WebPageText.validated($0.absoluteString) != nil } ?? false
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // Downloads and non-page resources would never finish rendering. Error
        // pages (404, 500…) are rendered like any other page and the status is
        // reported in the result; only transport failures become LOAD_FAILED.
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse { statusCode = http.statusCode }
        let ok = navigationResponse.isForMainFrame ? navigationResponse.canShowMIMEType : true
        decisionHandler(ok ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(.failure(WebPageLoadError.failed("The page could not be rendered."))) }

    var finalURL: String { webView.url?.absoluteString ?? "" }

    struct Extracted { var title: String; var description: String; var text: String }

    /// Title, meta description and the main readable text, whitespace collapsed.
    func extractText() async throws -> Extracted {
        let script = """
        (() => {
          const meta = document.querySelector('meta[name="description"]');
          const root = document.querySelector('article, main') || document.body;
          const text = root ? (root.innerText || root.textContent || '') : '';
          return { title: document.title || '', description: meta ? (meta.getAttribute('content') || '') : '', text: text.slice(0, 400000) };
        })()
        """
        let value = try await webView.evaluateJavaScript(script)
        let object = value as? [String: Any] ?? [:]
        return Extracted(title: WebPageText.collapsed(object["title"] as? String ?? ""),
                         description: WebPageText.collapsed(object["description"] as? String ?? ""),
                         text: WebPageText.collapsed(object["text"] as? String ?? ""))
    }

    /// First screen, or the whole document up to 4 096 pt when fullPage is set.
    /// Captured at 1× (snapshotWidth = view width) so a full page is at most
    /// 430 × 4 096 px instead of a 3× bitmap of tens of megabytes.
    func snapshot(fullPage: Bool) async throws -> UIImage {
        if fullPage {
            let height = (try? await webView.evaluateJavaScript("Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)")) as? Double ?? 0
            let clamped = min(Self.maxFullPageHeight, max(Self.viewportSize.height, CGFloat(height)))
            if clamped != webView.frame.height {
                webView.frame = CGRect(origin: Self.offScreenOrigin, size: CGSize(width: Self.viewportSize.width, height: clamped))
                webView.setNeedsLayout(); webView.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(300))
            }
        }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = webView.bounds
        configuration.snapshotWidth = NSNumber(value: Double(webView.bounds.width))
        configuration.afterScreenUpdates = true
        return try await webView.takeSnapshot(configuration: configuration)
    }

    /// JPEG within WebPageText's pixel caps (1 600 px wide, 4 096 px long
    /// side), quality 0.8. Scaling and encoding run off the main actor.
    static func jpeg(_ image: UIImage) async -> Data? {
        await Task.detached(priority: .userInitiated) { encodeJPEG(image) }.value
    }
    nonisolated static func encodeJPEG(_ image: UIImage) -> Data? {
        let pixelWidth = Double(image.size.width * image.scale), pixelHeight = Double(image.size.height * image.scale)
        let target = WebPageText.scaledPixelSize(width: pixelWidth, height: pixelHeight)
        guard target.width > 0 else { return nil }
        var output = image
        if target.width != pixelWidth || target.height != pixelHeight || image.scale != 1 {
            let size = CGSize(width: target.width, height: target.height)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            output = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        }
        return output.jpegData(compressionQuality: jpegQuality)
    }
}

/// Executes open_url / web_screenshot for the model. Every result is the
/// shared tool envelope; nothing loads unless the address passes
/// WebPageText.validated and the Agent's network permission is still on.
@MainActor enum WebPageToolRunner {
    static func run(call: ResponsesFunctionCall, allowed: () -> Bool) async -> WebPageToolResult {
        guard let spec = WebPageToolSpec.named(call.name) else { return WebPageToolResult(output: WebPageText.failure("UNKNOWN_TOOL", "This phone tool does not exist.")) }
        guard allowed() else { return WebPageToolResult(output: WebPageText.failure("CAPABILITY_DENIED", "The user has not allowed web access for this Agent on this iPhone.")) }
        guard let data = call.arguments.data(using: .utf8), let args = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return WebPageToolResult(output: WebPageText.failure("INVALID_ARGS", "Arguments must be a JSON object."))
        }
        let raw = (args["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = WebPageText.validated(raw) else {
            return WebPageToolResult(output: WebPageText.failure("INVALID_URL", "Only public http or https pages can be opened.", url: String(raw.prefix(300))), url: raw)
        }
        let loader = WebPageLoader()
        defer { loader.detach() }
        do {
            try Task.checkCancellation()
            try await loader.load(url)
            try Task.checkCancellation()
            guard allowed() else { return WebPageToolResult(output: WebPageText.failure("CAPABILITY_DENIED", "The user disabled web access during the request.", url: raw), url: raw) }
            if spec.name == WebPageToolSpec.openURL {
                // Model-controlled number: 1e20 or NaN must not trap in Int().
                let page = WebPageText.pageNumber(args["page"])
                let extracted = try await loader.extractText()
                return WebPageToolResult(output: WebPageText.envelope(WebPageText.openResult(url: url.absoluteString, finalURL: loader.finalURL, title: extracted.title, description: extracted.description, text: extracted.text, page: page, status: loader.statusCode)), url: url.absoluteString)
            }
            let fullPage = args["fullPage"] as? Bool ?? false
            let image = try await loader.snapshot(fullPage: fullPage)
            try Task.checkCancellation()
            guard let jpeg = await WebPageLoader.jpeg(image) else { return WebPageToolResult(output: WebPageText.failure("LOAD_FAILED", "The page rendered but the screenshot could not be encoded.", url: raw), url: raw) }
            let title = (try? await loader.extractText().title) ?? ""
            return WebPageToolResult(output: WebPageText.envelope(WebPageText.screenshotResult(url: url.absoluteString, finalURL: loader.finalURL, title: title, status: loader.statusCode)), image: image, jpeg: jpeg, url: url.absoluteString)
        } catch is CancellationError {
            return WebPageToolResult(output: WebPageText.failure("ABORTED", "The request was cancelled.", url: raw), url: raw)
        } catch WebPageLoadError.timeout {
            return WebPageToolResult(output: WebPageText.failure("TIMEOUT", "The page did not finish loading within \(Int(WebPageLoader.timeoutSeconds)) seconds.", url: raw), url: raw)
        } catch WebPageLoadError.failed(let message) {
            return WebPageToolResult(output: WebPageText.failure("LOAD_FAILED", message, url: raw), url: raw)
        } catch {
            return WebPageToolResult(output: WebPageText.failure("LOAD_FAILED", error.localizedDescription, url: raw), url: raw)
        }
    }
}
