import SwiftUI

struct ReplyContentView: View {
    let content: String
    private func inline(_ value: String) -> Text {
        Text((try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            ForEach(Array(ReplyDocument.parse(content).enumerated()), id: \.offset) { _, block in
                switch block.kind {
                case .code:
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text(block.language.isEmpty ? "代码" : block.language).font(.caption2); Spacer(); Button { UIPasteboard.general.string = block.text } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("复制代码") }
                        ScrollView(.horizontal) { Text(verbatim: block.text).font(.system(.caption, design: .monospaced)).fixedSize(horizontal: true, vertical: false).textSelection(.enabled) }
                    }.padding(12).background(MeloTheme.inset, in: RoundedRectangle(cornerRadius: 12))
                case .table:
                    // Row cards remain readable without squeezing columns or showing pipe syntax.
                    let headings = block.rows.first ?? []
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(Array(block.rows.dropFirst().enumerated()), id: \.offset) { _, row in
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(0..<max(headings.count, row.count), id: \.self) { column in
                                    VStack(alignment: .leading, spacing: 3) {
                                        if column < headings.count { inline(headings[column]).font(.caption).foregroundStyle(meloGold) }
                                        inline(column < row.count ? row[column] : "—").font(.body)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }.padding(12).background(MeloTheme.inset, in: RoundedRectangle(cornerRadius: 12))
                        }
                        if block.rows.count == 1 { inline(headings.joined(separator: " · ")) }
                    }
                case .heading: inline(block.text).font(.headline).padding(.top, 3)
                case .list: HStack(alignment: .top, spacing: 9) { Text(block.checked.map { $0 ? "☑" : "☐" } ?? block.marker).foregroundStyle(meloGold); inline(block.text).frame(maxWidth: .infinity, alignment: .leading) }.padding(.leading, CGFloat(min(block.indent, 24)) * 5)
                case .quote: inline(block.text).foregroundStyle(.secondary).padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(meloGold.opacity(0.4)).frame(width: 2) }
                case .paragraph: inline(block.text).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }.font(.body).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
}
