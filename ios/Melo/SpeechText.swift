import Foundation

/// Text preparation for the phone's auto-read (2026-10-18).
///
/// Before, `LocalDeviceServices.speak` read the whole reply through the
/// system voice of the device language: URLs, markdown leftovers and long
/// explanations were spoken verbatim, and a Chinese reply on an English
/// phone was read with an English voice. The desktop and the messaging
/// channels already speak a condensed, cleaned version
/// (`src/services/media/voiceRewrite.js` → `extractVoiceSummary`); this is
/// the same rule set in Swift, plus voice-language selection that follows
/// the reply's own script and the user's voice-language preference.
enum SpeechText {
    /// Longest spoken text, in characters, after summarising.
    static let budgetCap = 500
    static let budgetFloor = 80

    // MARK: Language

    /// BCP-47 voice language for `text`. The reply's script wins (a Chinese
    /// answer is read in Chinese whatever the phone language); otherwise the
    /// explicit preference (`zh-CN` / `en-US`); `system` falls back to the
    /// device language.
    static func voiceLanguage(for text: String, preference: String, systemLanguage: String? = Locale.preferredLanguages.first) -> String {
        if matches(text, "[\\p{Han}]") { return preference == "zh-TW" ? "zh-TW" : "zh-CN" }
        if matches(text, "[\\p{Hiragana}\\p{Katakana}]") { return "ja-JP" }
        if matches(text, "[\\p{Hangul}]") { return "ko-KR" }
        switch preference {
        case "zh-CN", "en-US": return preference
        default:
            let system = (systemLanguage ?? "").trimmingCharacters(in: .whitespaces)
            return system.isEmpty ? "en-US" : normalizedLanguage(system)
        }
    }

    /// `Locale.preferredLanguages` gives script-qualified tags such as
    /// `zh-Hans-CN`, which `AVSpeechSynthesisVoice(language:)` does not match
    /// (voices are `zh-CN`, `en-AU`…). Reduce to `language-REGION`; a tag
    /// without a region keeps the language code only (`en`).
    static func normalizedLanguage(_ tag: String) -> String {
        let locale = Locale(identifier: tag)
        guard let language = locale.language.languageCode?.identifier, !language.isEmpty else { return tag }
        if let region = locale.language.region?.identifier, !region.isEmpty { return language + "-" + region }
        return language
    }

    /// Exact voice language when one is installed, else the first installed
    /// voice whose language shares the language code (`zh-CN` → `zh-TW`,
    /// `en` → `en-US`); nil when no voice speaks that language.
    static func matchingVoiceLanguage(_ language: String, available: [String]) -> String? {
        if available.contains(language) { return language }
        let prefix = language.split(separator: "-").first.map(String.init)?.lowercased() ?? language.lowercased()
        return available.first { $0.lowercased() == prefix || $0.lowercased().hasPrefix(prefix + "-") }
    }

    // MARK: Cleaning

