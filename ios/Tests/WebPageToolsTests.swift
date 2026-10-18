import Foundation

// Offline checks for the pure half of the phone web page tools: URL policy,
// whitespace collapsing, 12 000-character paging, result/follow-up shapes and
// the three protocol definitions. Rendering (WKWebView) is not covered here.

func json(_ text: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
}

@main struct WebPageToolsTests {
    static func main() {
        // URL policy: public http/https only.
        assert(WebPageText.validated("https://example.com/a?b=1#c")?.absoluteString == "https://example.com/a?b=1#c")
        assert(WebPageText.validated("  http://Example.org/path ")?.host == "Example.org")
        assert(WebPageText.validated("HTTPS://example.com") != nil, "scheme is case-insensitive")
        for rejected in ["", "example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "ftp://example.com", "about:blank",
                         "http://localhost/", "http://localhost:3000/x", "http://foo.localhost/", "http://printer.local/", "http://127.0.0.1/", "http://127.1.2.3/",
                         "http://10.0.0.5/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://172.16.0.1/", "http://172.31.255.255/",
                         "http://0.0.0.0/", "http://[::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://user:pass@example.com/", "http://100.64.0.1/"] {
            assert(WebPageText.validated(rejected) == nil, "must reject \(rejected)")
        }
        assert(WebPageText.validated("http://172.32.0.1/") != nil, "172.32/16 is public")
        assert(WebPageText.validated("http://8.8.8.8/") != nil)
        assert(WebPageText.validated("http://192.169.0.1/") != nil)
        assert(WebPageText.validated("https://" + String(repeating: "a", count: 5000) + ".com") == nil, "length bound")
        assert(WebPageText.isPrivateHost("::1") && WebPageText.isPrivateHost("fd00::1") && !WebPageText.isPrivateHost("2001:db8::1"))

        // Whitespace collapsing: runs become one space, blank-line runs one paragraph break.
        assert(WebPageText.collapsed("  Hello \t world \r\n\r\n\n  again  \n\n") == "Hello world\n\nagain")
        assert(WebPageText.collapsed("one\ntwo") == "one\ntwo")
        assert(WebPageText.collapsed("a\n\n\n\nb") == "a\n\nb")
        assert(WebPageText.collapsed("\n\n") == "")

        // Paging at exactly 12 000 characters, including CJK.
        let exact = String(repeating: "字", count: 12_000)
        let one = WebPageText.paged(exact, page: 1)
        assert(one.pageCount == 1 && !one.truncated && one.nextPage == nil && one.text.count == 12_000)
        let longer = exact + "x"
        let first = WebPageText.paged(longer, page: 1)
        assert(first.pageCount == 2 && first.truncated && first.nextPage == 2 && first.text.count == 12_000)
        let second = WebPageText.paged(longer, page: 2)
        assert(second.text == "x" && !second.truncated && second.nextPage == nil)
        assert(WebPageText.paged(longer, page: 9).page == 2, "beyond the end returns the last page")
        assert(WebPageText.paged(longer, page: 0).page == 1 && WebPageText.paged(longer, page: -3).page == 1)
        assert(WebPageText.paged("", page: 1) == WebPageText.Page(text: "", page: 1, pageCount: 1))
        assert(WebPageText.paged("abcdefg", page: 2, size: 3).text == "def" && WebPageText.paged("abcdefg", page: 3, size: 3).text == "g")

        // open_url result: fields, nextPage, bounded output.
        let opened = json(WebPageText.openResult(url: "https://example.com", finalURL: "https://www.example.com/", title: "Example", description: "An example", text: longer, page: 1))
        assert(opened["ok"] as? Bool == true && opened["url"] as? String == "https://example.com" && opened["finalUrl"] as? String == "https://www.example.com/")
        assert(opened["title"] as? String == "Example" && opened["description"] as? String == "An example")
        assert(opened["truncated"] as? Bool == true && opened["nextPage"] as? Int == 2 && opened["page"] as? Int == 1 && opened["pageCount"] as? Int == 2)
        assert((opened["text"] as? String)?.count == 12_000)
        let last = json(WebPageText.openResult(url: "u", finalURL: "u", title: "", description: "", text: longer, page: 2))
        assert(last["nextPage"] == nil && last["truncated"] as? Bool == false && last["description"] == nil)
        assert(WebPageText.openResult(url: "u", finalURL: "u", title: "", description: "", text: exact, page: 1).count <= WebPageText.maxOutputCharacters)
        let huge = WebPageText.encode(["ok": true, "text": String(repeating: "é", count: 20_000)])
        assert(huge.count <= WebPageText.maxOutputCharacters && json(huge)["truncated"] as? Bool == true)

        // Failures carry a code and the offending address.
        let bad = json(WebPageText.failure("INVALID_URL", "Only public http or https pages can be opened.", url: "file:///x"))
        assert(bad["ok"] as? Bool == false && bad["error"] as? String == "INVALID_URL" && bad["url"] as? String == "file:///x")
        assert(json(WebPageText.failure("TIMEOUT", "slow"))["url"] == nil)

        // Screenshot result and follow-up item shape (Responses).
        let shot = json(WebPageText.screenshotResult(url: "https://a.example", finalURL: "https://a.example/", title: "A"))
        assert(shot["screenshot"] as? String == "attached" && shot["ok"] as? Bool == true)
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
        let dataURL = WebPageText.dataURL(jpeg: jpeg)
        assert(dataURL == "data:image/jpeg;base64," + jpeg.base64EncodedString())
        let item = WebPageText.followUpImageItem(callID: "call_9", dataURL: dataURL, url: "https://a.example")
        assert(item["role"] as? String == "user")
        let content = item["content"] as? [[String: Any]]
        assert(content?.count == 2)
        assert(content?[0]["type"] as? String == "input_text" && content?[0]["text"] as? String == "[web_screenshot of https://a.example]")
        assert(content?[1]["type"] as? String == "input_image" && content?[1]["image_url"] as? String == dataURL && content?[1]["detail"] as? String == "low")
        let anonymous = WebPageText.followUpImageItem(callID: "call_9", dataURL: dataURL)
        assert(((anonymous["content"] as? [[String: Any]])?[0]["text"] as? String)?.contains("call_9") == true)

        // Chat Completions / Anthropic image carriers.
        let chat = WebPageText.chatImageMessage(url: "https://a.example", dataURL: dataURL)
        let chatParts = chat["content"] as? [[String: Any]]
        assert(chat["role"] as? String == "user" && chatParts?[1]["type"] as? String == "image_url" && (chatParts?[1]["image_url"] as? [String: Any])?["url"] as? String == dataURL)
        let blocks = WebPageText.anthropicImageBlocks(url: "https://a.example", jpeg: jpeg)
        assert(blocks.count == 2 && blocks[0]["type"] as? String == "text" && blocks[1]["type"] as? String == "image")
        let source = blocks[1]["source"] as? [String: Any]
        assert(source?["type"] as? String == "base64" && source?["media_type"] as? String == "image/jpeg" && source?["data"] as? String == jpeg.base64EncodedString())

        // Definitions on the three protocols.
        assert(WebPageToolSpec.all.map(\.name) == ["open_url", "web_screenshot"])
        assert(WebPageToolSpec.named("open_url") != nil && WebPageToolSpec.named("web_screenshot") != nil && WebPageToolSpec.named("calendar_list_events") == nil)
        let open = WebPageToolSpec.named("open_url")!
        let responses = open.responsesDefinition
        assert(responses["type"] as? String == "function" && responses["name"] as? String == "open_url" && responses["strict"] as? Bool == false)
        assert((responses["parameters"] as? [String: Any])?["required"] as? [String] == ["url"])
        let properties = (responses["parameters"] as? [String: Any])?["properties"] as? [String: Any]
        assert((properties?["url"] as? [String: Any])?["type"] as? String == "string" && (properties?["page"] as? [String: Any])?["type"] as? String == "integer")
        let completions = open.chatCompletionsDefinition
        assert(completions["type"] as? String == "function")
        let function = completions["function"] as? [String: Any]
        assert(function?["name"] as? String == "open_url" && (function?["description"] as? String)?.isEmpty == false && function?["parameters"] != nil && completions["name"] == nil)
        let anthropic = open.anthropicDefinition
        assert(anthropic["name"] as? String == "open_url" && anthropic["input_schema"] != nil && anthropic["parameters"] == nil && anthropic["type"] == nil)
        let screenshot = WebPageToolSpec.named("web_screenshot")!
        let shotProperties = (screenshot.parameters["properties"] as? [String: Any])
        assert((shotProperties?["fullPage"] as? [String: Any])?["type"] as? String == "boolean")
        assert(screenshot.statusText == "正在截图网页…" && open.statusText == "正在打开网页…")
        assert(screenshot.recordName == "网页 · 截图" && open.recordName == "网页 · 打开")
        for spec in WebPageToolSpec.all {
            assert(JSONSerialization.isValidJSONObject(spec.responsesDefinition) && JSONSerialization.isValidJSONObject(spec.chatCompletionsDefinition) && JSONSerialization.isValidJSONObject(spec.anthropicDefinition))
        }
        assert(WebPageToolSpec.instructions.contains("open_url") && WebPageToolSpec.instructions.contains("web_screenshot"))

        // Run-record summaries never carry page text.
        let okText = WebPageText.summary(PhoneToolResult(output: WebPageText.openResult(url: "u", finalURL: "u", title: "t", description: "", text: longer, page: 1)))
        assert(okText.ok && okText.text == "已读取 1/2 页")
        assert(WebPageText.summary(PhoneToolResult(output: WebPageText.screenshotResult(url: "u", finalURL: "u", title: ""), imageJPEG: jpeg, imageURL: "u")) == (true, "已截图"))
        assert(WebPageText.summary(PhoneToolResult(output: WebPageText.failure("TIMEOUT", "x"))) == (false, "网页加载超时"))
        assert(WebPageText.summary(PhoneToolResult(output: WebPageText.failure("INVALID_URL", "x"))) == (false, "地址不允许打开"))
        assert(WebPageText.summary(PhoneToolResult(output: "nope")) == (false, "结果无法解析"))
        print("Swift web page tool tests passed: URL policy incl. private hosts, whitespace, 12k paging, result and follow-up shapes, three protocol definitions, summaries")
    }
}
