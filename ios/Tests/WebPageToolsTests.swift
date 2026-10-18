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
        // Audit I5: every spelling of a local address is judged by its bytes, trailing dots are
        // stripped, and internal-only name suffixes are refused.
        for bypass in ["http://localhost./", "http://foo.local./", "http://LOCALHOST/", "http://[::FFFF:7f00:1]/", "http://[0:0:0:0:0:0:0:1]/", "http://[::ffff:127.0.0.1]/",
                       "http://[::ffff:0:7f00:1]/", "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[2002:7f00:1::1]/", "http://[2002:c0a8:101::]/",
                       "http://[fe80::1%25en0]/", "http://[fec0::1]/", "http://[ff02::1]/", "http://[::]/", "http://[::127.0.0.1]/",
                       "http://0x7f000001/", "http://0x7f.0.0.1/", "http://2130706433/", "http://127.1/", "http://127.0.1/", "http://0177.0.0.1/", "http://017700000001/", "http://0/", "http://1/",
                       "http://metadata.google.internal/", "http://db.internal/", "http://router.home.arpa/", "http://nas.lan/", "http://pc.localdomain/", "http://host.intranet./",
                       "http://224.0.0.1/", "http://255.255.255.255/", "http://192.0.0.1/", "http://198.18.0.1/", "http://100.127.255.254/", "http://169.254.169.254./",
                       "http://3232235777/", "http://0xc0a80101/", "http://0300.0250.0.1/"] {
            assert(WebPageText.validated(bypass) == nil, "must reject \(bypass)")
        }
        for allowed in ["http://[2606:4700::1111]/", "http://[::ffff:8.8.8.8]/", "http://[64:ff9b::808:808]/", "http://[2002:808:808::1]/", "http://0x08080808/", "http://134744072/", "http://1.1/", "http://example.com./", "http://internal.example.com/", "http://lan.example.org/", "http://home.arpa.example.net/"] {
            assert(WebPageText.validated(allowed) != nil, "public forms stay open: \(allowed)")
        }
        assert(WebPageText.ipv4Bytes("127.0.0.1") == [127, 0, 0, 1] && WebPageText.ipv4Bytes("127.1") == nil && WebPageText.ipv4LegacyBytes("127.1") == [127, 0, 0, 1])
        assert(WebPageText.ipv6Bytes("::1")?.last == 1 && WebPageText.ipv6Bytes("8.8.8.8") == nil)
        assert(WebPageText.isPrivateHost("") && WebPageText.isPrivateHost("1.2.3.4.5") && WebPageText.isPrivateHost("0x7f.0x0.0x0.0x1") && !WebPageText.isPrivateHost("1.2.3"), "numeric forms that parse nowhere stay closed; 1.2.3 is 1.2.0.3")

        // Audit I1: the model-controlled page number never traps (1e20, NaN, negative, bool, string).
        assert(WebPageText.pageNumber(2) == 2 && WebPageText.pageNumber(2.9) == 2 && WebPageText.pageNumber(1_000_000_000) == 1_000_000_000)
        assert(WebPageText.pageNumber(1e20) == 1 && WebPageText.pageNumber(Double.nan) == 1 && WebPageText.pageNumber(Double.infinity) == 1 && WebPageText.pageNumber(-5) == 1 && WebPageText.pageNumber(0) == 1)
        assert(WebPageText.pageNumber(1_000_000_001) == 1 && WebPageText.pageNumber("3") == 1 && WebPageText.pageNumber(true) == 1 && WebPageText.pageNumber(nil) == 1 && WebPageText.pageNumber(NSNull()) == 1)
        assert(WebPageText.pageNumber(NSNumber(value: 1e300)) == 1 && WebPageText.pageNumber(NSNumber(value: 7)) == 7)

        // Audit I2: screenshot pixels capped at 1 600 wide and 4 096 on the long side.
        let small = WebPageText.scaledPixelSize(width: 430, height: 932); assert(small.width == 430 && small.height == 932)
        let tall = WebPageText.scaledPixelSize(width: 1290, height: 18000); assert(tall.height == 4096 && tall.width == 293, "\(tall)")
        let wide = WebPageText.scaledPixelSize(width: 4000, height: 1000); assert(wide.width == 1600 && wide.height == 400)
        let full = WebPageText.scaledPixelSize(width: 430, height: 4096); assert(full.width == 430 && full.height == 4096, "1× full page needs no rescale")
        let square = WebPageText.scaledPixelSize(width: 9000, height: 9000); assert(square.width == 1600 && square.height == 1600)
        assert(WebPageText.scaledPixelSize(width: 0, height: 10).width == 0)
        for (w, h) in [(1290.0, 18000.0), (4000.0, 1000.0), (9000.0, 9000.0), (1.0, 20000.0)] {
            let size = WebPageText.scaledPixelSize(width: w, height: h)
            assert(size.width <= WebPageText.maxImageWidth && max(size.width, size.height) <= WebPageText.maxImageLongSide && size.width >= 1 && size.height >= 1)
        }

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
        // Audit I9: per-reply screenshot cap, byte budget (oldest dropped first) and demotion of earlier images to captions.
        assert(WebPageText.maxScreenshotsPerReply == 2 && WebPageText.imageByteBudget == 6 * 1024 * 1024)
        let refused = json(WebPageText.tooManyScreenshots(url: "https://a.example"))
        assert(refused["ok"] as? Bool == false && refused["error"] as? String == "TOO_MANY_SCREENSHOTS" && refused["url"] as? String == "https://a.example")
        assert(WebPageText.summary(PhoneToolResult(output: WebPageText.tooManyScreenshots(url: "u"))) == (false, "本次回复截图已达上限"))
        assert(WebPageText.keptImages(sizes: [1, 2, 3], budget: 10) == [true, true, true])
        assert(WebPageText.keptImages(sizes: [5, 4, 3], budget: 7) == [false, true, true])
        assert(WebPageText.keptImages(sizes: [1, 9, 3], budget: 5) == [false, false, true], "once one image does not fit, it and everything older are dropped")
        assert(WebPageText.keptImages(sizes: [9], budget: 5) == [false] && WebPageText.keptImages(sizes: [], budget: 5).isEmpty)
        let userImage: [String: Any] = ["role": "user", "content": [["type": "text", "text": "看这张"], ["type": "image_url", "image_url": ["url": "data:image/png;base64,AA"]]]]
        let demotedChat = WebPageText.demotedChatMessages([["role": "system", "content": "s"], userImage, WebPageText.chatImageMessage(url: "https://a.example", dataURL: dataURL)])
        assert(demotedChat[2]["content"] as? String == "[web_screenshot of https://a.example]" && (demotedChat[1]["content"] as? [[String: Any]])?.count == 2, "the user's own images are untouched")
        let blocks2: [[String: Any]] = [["type": "tool_result", "tool_use_id": "t", "content": "{}"] as [String: Any]] + WebPageText.anthropicImageBlocks(url: "https://a.example", jpeg: jpeg) + [["type": "text", "text": "x"], ["type": "image", "source": ["type": "base64"]]]
        let demotedClaude = WebPageText.demotedAnthropicMessages([["role": "user", "content": blocks2]])
        let demotedBlocks = demotedClaude[0]["content"] as! [[String: Any]]
        assert(demotedBlocks.map { $0["type"] as? String } == ["tool_result", "text", "text", "image"], "only the screenshot image goes: \(demotedBlocks)")
        let responsesInput: [Any] = [["role": "user", "content": "hi"], ["type": "function_call_output", "call_id": "c", "output": "{}"], WebPageText.followUpImageItem(callID: "c", dataURL: dataURL, url: "https://a.example"), ["role": "user", "content": [["type": "input_text", "text": "mine"], ["type": "input_image", "image_url": "data:x"]]]]
        let demotedResponses = WebPageText.demotedResponsesInput(responsesInput)
        assert(((demotedResponses[2] as? [String: Any])?["content"] as? [[String: Any]])?.count == 1 && ((demotedResponses[3] as? [String: Any])?["content"] as? [[String: Any]])?.count == 2)
        assert(((demotedResponses[2] as? [String: Any])?["content"] as? [[String: Any]])?.first?["text"] as? String == "[web_screenshot of https://a.example]")

        // Audit I16/I17: HTTP status travels in the result; a runaway title cannot sink the whole result.
        let notFound = json(WebPageText.openResult(url: "u", finalURL: "u", title: "Not found", description: "", text: "nothing here", page: 1, status: 404))
        assert(notFound["ok"] as? Bool == true && notFound["status"] as? Int == 404 && WebPageText.summary(PhoneToolResult(output: WebPageText.openResult(url: "u", finalURL: "u", title: "", description: "", text: "t", page: 1, status: 500))).ok)
        assert(json(WebPageText.openResult(url: "u", finalURL: "u", title: "t", description: "", text: "t", page: 1))["status"] == nil)
        assert(json(WebPageText.screenshotResult(url: "u", finalURL: "u", title: "t", status: 503))["status"] as? Int == 503)
        let longTitle = json(WebPageText.openResult(url: "u", finalURL: "u", title: String(repeating: "标", count: 30_000), description: String(repeating: "d", count: 30_000), text: "body", page: 1))
        assert(longTitle["ok"] as? Bool == true && (longTitle["title"] as? String)?.count == WebPageText.maxTitleCharacters && (longTitle["description"] as? String)?.count == WebPageText.maxDescriptionCharacters && longTitle["text"] as? String == "body")

        print("Swift web page tool tests passed: URL policy incl. private hosts and literal-address bypasses, page number, pixel caps, screenshot budget/demotion, status and bounded title, whitespace, 12k paging, result and follow-up shapes, three protocol definitions, summaries")
    }
}
