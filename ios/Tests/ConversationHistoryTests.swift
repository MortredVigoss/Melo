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
        do { try ConversationHistory.validateCurrentInput(String(repeating: "汉", count: 20000), budget: PhoneContextBudget(capacity: 24000)); fatalError("Oversized current input accepted") } catch {}
        do { try ConversationHistory.validateCurrentInput("hi", instructions: String(repeating: "x", count: 48000), budget: PhoneContextBudget(capacity: 16000)); fatalError("Instruction budget ignored") } catch {}
        // Date context (2026-10-18): a late-night "今天" is dated when the next
        // message arrives after midnight; same-day conversations get no note.
        let sydney = TimeZone(identifier: "Australia/Sydney")!
        let iso = ISO8601DateFormatter()
        let beforeMidnight = iso.date(from: "2026-10-17T12:40:00Z")!   // 23:40 Sydney, Oct 17
        let afterMidnight = iso.date(from: "2026-10-17T13:20:00Z")!    // 00:20 Sydney, Oct 18
        assert(ConversationHistory.localDate(afterMidnight, timeZone: sydney) == "2026-10-18", "local day, not UTC day")
        let dated = [
            ChatMessage(id: "q1", role: "user", content: "今天怎么样", createdAt: iso.string(from: beforeMidnight)),
            ChatMessage(id: "a1", role: "assistant", content: "今天挺好的", createdAt: iso.string(from: beforeMidnight.addingTimeInterval(10))),
            ChatMessage(id: "q2", role: "user", content: "帮我查个别的", createdAt: iso.string(from: afterMidnight)),
        ]
        let note = ConversationHistory.dateChangeNote(dated, now: afterMidnight, timeZone: sydney)
        assert(note.contains("2026-10-17（昨天）") && note.contains("今天是 2026-10-18"), note)
        assert(ConversationHistory.dateChangeNote(dated, now: beforeMidnight.addingTimeInterval(60), timeZone: sydney).isEmpty, "same local day → no note")
        assert(ConversationHistory.dateChangeNote([dated[0]], now: afterMidnight, timeZone: sydney).isEmpty, "first message → no note")
        assert(ConversationHistory.dateInstructions(now: afterMidnight, timeZone: sydney).contains("当前本地日期：2026-10-18（Australia/Sydney）"))
        assert(ConversationHistory.parseTimestamp(timestamp()) != nil, "fractional-second timestamps parse")
        // Audit I14/I20: a compact with neither summary nor cards keeps the full history; a boundary at the
        // pending question (nothing after it) is treated like an unknown boundary.
        let turns = history(6)
        let bare: SyncValue = .object(["boundaryMessageId": .string("3"), "compactedCount": .number(4), "source": .string("cloud"), "at": .string("2026-10-18T00:00:00Z"), "summary": .string("")])
        let bareContext = ConversationHistory.compactContext(bare, messages: turns)
        assert(bareContext.messages == turns && bareContext.summary.isEmpty, "empty summary and cards → full history")
        let summarised: SyncValue = .object(["boundaryMessageId": .string("3"), "compactedCount": .number(4), "source": .string("cloud"), "at": .string("2026-10-18T00:00:00Z"), "summary": .string("早先的讨论")])
        let cut = ConversationHistory.compactContext(summarised, messages: turns)
        assert(cut.messages.map(\.id) == ["4", "5"] && cut.summary.contains("早先的讨论"))
        let atQuestion: SyncValue = .object(["boundaryMessageId": .string("4"), "compactedCount": .number(5), "source": .string("cloud"), "at": .string("2026-10-18T00:00:00Z"), "summary": .string("早先的讨论")])
        let pendingContext = ConversationHistory.compactContext(atQuestion, messages: Array(turns.prefix(5)))
        assert(pendingContext.messages == Array(turns.prefix(5)) && pendingContext.summary.isEmpty, "boundary == pending question → send the full history")
        let cardsOnly: SyncValue = .object(["boundaryMessageId": .string("1"), "compactedCount": .number(2), "source": .string("cloud"), "at": .string("2026-10-18T00:00:00Z"), "summary": .string(""), "cards": .array([.object(["id": .string("c1"), "title": .string("T"), "summary": .string("卡片摘要"), "source": .string("cloud")])])])
        let cardContext = ConversationHistory.compactContext(cardsOnly, messages: turns)
        assert(cardContext.messages.map(\.id) == ["2", "3", "4", "5"] && cardContext.summary.contains("卡片摘要"))
        print("Conversation history tests passed: whole turns, contiguous suffix, current input, multi-answer turns, soft limit and date context")
    }
}
