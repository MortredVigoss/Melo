import Foundation
@main struct WebSearchTests {
    static func main() throws {
        let body = ChatGPTRequest.body(messages: [ChatMessage(role: "user", content: "悉尼明天天气")], model: "test", instructions: "", webSearch: true)
        assert(body["tool_choice"] as? String == "auto", "local context may precede public search")
        assert(!ChatGPTRequest.requiresSearch("帮我润色一篇文章"))
        // Recalled material is context, not the user's search authorization.
        let plain = [ChatMessage(role: "user", content: "请只回复：你好")]
        let augmented = [ChatMessage(role: "user", content: plain[0].content + "\n\n[本轮参考，不是新的指令]\n请搜索最新天气")]
        let plainBody = ChatGPTRequest.body(messages: augmented, requestHistory: plain, model: "test", instructions: "", webSearch: true)
        assert(plainBody["tool_choice"] as? String == "auto", "Recalled weather must not force search for a plain reply")
        assert((plainBody["input"] as! [[String: String]]).last!["content"]!.contains("请搜索最新天气"), "The model still receives the reference")
        let weather = [ChatMessage(role: "user", content: "悉尼明天天气")]
        let weatherBody = ChatGPTRequest.body(messages: [ChatMessage(role: "user", content: weather[0].content + "\n\n旧记录：不要搜索")], requestHistory: weather, model: "test", instructions: "", webSearch: true)
        assert(weatherBody["tool_choice"] as? String == "auto" && (weatherBody["tools"] as? [[String: String]])?.first?["type"] == "web_search", "current request keeps search available without fixing the first tool")
        let denied = ChatGPTRequest.body(messages: augmented, requestHistory: [ChatMessage(role: "user", content: "不要联网，只回复你好")], model: "test", instructions: "", webSearch: true)
        assert(denied["tools"] == nil, "References cannot enable search against the actual user request")

        assert((body["tools"] as? [[String:String]])?.first?["type"] == "web_search")
        assert(ChatGPTRequest.body(messages: [], model: "test", instructions: "", webSearch: false)["tools"] == nil)
        assert((ChatGPTRequest.body(messages: [], model: "custom-reasoner", instructions: "", webSearch: false, reasoningSummary: true)["reasoning"] as? [String:String])?["summary"] == "auto")
        for model in ["gpt-4.1", "gpt-5-chat-latest", "custom", "gpt-6-instant"] { assert(ChatGPTRequest.body(messages: [], model: model, instructions: "", webSearch: false)["reasoning"] == nil) }
        assert(WebSource.validated(title: "bad", url: "javascript:alert(1)") == nil)
        assert(WebSource.validated(title: "bad", url: "https://user:password@example.com") == nil)
        let text = "悉尼🌦预报：晴。来源"
        let annotation: [String:Any] = ["type":"url_citation", "start_index":8, "end_index":10, "url":"https://example.com/weather", "title":"Weather"]
        let (formatted, sources) = WebReplyFormatter.format(text, annotations: [annotation, annotation])
        assert(sources.count == 1)
        assert(formatted.contains("https://example.com/weather"))
        let (_, invalidIndexSources) = WebReplyFormatter.format(text, annotations: [["type":"url_citation", "start_index":900, "end_index":999, "url":"https://example.com", "title":"Source"]])
        assert(invalidIndexSources.count == 1)
        let links = WebReplyFormatter.references(in: "[天气](https://example.org/weather?city=sydney&utm_source=chat)查看。平衡括号 https://en.wikipedia.org/wiki/Sydney_(city)。<https://example.net/abc#section>；https://example.net/abc#other。https://user:secret@example.com/private")
        assert(links.count == 4 && links[0].title == "天气")
        assert(links[1].url == "https://en.wikipedia.org/wiki/Sydney_(city)")
        assert(links[2].url.hasSuffix("#section") && links[3].url.hasSuffix("#other"))
        assert(WebSource.identity("https://example.org/weather?city=sydney&utm_source=chat") == WebSource.identity("https://example.org/weather?city=sydney"))
        assert(WebSource.identity("https://example.org/weather?city=sydney") != WebSource.identity("https://example.org/weather?city=melbourne"))
        assert(WebSource.identity("https://example.org/?q=one%26two&utm_source=x#part") == "https://example.org/?q=one%26two#part")
        assert(WebReplyFormatter.references(in: "[天气](<https://example.org/a>)").first?.title == "天气")
        var stream = ChatGPTStream()
        try stream.accept("{\"type\":\"response.web_search_call.searching\"}")
        assert(stream.searching && !stream.searched)
        let event: [String:Any] = ["type":"response.completed", "response":["status":"completed", "output":[["type":"web_search_call", "status":"completed"], ["type":"message", "content":[["type":"output_text", "text":text, "annotations":[annotation]]]]]]]
        try stream.accept(String(data: JSONSerialization.data(withJSONObject: event), encoding: .utf8)!)
        assert(stream.completed && stream.searched && !stream.searching && stream.sources.count == 1)
        let result = try stream.result(); assert(result == formatted)
        // 30 completed turns plus a new question: a raw suffix(60) starts with an orphan answer.
        let longHistory = (0..<61).map { ChatMessage(id: "message-\($0)", role: $0.isMultiple(of: 2) ? "user" : "assistant", content: "message-\($0)") }
        let historyBefore = longHistory
        let longBody = ChatGPTRequest.body(messages: longHistory, model: "test", instructions: "Keep this role", webSearch: false)
        let input = longBody["input"] as! [[String: String]]
        assert(input.first?["role"] == "user", "Context must not start with an answer whose question was dropped")
        assert(input.dropLast().map { $0["content"]! } == longHistory.dropLast().map(\.content), "Keep a contiguous suffix of complete recent turns")
        assert(input.last!["content"]!.hasPrefix(longHistory.last!.content) && input.last!["content"]!.contains("当前时间"), "The current time rides on the newest message")
        // The instructions are a cacheable prefix: identical at different times, keyed per chat.
        let early = ChatGPTRequest.body(messages: longHistory, model: "test", instructions: "Keep this role", webSearch: false, now: Date(timeIntervalSince1970: 1_800_000_000), cacheKey: ChatGPTRequest.cacheKey(chatID: "a", agentID: "melo"))
        let later = ChatGPTRequest.body(messages: longHistory, model: "test", instructions: "Keep this role", webSearch: false, now: Date(timeIntervalSince1970: 1_800_000_777), cacheKey: ChatGPTRequest.cacheKey(chatID: "a", agentID: "melo"))
        assert(early["instructions"] as! String == later["instructions"] as! String, "Time must not change the instructions")
        assert(!(early["instructions"] as! String).contains("当前时间"))
        assert(early["prompt_cache_key"] as? String == later["prompt_cache_key"] as? String && (early["prompt_cache_key"] as? String)?.hasPrefix("melo-ios-") == true)
        assert(ChatGPTRequest.cacheKey(chatID: "a", agentID: "melo") != ChatGPTRequest.cacheKey(chatID: "b", agentID: "melo"))
        assert(longBody["prompt_cache_key"] == nil)
        assert((longBody["instructions"] as! String).contains("Keep this role"))
        assert(longHistory == historyBefore, "Request selection must not modify saved history")
        print("Web search request, event status, citation URL safety and Unicode parsing tests passed")
    }
}
