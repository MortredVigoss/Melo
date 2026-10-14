import Foundation

@main struct ConversationHistoryTests {
    static func main() {
        func message(_ id: Int, _ role: String) -> ChatMessage {
            ChatMessage(id: String(id), role: role, content: "message-\(id)")
        }
        func history(_ count: Int) -> [ChatMessage] {
            (0..<count).map { message($0, $0.isMultiple(of: 2) ? "user" : "assistant") }
        }
        for count in [0, 1, 2, 59, 60] {
            let input = history(count)
            assert(ConversationHistory.recentTurns(input) == input)
        }
        for count in [61, 62, 63, 1001] {
            let input = history(count)
            let selected = ConversationHistory.recentTurns(input)
            assert(selected.first?.role == "user" && selected.last == input.last)
            assert(selected.count <= 60)
            assert(selected == Array(input.suffix(selected.count)), "History must stay contiguous, without filling gaps with old messages")
        }
        let multiAnswer = [message(0, "user"), message(1, "assistant"), message(2, "assistant"), message(3, "user"), message(4, "assistant"), message(5, "user")]
        assert(ConversationHistory.recentTurns(multiAnswer, maxMessages: 5) == Array(multiAnswer.suffix(3)))
        let pending = [message(0, "user"), message(1, "user"), message(2, "user")]
        assert(ConversationHistory.recentTurns(pending, maxMessages: 2) == Array(pending.suffix(2)))
        let oversizedTurn = [message(0, "user")] + (1..<65).map { message($0, "assistant") }
        assert(ConversationHistory.recentTurns(oversizedTurn) == oversizedTurn, "Never silently cut the latest user turn")
        let newerQuestion = oversizedTurn + [message(65, "user")]
        assert(ConversationHistory.recentTurns(newerQuestion) == [newerQuestion.last!])
        assert(ConversationHistory.recentTurns([message(0, "assistant"), message(1, "user")]).count == 1)
        assert(ConversationHistory.recentTurns([message(0, "assistant")]).isEmpty)
        assert(ConversationHistory.recentTurns(history(5), maxMessages: 0).isEmpty)
        let longHistory = [message(0, "user"), ChatMessage(id: "long", role: "assistant", content: String(repeating: "长", count: 200001)), message(2, "user")]
        assert(ConversationHistory.recentTurns(longHistory) == [longHistory.last!], "An oversized older turn must not make all future requests exceed context capacity")
        assert(longHistory[1].content.count == 200001, "Stored history stays untouched")
        let multibyte = [ChatMessage(role: "user", content: String(repeating: "汉", count: 6000)), ChatMessage(role: "assistant", content: String(repeating: "👋", count: 6000)), message(2, "user")]
        assert(ConversationHistory.recentTurns(multibyte, reservedBytes: 8000) == [multibyte.last!])
        do { try ConversationHistory.validateCurrentInput(String(repeating: "汉", count: 20000)); fatalError("Oversized current input accepted") } catch {}
        do { try ConversationHistory.validateCurrentInput("hi", instructions: String(repeating: "x", count: 48000)); fatalError("Instruction budget ignored") } catch {}
        print("Conversation history tests passed: whole turns, contiguous suffix, current input, multi-answer turns and soft limit")
    }
}
