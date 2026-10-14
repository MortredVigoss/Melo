import Foundation

struct ReplyBlock: Equatable {
    enum Kind: Equatable { case paragraph, heading, list, quote, code, table }
    var kind: Kind
    var text = ""
    var language = ""
    var rows: [[String]] = []
    var marker = "•"
    var indent = 0
    var checked: Bool?
}
enum ReplyDocument {
    static func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
    struct InlineSpan { var text: String; var raw: String; var code: Bool }
    static func spans(_ value: String) -> [InlineSpan] {
        let chars = Array(value)
        var runs: [(start: Int, end: Int)] = [], index = 0
        while index < chars.count {
            if chars[index] != "`" { index += 1; continue }
            let start = index
            while index < chars.count, chars[index] == "`" { index += 1 }
            runs.append((start, index))
        }
        var result: [InlineSpan] = [], cursor = 0, runIndex = 0
        while runIndex < runs.count {
            let open = runs[runIndex]
            guard let closeIndex = runs.indices.first(where: { $0 > runIndex && runs[$0].end - runs[$0].start == open.end - open.start }) else { runIndex += 1; continue }
            let close = runs[closeIndex]
            if open.start > cursor { let text = String(chars[cursor..<open.start]); result.append(.init(text: text, raw: text, code: false)) }
            result.append(.init(text: String(chars[open.end..<close.start]), raw: String(chars[open.start..<close.end]), code: true))
            cursor = close.end; runIndex = closeIndex + 1
        }
        if cursor < chars.count { let text = String(chars[cursor...]); result.append(.init(text: text, raw: text, code: false)) }
        return result
    }
    static func cells(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|"), !text.hasSuffix("\\|") { text.removeLast() }
        var result: [String] = [], value = "", escaped = false
        for span in spans(text) {
            if span.code { if escaped { value.append("\\"); escaped = false }; value.append(span.raw); continue }
            for char in span.text {
                if escaped { value.append(char == "|" ? "|" : "\\" + String(char)); escaped = false; continue }
                if char == "\\" { escaped = true; continue }
                if char == "|" { result.append(value.trimmingCharacters(in: .whitespaces)); value = "" }
                else { value.append(char) }
            }
        }
        if escaped { value.append("\\") }
        result.append(value.trimmingCharacters(in: .whitespaces))
        return result
    }
    static func tableRule(_ line: String) -> Bool {
        let parts = cells(line)
        return line.contains("|") && parts.count >= 2 && parts.allSatisfy { matches($0, "^:?-{3,}:?$") }
    }
    static func parse(_ value: String) -> [ReplyBlock] {
        let lines = value.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [ReplyBlock] = [], paragraph: [String] = [], index = 0
        func flush() { if !paragraph.isEmpty { blocks.append(.init(kind: .paragraph, text: paragraph.joined(separator: "\n"))); paragraph = [] } }
        while index < lines.count {
            let line = lines[index], trim = line.trimmingCharacters(in: .whitespaces)
            if trim.isEmpty { flush(); index += 1; continue }
            if trim.hasPrefix("```") || trim.hasPrefix("~~~") {
                flush(); let marker = String(trim.prefix { $0 == trim.first }), language = String(trim.dropFirst(marker.count)); index += 1; var code: [String] = []
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(marker) { code.append(lines[index]); index += 1 }
                blocks.append(.init(kind: .code, text: code.joined(separator: "\n"), language: language)); if index < lines.count { index += 1 }; continue
            }
            if index + 1 < lines.count, line.contains("|"), tableRule(lines[index + 1]) {
                flush(); var rows = [cells(line)]; index += 2
                while index < lines.count, lines[index].contains("|"), !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    if !tableRule(lines[index]) { rows.append(cells(lines[index])) }; index += 1
                }
                blocks.append(.init(kind: .table, rows: rows)); continue
            }
            if matches(trim, "^(?:[-*_]\\s*){3,}$") { flush(); index += 1; continue }
            if index + 1 < lines.count, matches(lines[index + 1].trimmingCharacters(in: .whitespaces), "^(?:={3,}|-{3,})$") {
                flush(); blocks.append(.init(kind: .heading, text: trim)); index += 2; continue
            }
            if matches(trim, "^#{1,6}\\s+") { flush(); blocks.append(.init(kind: .heading, text: trim.replacingOccurrences(of: "^#{1,6}\\s+|\\s+#+$", with: "", options: .regularExpression))); index += 1; continue }
            if matches(trim, "^>\\s?") { flush(); blocks.append(.init(kind: .quote, text: trim.replacingOccurrences(of: "^(?:>\\s?)+", with: "", options: .regularExpression))); index += 1; continue }
            if let regex = try? NSRegularExpression(pattern: "^(\\s*)([-*+]|[0-9]+[.)])\\s+(?:\\[([ xX])\\]\\s+)?(.*)$"),
               let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) {
                func part(_ i: Int) -> String { Range(match.range(at: i), in: line).map { String(line[$0]) } ?? "" }
                flush()
                let marker = part(2), checked = part(3)
                blocks.append(.init(kind: .list, text: part(4), marker: marker.first?.isNumber == true ? marker : "•", indent: part(1).replacingOccurrences(of: "\t", with: "    ").count, checked: checked.isEmpty ? nil : checked.lowercased() == "x"))
                index += 1; continue
            }
            paragraph.append(line); index += 1
        }
        flush(); return blocks
    }
    static func readableInline(_ value: String) -> String {
        spans(value).map { span in
            if span.code { return span.text }
            var result = span.text
            for pattern in ["\\*\\*\\*([^*]+)\\*\\*\\*", "\\*\\*([^*]+)\\*\\*", "__([^_]+)__", "~~([^~]+)~~"] {
                result = result.replacingOccurrences(of: pattern, with: "$1", options: .regularExpression)
            }
            for pattern in ["(^|[\\s（(])\\*([^*\\n]+)\\*(?=$|[\\s，。！？.,!?)）])", "(^|[\\s（(])_([^_\\n]+)_(?=$|[\\s，。！？.,!?)）])"] {
                result = result.replacingOccurrences(of: pattern, with: "$1$2", options: .regularExpression)
            }
            return result
        }.joined()
    }
    static func plainText(_ value: String) -> String {
        var previous: ReplyBlock.Kind?
        return parse(value).map { block in
            let prefix = previous == nil ? "" : previous == .list && block.kind == .list ? "\n" : "\n\n"
            previous = block.kind
            if block.kind == .table { return prefix + block.rows.map { $0.map(readableInline).joined(separator: "\t") }.joined(separator: "\n") }
            if block.kind == .code { return prefix + block.text }
            let marker = block.checked.map { $0 ? "☑" : "☐" } ?? block.marker
            return prefix + (block.kind == .list ? String(repeating: " ", count: block.indent) + marker + " " : "") + readableInline(block.text)
        }.joined()
    }
}
