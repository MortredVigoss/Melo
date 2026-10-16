import SwiftUI

/// Live steps of the reply running in this chat, shown inside the conversation.
struct RunProgressList: View {
    let steps: [RunStep]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Group {
                        switch step.state {
                        case .running: ProgressView().controlSize(.mini)
                        case .done: Image(systemName: "checkmark").foregroundStyle(meloGold)
                        case .failed: Image(systemName: "xmark").foregroundStyle(.red)
                        }
                    }.font(.caption2).frame(width: 14)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: step.title).font(.caption).foregroundStyle(step.state == .running ? .primary : .secondary)
                        if !step.detail.isEmpty { Text(verbatim: step.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
