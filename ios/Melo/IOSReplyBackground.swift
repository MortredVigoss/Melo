import UIKit
import BackgroundTasks

@MainActor final class IOSReplyBackground: ReplyBackgroundScheduling {
    private let prefix = (Bundle.main.bundleIdentifier ?? "com.melo.iphone.mfpiao") + ".reply."
    func beginShort(expiration: @escaping () -> Void) -> Int? {
        let id = UIApplication.shared.beginBackgroundTask(withName: "Melo reply") {
            MainActor.assumeIsolated { expiration() }
        }
        return id == .invalid ? nil : id.rawValue
    }
    func endShort(_ id: Int) { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id)) }
    func requestContinued(id: String, launch: @escaping (ReplyBackgroundLease) -> Void) -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        let identifier = prefix + id
        // Concrete identifiers match the plist prefix; continued processing may register after launch.
        guard BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main, launchHandler: { task in
            MainActor.assumeIsolated {
                guard let task = task as? BGContinuedProcessingTask else { task.setTaskCompleted(success: false); return }
                launch(IOSContinuedReplyLease(task))
            }
        }) else { return false }
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: "Melo", subtitle: InterfaceCopy.localized("回复中"))
        request.strategy = .queue // A late grant attaches only to its still-live attempt.
        do { try BGTaskScheduler.shared.submit(request); return true }
        catch { return false } // Same network request retains its short allowance.
    }
    func cancelPending(id: String) {
        if #available(iOS 26.0, *) { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: prefix + id) }
    }
}
@available(iOS 26.0, *)
@MainActor private final class IOSContinuedReplyLease: ReplyBackgroundLease {
    private let task: BGContinuedProcessingTask
    var expirationHandler: (() -> Void)?
    init(_ task: BGContinuedProcessingTask) {
        self.task = task; task.progress.totalUnitCount = 3
        task.expirationHandler = { [weak self] in Task { @MainActor in self?.expirationHandler?() } }
    }
    func update(completed: Int, total: Int, subtitle: String) {
        task.progress.totalUnitCount = Int64(total)
        task.progress.completedUnitCount = Int64(completed)
        let label = InterfaceCopy.localized(subtitle)
        if task.subtitle != label { task.updateTitle("Melo", subtitle: label) }
    }
    func finish(success: Bool) {
        task.expirationHandler = nil; task.setTaskCompleted(success: success)
    }
}
