import Foundation

@main struct SpeechTextTests {
    static func main() {
        // Language follows the reply's script, then the preference, then the device.
        assert(SpeechText.voiceLanguage(for: "悉尼明天多云，13 到 18 度。", preference: "system", systemLanguage: "en-AU") == "zh-CN")
        assert(SpeechText.voiceLanguage(for: "Cloudy tomorrow in Sydney.", preference: "system", systemLanguage: "en-AU") == "en-AU")
        assert(SpeechText.voiceLanguage(for: "Cloudy tomorrow in Sydney.", preference: "zh-CN", systemLanguage: "en-AU") == "zh-CN", "explicit preference wins for non-CJK text")
        assert(SpeechText.voiceLanguage(for: "Cloudy tomorrow.", preference: "en-US", systemLanguage: "zh-Hans-CN") == "en-US")
        assert(SpeechText.voiceLanguage(for: "안녕하세요", preference: "zh-CN") == "ko-KR")
        assert(SpeechText.voiceLanguage(for: "こんにちは", preference: "en-US") == "ja-JP")
        assert(SpeechText.voiceLanguage(for: "", preference: "system", systemLanguage: nil) == "en-US")
        // Audit I19: script-qualified system tags are reduced to language-REGION, and a missing exact voice
        // falls back to the first installed voice of the same language.
        assert(SpeechText.voiceLanguage(for: "Cloudy tomorrow.", preference: "system", systemLanguage: "zh-Hans-CN") == "zh-CN")
        assert(SpeechText.normalizedLanguage("zh-Hant-TW") == "zh-TW" && SpeechText.normalizedLanguage("en-AU") == "en-AU" && SpeechText.normalizedLanguage("en") == "en" && SpeechText.normalizedLanguage("zh-Hans") == "zh")
        let installed = ["en-US", "en-AU", "zh-TW", "ja-JP"]
        assert(SpeechText.matchingVoiceLanguage("en-AU", available: installed) == "en-AU")
        assert(SpeechText.matchingVoiceLanguage("zh-CN", available: installed) == "zh-TW", "same language prefix")
        assert(SpeechText.matchingVoiceLanguage("en", available: installed) == "en-US")
        assert(SpeechText.matchingVoiceLanguage("ko-KR", available: installed) == nil)

        // Audit I13: an ASCII period splits only before whitespace / end, so decimals and versions stay whole.
        assert(SpeechText.splitSentences("今天涨了3.5%。明天看 v2.1 版本。") == ["今天涨了3.5%。", "明天看 v2.1 版本。"])
        assert(SpeechText.splitSentences("Pi is 3.14. Done.") == ["Pi is 3.14.", "Done."])
        assert(SpeechText.splitSentences("See example.com/path now") == ["See example.com/path now"])
        assert(SpeechText.splitSentences("One. Two!Three?") == ["One.", "Two!", "Three?"])
        let decimals = (1...8).map { "第\($0)点是过程说明，首先解释一下背景，内容比较长，主要用于说明推理过程而不是结论。" }.joined() + "所以结论是：涨幅 3.5% 左右。"
        assert(SpeechText.spoken(from: decimals).contains("涨幅 3.5% 左右。"), SpeechText.spoken(from: decimals))

        // Cleaning: no URLs, link targets, code, tables, markers or citations.
        let reply = """
        ## 悉尼歌剧院演出
        最近的节目可以看[官方演出日历](https://www.sydneyoperahouse.com/whats-on)，或者直接打开 https://example.com/tickets?id=1 查票。
        | 日期 | 节目 |
        | --- | --- |
        | 10-20 | 歌剧 |
        - 票价 **A$89** 起
        ```
        curl https://api.example.com
        ```
        建议提前一周买票。[source:web]
        """
        let plain = SpeechText.plain(reply)
        assert(!plain.contains("http"), plain)
        assert(!plain.contains("|") && !plain.contains("curl") && !plain.contains("source:"), plain)
        assert(plain.contains("官方演出日历") && plain.contains("A$89") && plain.contains("建议提前一周买票"), plain)
        assert(!plain.contains("##") && !plain.contains("**"), plain)

        // Short replies are read whole; long ones are condensed to conclusions within the budget.
        assert(SpeechText.spoken(from: "好的，收到。") == "好的，收到。")
        let long = (1...14).map { "首先我们来分析第\($0)个因素，这是过程性的说明，内容比较长，主要用于解释推理过程，不是结论。" }.joined() + "所以结论是：明天带伞，气温 13 到 18 度。"
        let spoken = SpeechText.spoken(from: long)
        assert(spoken.count <= SpeechText.budgetCap, "\(spoken.count)")
        assert(spoken.contains("所以结论是：明天带伞，气温 13 到 18 度。"), spoken)
        assert(spoken.count < long.count / 2, "summary must be much shorter than the reply")
        print("Speech text tests passed: voice language by script/preference, URL/markdown/code stripping, conclusion-first condensing")
    }
}
