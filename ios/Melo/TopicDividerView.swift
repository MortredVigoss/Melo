import SwiftUI

/// A thin marker where the conversation moves to another topic; a return jumps to its start.
struct TopicDividerView: View {
    let divider: TopicDivider
    let jump: (String) -> Void
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(.white.opacity(0.08)).frame(height: 0.5)
            if let target = divider.returnsTo {
                Button { jump(target) } label: { Text("回到话题：\(divider.label)").lineLimit(1) }
                    .accessibilityHint(Text("跳到这个话题开始处"))
            } else {
                Text("话题：\(divider.label)").lineLimit(1)
            }
            Rectangle().fill(.white.opacity(0.08)).frame(height: 0.5)
        }
        .font(.caption2).foregroundStyle(.secondary).padding(.top, 6)
        .accessibilityIdentifier("chat.topicDivider")
    }
}
