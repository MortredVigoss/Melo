import Foundation

@MainActor final class FakeLease: ReplyBackgroundLease {
    var expirationHandler: (() -> Void)?
    var completions: [Bool] = []
    var progress: [Int] = []
    func update(completed: Int, subtitle: String) { progress.append(completed) }
    func finish(success: Bool) { completions.append(success) }
}
@MainActor final class FakeScheduler: ReplyBackgroundScheduling {
    var shortHandlers: [Int: () -> Void] = [:]
    var launches: [String: (ReplyBackgroundLease) -> Void] = [:]
    var ended: [Int] = []
    var cancelled: [String] = []
    var accepts = true
    var shortAvailable = true
    func beginShort(expiration: @escaping () -> Void) -> Int? {
        guard shortAvailable else { return nil }
        let id = shortHandlers.count + 1; shortHandlers[id] = expiration; return id
    }
    func endShort(_ id: Int) { ended.append(id) }
    func requestContinued(id: String, launch: @escaping (ReplyBackgroundLease) -> Void) -> Bool {
        launches[id] = launch; return accepts
    }
    func cancelPending(id: String) { cancelled.append(id) }
}

@main struct ReplyBackgroundTests {
    @MainActor static func main() {
        let scheduler = FakeScheduler()
        let lifetime = ReplyBackgroundLifetime(scheduler: scheduler)
        var cancelledNetworkRequests = 0
        var checkpointed = 0
        func expire() { checkpointed += 1; cancelledNetworkRequests += 1 }
        lifetime.begin(runID: "first", onExpiration: expire)
        assert(lifetime.protection == .limited)
        lifetime.update(runID: "first", completed: 1, subtitle: "收到响应")
        let first = FakeLease(); scheduler.launches["first"]!(first)
        assert(lifetime.protection == .continued && scheduler.ended == [1])
        assert(first.progress == [1], "Progress before scheduler callback must be retained")
        scheduler.shortHandlers[1]!()
        assert(cancelledNetworkRequests == 0, "Old short allowance cannot cancel continued processing")
        lifetime.update(runID: "first", completed: 2, subtitle: "收到完整回答")
        lifetime.update(runID: "first", completed: 0, subtitle: "迟到的事件")
        assert(first.progress.last == 2, "Progress cannot go backwards")
        lifetime.finish(runID: "first", success: true)
        lifetime.finish(runID: "first", success: true)
        assert(first.completions == [true] && first.progress.last == 3)
        assert(cancelledNetworkRequests == 0)

        lifetime.begin(runID: "second", onExpiration: expire)
        let second = FakeLease(); scheduler.launches["second"]!(second)
        let expiration = second.expirationHandler!
        expiration(); expiration()
        assert(checkpointed == 1 && cancelledNetworkRequests == 1)
        assert(second.completions == [false], "System/user cancellation is completed exactly once")
        lifetime.finish(runID: "second", success: false)
        assert(second.completions == [false])

        scheduler.accepts = false
        lifetime.begin(runID: "third", onExpiration: expire)
        assert(lifetime.protection == .limited)
        scheduler.shortHandlers[3]!()
        assert(checkpointed == 2 && cancelledNetworkRequests == 2 && scheduler.ended == [1,2,3])
        lifetime.begin(runID: "fourth", onExpiration: expire)
        let late = FakeLease(); scheduler.launches["third"]!(late)
        assert(late.completions == [false] && lifetime.runID == "fourth")
        scheduler.shortHandlers[3]!()
        assert(cancelledNetworkRequests == 2, "Expired prior run cannot cancel a new reply")
        lifetime.finish(runID: "fourth", success: false)
        assert(scheduler.ended == [1,2,3,4])

        scheduler.shortAvailable = false
        lifetime.begin(runID: "fifth", onExpiration: expire)
        assert(lifetime.protection == .unavailable)
        lifetime.enteredBackground()
        assert(cancelledNetworkRequests == 3 && lifetime.runID == nil)
        let veryLate = FakeLease(); scheduler.launches["fifth"]!(veryLate)
        assert(veryLate.completions == [false])
        assert(scheduler.cancelled == ["first","second","third","fourth","fifth"])
        print("Reply background tests passed: completion, expiration, cancellation, fallback, stale callbacks, phase progress")
    }
}
