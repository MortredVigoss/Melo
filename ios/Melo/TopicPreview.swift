#if DEBUG && targetEnvironment(simulator)
import Foundation

/// Simulator-only preview: A → B → C → back to A through the real send path with a fake
/// model, so the topic markers in the chat can be seen and the return can be tapped.
@MainActor enum TopicPreview {
    static func store() -> ChatStore {
        let store = ChatStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("topic-preview-" + UUID().uuidString), replyLoader: { messages, _ in
            let question = (messages.last?.content ?? "").components(separatedBy: "\n\n[本轮参考").first ?? ""
            return ModelReply(text: "（示例回答）" + question)
        })
        guard let chat = store.newChat() else { return store }
        store.selectedConversationID = chat
        Task { @MainActor in
            for question in ["帮我写一个 Python 爬虫，抓取豆瓣电影 Top250 的片名和评分", "爬虫遇到 403 怎么办", "明天北京天气怎么样", "推荐几本科幻小说", "那个爬虫怎么加代理"] {
                store.send(question, chatID: chat)
                for _ in 0..<200 where store.anySending { try? await Task.sleep(nanoseconds: 25_000_000) }
            }
        }
        return store
    }
}
#endif
