import Foundation

@MainActor protocol ReplyBackgroundLease: AnyObject {
    var expirationHandler: (() -> Void)? { get set }
    func update(completed: Int, subtitle: String)
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
    private var completed = 0
    private var subtitle = "等待模型响应"
    var onProtectionChange: ((Protection) -> Void)?
    var protection: Protection { lease != nil ? .continued : shortID != nil ? .limited : .unavailable }

    init(scheduler: ReplyBackgroundScheduling) { self.scheduler = scheduler }
    func begin(runID: String, onExpiration: @escaping () -> Void) {
        precondition(self.runID == nil, "A reply already owns background execution")
        self.runID = runID; self.onExpiration = onExpiration
        completed = 0; subtitle = "等待模型响应"
        shortID = scheduler.beginShort { [weak self] in
            guard let self, self.lease == nil else { return }
            self.expire(runID: runID)
        }
        onProtectionChange?(protection)
        _ = scheduler.requestContinued(id: runID) { [weak self] lease in
            guard let self, self.runID == runID else { lease.finish(success: false); return }
            self.lease = lease
            lease.expirationHandler = { [weak self] in self?.expire(runID: runID) }
            lease.update(completed: self.completed, subtitle: self.subtitle)
            self.endShort()
            self.onProtectionChange?(self.protection)
        }
    }
    func enteredBackground() {
        if let runID, protection == .unavailable { expire(runID: runID) }
    }
    /// Three actual milestones: received data, complete reply, saved reply.
    func update(runID: String, completed: Int, subtitle: String) {
        guard self.runID == runID else { return }
        self.completed = max(self.completed, min(2, completed)); self.subtitle = subtitle
        lease?.update(completed: self.completed, subtitle: subtitle)
    }
    func finish(runID: String, success: Bool) {
        guard self.runID == runID else { return }
        self.runID = nil; onExpiration = nil
        lease?.expirationHandler = nil
        if success { lease?.update(completed: 3, subtitle: "回答已保存") }
        lease?.finish(success: success); lease = nil
        scheduler.cancelPending(id: runID)
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
    private func endShort() {
        if let id = shortID { shortID = nil; scheduler.endShort(id) }
    }
}