    /// Strips everything a voice should not read: tool/viz/thinking tags,
    /// code, citations, link targets and bare URLs, table rows, heading and
    /// list markers, emphasis, emoji-only decoration. Whitespace collapsed.
    static func plain(_ text: String) -> String {
        var out = text
        let blockPatterns = [
            "<tool_call>[\\s\\S]*?</tool_call>", "<tool_call>[\\s\\S]*$",
            "<viz-spec>[\\s\\S]*?</viz-spec>", "<viz-spec>[\\s\\S]*$",
            "<think(?:ing)?>[\\s\\S]*?</think(?:ing)?>", "<think(?:ing)?>[\\s\\S]*$",
            "```[\\s\\S]*?```", "```[\\s\\S]*$",
            "`[^`\\n]{1,200}`",
            "\\[source:[^\\]]+\\]", "\\[via:[^\\]]+\\]",
        ]
        for pattern in blockPatterns { out = replace(out, pattern, with: " ") }
        out = replace(out, "!\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1")   // image → alt
        out = replace(out, "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1")     // link → label
        out = replace(out, "https?://[^\\s)\\]>]+", with: " ")            // bare URLs
        out = replace(out, "(?m)^\\s*\\|.*\\|\\s*$", with: " ")           // table rows
        out = replace(out, "(?m)^\\s*[-=|:]{3,}\\s*$", with: " ")         // table separators / rules
        out = replace(out, "(?m)^\\s*#{1,6}\\s+", with: "")               // headings
        out = replace(out, "(?m)^\\s*(?:[-*+•]|\\d+[.)]|[☐☑])\\s+", with: "")   // bullets
        out = replace(out, "[*_~]{1,3}", with: "")                         // emphasis
        out = replace(out, "[ \\t]+", with: " ")
        out = replace(out, "\\s*\\n\\s*", with: "\n")
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Summary

    /// Cleaned text when short; otherwise the highest-scoring sentences
    /// (conclusions, numbers, first/last positions) in original order, within
    /// ~35 % of the cleaned length (80–500 characters).
    static func spoken(from text: String) -> String {
        let clean = plain(text)
        if clean.isEmpty { return "" }
        if clean.count < 20 { return clean }
        let sentences = splitSentences(clean).filter { $0.count > 4 }
        if sentences.count <= 3 { return String(clean.replacingOccurrences(of: "\n", with: " ").prefix(budgetCap)) }
        let conclusion = "(?i)(所以|因此|总之|综上|总结|结论|建议|答案|结果|最终|关键是|简单来说|一句话|底线|in short|therefore|so,?\\s|in conclusion|the answer|result|recommend|takeaway|tl;?dr|key point|bottom line)"
        let data = "\\d+[°℃%￥$€£件个万亿千百]+|\\d{4}[-/]\\d{1,2}|\\d+\\.\\d+"
        let process = "(?i)(首先|其次|第[一二三四五六七八九十]|然后|接下来|让我|分析一下|考虑到|原因是|因为|由于|需要注意|值得一提|另外|此外|补充|first|second|third|let me|the reason|because|note that|additionally|furthermore|moreover|step \\d)"
        let total = sentences.count
        var scored: [(index: Int, text: String, score: Int)] = []
        for (index, sentence) in sentences.enumerated() {
            var score = 0
            if Double(index) >= Double(total) * 0.7 { score += 2 }
            if index == 0 { score += 1 }
            if matches(sentence, conclusion) { score += 3 }
            if matches(sentence, data) { score += 2 }
            if matches(sentence, process) { score -= 2 }
            if sentence.count < 40 { score += 1 }
            if sentence.count > 120 { score -= 1 }
            scored.append((index, sentence, score))
        }
        let budget = min(budgetCap, max(budgetFloor, Int(Double(clean.count) * 0.35)))
        var picked: [(index: Int, text: String)] = []
        var used = 0
        for item in scored.sorted(by: { $0.score == $1.score ? $0.index < $1.index : $0.score > $1.score }) {
            if used + item.text.count > budget && !picked.isEmpty { break }
            picked.append((item.index, item.text)); used += item.text.count
        }
        return picked.sorted { $0.index < $1.index }.map(\.text).joined(separator: " ")
    }

    // MARK: Helpers

    /// Sentence boundaries: CJK terminators and `!?` / newline anywhere; an
    /// ASCII period only when followed by whitespace or the end of the text,
    /// so decimals (`3.5%`), versions and abbreviations stay in one sentence.
    static func splitSentences(_ text: String) -> [String] {
        var sentences: [String] = []
        var current = ""
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            current.append(character)
            let next = text.index(after: index)
            let boundary: Bool
            if character == "." { boundary = next == text.endIndex || text[next].isWhitespace }
            else { boundary = "。！？!?\n".contains(character) }
            if boundary {
                let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { sentences.append(trimmed) }
                current = ""
            }
            index = next
        }
        let tail = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { sentences.append(tail) }
        return sentences
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    private static func replace(_ text: String, _ pattern: String, with template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
    }
}
