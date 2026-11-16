import Foundation

/// Live voice call rules on the iPhone (plan A, 2026-11-16): the same contract
/// section (shared/protocol/agent-loop.json → voiceTurn) and the same behaviour
/// as shared/agent/voiceTurn.js on the desktop. ios/Tests/VoiceCallTests.swift
/// runs the contract's `fixtures.voiceTurn` against this file, as the desktop
/// test does against the JavaScript.
enum VoiceTurnRules {
    private static var section: [String: Any] { AgentLoopContract.shared.raw["voiceTurn"] as? [String: Any] ?? [:] }
    private static let styleMaxChars = 400

    /// "zh" when the text has CJK ideographs (the contract's cjkPattern), else "en".
    static func language(_ text: String) -> String { AgentLoopContract.shared.cjk.test(text) ? "zh" : "en" }

    /// A phrase the call speaks itself (never sent to the model).
    static func phrase(_ key: String, language: String, values: [String: String] = [:]) -> String {
        let entry = (section["phrases"] as? [String: Any])?[key] as? [String: String] ?? [:]
        return AgentLoopContract.fill(entry[language == "en" ? "en" : "zh"] ?? "", values)
    }

    /// The per-turn instruction for an utterance, in the utterance's language.
    static func instruction(for text: String, style: String = "") -> String {
        let lang = language(text)
        let templates = section["instruction"] as? [String: String] ?? [:]
        let base = AgentLoopContract.fill(templates[lang] ?? "", ["moreInChat": phrase("moreInChat", language: lang)])
        let speakingStyle = JSText.prefix(style.trimmingCharacters(in: .whitespacesAndNewlines), styleMaxChars)
        guard !speakingStyle.isEmpty else { return base }
        let styles = section["style"] as? [String: String] ?? [:]
        return base + "\n" + AgentLoopContract.fill(styles[lang] ?? "", ["style": speakingStyle])
    }

    /// True when the whole utterance is a stop phrase ("停", "算了吧。", "Stop it!").
    static func isStopPhrase(_ text: String) -> Bool {
        let normalized = String(VoiceCallText.normalized(text))
        guard !normalized.isEmpty else { return false }
        return (section["stopPhrases"] as? [String] ?? []).contains { String(VoiceCallText.normalized($0)) == normalized }
    }

    struct Speech: Equatable {
        var sentences: [String]
        var condensed: Bool
        var language: String
        var text: String { sentences.joined(separator: " ") }
    }

    /// What a call reads aloud for a reply: the sentences before the
    /// moreInChat phrase, or the first sentences within spokenMaxChars for the
    /// reply's language, ending with that phrase whenever something stays unread.
    /// Lengths are UTF-16 units, as in JavaScript.
    static func speech(from text: String) -> Speech {
        let clean = SpeechText.plain(text)
        if clean.isEmpty {
            let lang = language(text)
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return Speech(sentences: [], condensed: false, language: lang) }
            return Speech(sentences: [phrase("moreInChat", language: lang)], condensed: true, language: lang)
        }
        var head = clean, tail = "", marker = ""
        for lang in ["zh", "en"] {
            let candidate = phrase("moreInChat", language: lang)
            if !candidate.isEmpty, let range = clean.range(of: candidate) {
                head = String(clean[..<range.lowerBound])
                tail = String(clean[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                marker = candidate
                break
            }
        }
        let lang = language(head.isEmpty ? clean : head)
        let limit = ((section["spokenMaxChars"] as? [String: Any])?[lang] as? NSNumber)?.intValue ?? 160
        let all = SpeechText.splitSentences(head)
        var picked: [String] = []
        var used = 0
        for sentence in all {
            let length = JSText.length(sentence)
            if used + length > limit { break }
            picked.append(sentence)
            used += length
        }
        var truncated = picked.count < all.count
        if picked.isEmpty, let first = all.first {
            picked.append(cut(first, limit))
            truncated = true
        }
        let ending = marker.isEmpty ? (truncated ? phrase("moreInChat", language: lang) : "") : marker
        if !ending.isEmpty { picked.append(ending) }
        return Speech(sentences: picked, condensed: truncated || !tail.isEmpty, language: lang)
    }

    private static func cut(_ sentence: String, _ limit: Int) -> String {
        let head = JSText.prefix(sentence, limit)
        let units = Array(head.utf16)
        var at = -1
        for mark in ["，", ",", "、", "；", ";", " "] {
            if let unit = mark.utf16.first, let index = units.lastIndex(of: unit) { at = max(at, index) }
        }
        return (at >= limit / 2 ? JSText.prefix(head, at) : head).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Call timings from the contract; only the end-of-speech wait is adjustable.
    static func timing(endpointMs: Double? = nil) -> VoiceCallTiming {
        let values = section["timing"] as? [String: Any] ?? [:]
        func number(_ key: String) -> Double? { (values[key] as? NSNumber)?.doubleValue }
        let lower = number("endpointMinMs") ?? 400, upper = max(lower, number("endpointMaxMs") ?? 2000)
        return VoiceCallTiming(endpointMs: endpointMs ?? number("endpointMs"), bargeInMs: number("bargeInMs"),
                               utteranceLimitMs: number("utteranceLimitMs"), echoTailMs: number("echoTailMs"),
                               echoSimilarity: number("echoSimilarity"), endpointRangeMs: lower...upper)
    }
}
