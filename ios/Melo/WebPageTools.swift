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

/// One hidden WKWebView per load. It is attached to the key window while
/// loading because WebKit only renders (and runs layout for innerText and
/// snapshots) when the view is in a window; it is removed when done.
@MainActor final class WebPageLoader: NSObject, WKNavigationDelegate {
    static let viewportSize = CGSize(width: 430, height: 932)
    static let timeoutSeconds: Double = 20
    static let settleMilliseconds = 600
    static let maxFullPageHeight: CGFloat = 6000
    static let maxImageWidth: CGFloat = 1600
    static let jpegQuality: CGFloat = 0.8
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    private let webView: WKWebView
    private var continuation: CheckedContinuation<Void, Error>?
    private var attachedTo: UIWindow?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        webView = WKWebView(frame: CGRect(origin: .zero, size: Self.viewportSize), configuration: configuration)
        webView.isHidden = true
        webView.customUserAgent = Self.userAgent
        webView.isOpaque = true
        super.init()
        webView.navigationDelegate = self
    }

    private static var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first
    }
    private func attach() {
        guard webView.superview == nil, let window = Self.keyWindow else { return }
        window.insertSubview(webView, at: 0)
        attachedTo = window
    }
    func detach() {
        webView.stopLoading()
        webView.removeFromSuperview()
        attachedTo = nil
    }

    /// Loads the page with a 20 s budget and a 600 ms settle after didFinish.
    func load(_ url: URL) async throws {
        attach()
        var request = URLRequest(url: url)
        request.timeoutInterval = Self.timeoutSeconds
        request.setValue("zh-CN,zh;q=0.9,en;q=0.8", forHTTPHeaderField: "Accept-Language")
        let timeout = Task { [weak self] in
            try await Task.sleep(for: .seconds(Self.timeoutSeconds))
            self?.finish(.failure(WebPageLoadError.timeout))
        }
        defer { timeout.cancel() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.continuation = continuation
            self.webView.load(request)
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
        // Downloads and non-page resources would never finish rendering.
        let http = navigationResponse.response as? HTTPURLResponse
        let ok = navigationResponse.isForMainFrame ? (http.map { (200..<400).contains($0.statusCode) } ?? true) && navigationResponse.canShowMIMEType : true
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

    /// First screen, or the whole document up to 6 000 pt when fullPage is set.
    func snapshot(fullPage: Bool) async throws -> UIImage {
        if fullPage {
            let height = (try? await webView.evaluateJavaScript("Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)")) as? Double ?? 0
            let clamped = min(Self.maxFullPageHeight, max(Self.viewportSize.height, CGFloat(height)))
            if clamped != webView.frame.height {
                webView.frame = CGRect(origin: .zero, size: CGSize(width: Self.viewportSize.width, height: clamped))
                webView.setNeedsLayout(); webView.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(300))
            }
        }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = webView.bounds
        configuration.afterScreenUpdates = true
        return try await webView.takeSnapshot(configuration: configuration)
    }

    /// JPEG at most 1 600 px wide, quality 0.8.
    static func jpeg(_ image: UIImage) -> Data? {
        var output = image
        let pixelWidth = image.size.width * image.scale
        if pixelWidth > maxImageWidth {
            let scale = maxImageWidth / pixelWidth
            let size = CGSize(width: image.size.width * scale * image.scale, height: image.size.height * scale * image.scale)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            output = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        } else if image.scale != 1 {
            let size = CGSize(width: pixelWidth, height: image.size.height * image.scale)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            output = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        }
        return output.jpegData(compressionQuality: jpegQuality)
    }
}

/// Executes open_url / web_screenshot for the model. Every failure is a JSON
/// result; nothing loads unless the address passes WebPageText.validated and
/// the Agent's network permission is still on.
@MainActor enum WebPageToolRunner {
    static func run(call: ResponsesFunctionCall, allowed: () -> Bool) async -> WebPageToolResult {
        guard let spec = WebPageToolSpec.named(call.name) else { return WebPageToolResult(output: WebPageText.failure("UNKNOWN_TOOL", "This phone tool does not exist.")) }
        guard allowed() else { return WebPageToolResult(output: WebPageText.failure("NOT_ENABLED", "The user has not allowed web access for this Agent on this iPhone.")) }
        guard let data = call.arguments.data(using: .utf8), let args = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return WebPageToolResult(output: WebPageText.failure("INVALID_ARGUMENTS", "Arguments must be a JSON object."))
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
            guard allowed() else { return WebPageToolResult(output: WebPageText.failure("NOT_ENABLED", "The user disabled web access during the request.", url: raw), url: raw) }
            if spec.name == WebPageToolSpec.openURL {
                let page = max(1, (args["page"] as? Int) ?? Int((args["page"] as? Double) ?? 1))
                let extracted = try await loader.extractText()
                return WebPageToolResult(output: WebPageText.openResult(url: url.absoluteString, finalURL: loader.finalURL, title: extracted.title, description: extracted.description, text: extracted.text, page: page), url: url.absoluteString)
            }
            let fullPage = args["fullPage"] as? Bool ?? false
            let image = try await loader.snapshot(fullPage: fullPage)
            guard let jpeg = WebPageLoader.jpeg(image) else { return WebPageToolResult(output: WebPageText.failure("LOAD_FAILED", "The page rendered but the screenshot could not be encoded.", url: raw), url: raw) }
            let title = (try? await loader.extractText().title) ?? ""
            return WebPageToolResult(output: WebPageText.screenshotResult(url: url.absoluteString, finalURL: loader.finalURL, title: title), image: image, jpeg: jpeg, url: url.absoluteString)
        } catch is CancellationError {
            return WebPageToolResult(output: WebPageText.failure("CANCELLED", "The request was cancelled.", url: raw), url: raw)
        } catch WebPageLoadError.timeout {
            return WebPageToolResult(output: WebPageText.failure("TIMEOUT", "The page did not finish loading within \(Int(WebPageLoader.timeoutSeconds)) seconds.", url: raw), url: raw)
        } catch WebPageLoadError.failed(let message) {
            return WebPageToolResult(output: WebPageText.failure("LOAD_FAILED", message, url: raw), url: raw)
        } catch {
            return WebPageToolResult(output: WebPageText.failure("LOAD_FAILED", error.localizedDescription, url: raw), url: raw)
        }
    }
}
