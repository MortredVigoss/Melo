import Foundation

@MainActor protocol ReplyBackgroundLease: AnyObject {
    var expirationHandler: (() -> Void)? { get set }
    func update(completed: Int, total: Int, subtitle: String)
    func finish(success: Bool)
}
@MainActor protocol ReplyBackgroundScheduling: AnyObject {
    func beginShort(expiration: @escaping () -> Void) -> Int?
    func endShort(_ id: Int)
    func requestContinued(id: String, launch: @escaping (ReplyBackgroundLease) -> Void) -> Bool
    func cancelPending(id: String)
}

/// Owns the allowance for one already-started reply, never the network request.
/// Scheduler callbacks cannot cause a duplicate send or affect a later run.
@MainActor final class ReplyBackgroundLifetime {
    enum Protection { case unavailable, limited, continued }
    private let scheduler: ReplyBackgroundScheduling
    private(set) var runID: String?
    private var shortID: Int?
    private var lease: ReplyBackgroundLease?
    private var onExpiration: (() -> Void)?
    private var requestID: String?
    private var shortToken: UUID?
    private var leaving = false
    private(set) var automaticRecovery = true
    private var finishedSteps = 0
    private var completed = 0
    private var subtitle = "回复中"
    var onProtectionChange: ((Protection) -> Void)?
    var protection: Protection { lease != nil ? .continued : shortID != nil ? .limited : .unavailable }

    init(scheduler: ReplyBackgroundScheduling) { self.scheduler = scheduler }
    func begin(runID: String, onExpiration: @escaping () -> Void) {
        precondition(self.runID == nil, "A reply already owns background execution")
        self.runID = runID; self.onExpiration = onExpiration
        finishedSteps = 0; completed = 0; subtitle = "回复中"
        requestID = nil; leaving = false; automaticRecovery = true
        acquireShort(for: runID)
        onProtectionChange?(protection)
    }
    private func acquireShort(for runID: String) {
        guard shortID == nil, lease == nil else { return }
        let token = UUID(); shortToken = token
        shortID = scheduler.beginShort { [weak self] in
            guard let self, self.runID == runID, self.shortToken == token, self.lease == nil else { return }
            if self.leaving { self.expire(runID: runID) }
            else { self.endShort(); self.onProtectionChange?(self.protection) }
        }
    }
    func leavingForeground() {
        guard let runID else { return }
        leaving = true
        acquireShort(for: runID)
        guard requestID == nil else { return }
        let ticket = UUID().uuidString
        requestID = ticket
        _ = scheduler.requestContinued(id: ticket) { [weak self] lease in
            guard let self, self.runID == runID, self.requestID == ticket else { lease.finish(success: false); return }
            self.lease = lease
            lease.expirationHandler = { [weak self] in guard let self, self.runID == runID, self.requestID == ticket else { return }
                // iOS also uses expiration for the person cancelling the Live Activity.
                self.automaticRecovery = false
                self.expire(runID: runID)
            }
            lease.update(completed: self.completed + self.finishedSteps, total: 3 + self.finishedSteps, subtitle: self.subtitle)
            self.endShort()
            self.onProtectionChange?(self.protection)
        }
    }
    func becameActive() {
        leaving = false
        guard let runID, requestID != nil else { return }
        releaseContinued(success: true)
        acquireShort(for: runID)
        onProtectionChange?(protection)
    }
    func enteredBackground() {
        leaving = true
        if let runID, protection == .unavailable { expire(runID: runID) }
    }
    /// Three actual milestones: received data, complete reply, saved reply.
    func update(runID: String, completed: Int, subtitle: String) {
        guard self.runID == runID else { return }
        let next = max(self.completed, min(2, completed))
        guard next != self.completed || self.subtitle != subtitle else { return }
        self.completed = next; self.subtitle = subtitle
        lease?.update(completed: self.completed + finishedSteps, total: 3 + finishedSteps, subtitle: subtitle)
    }
    func finishedStep(runID: String) {
        guard self.runID == runID else { return }
        finishedSteps += 1
        lease?.update(completed: completed + finishedSteps, total: 3 + finishedSteps, subtitle: subtitle)
    }
    func finish(runID: String, success: Bool) {
        guard self.runID == runID else { return }
        self.runID = nil; onExpiration = nil
        if success { lease?.update(completed: 3 + finishedSteps, total: 3 + finishedSteps, subtitle: "回答已保存") }
        releaseContinued(success: success)
        endShort()
        onProtectionChange?(protection)
    }
    private func expire(runID: String) {
        guard self.runID == runID else { return }
        // Synchronously checkpoint/cancel before returning the allowance.
        let callback = onExpiration; onExpiration = nil
        callback?()
        finish(runID: runID, success: false)
    }
    private func releaseContinued(success: Bool) {
        let ticket = requestID; requestID = nil
        lease?.expirationHandler = nil
        lease?.finish(success: success); lease = nil
        if let ticket { scheduler.cancelPending(id: ticket) }
    }
    private func endShort() {
        shortToken = nil
        if let id = shortID { shortID = nil; scheduler.endShort(id) }
    }
}
