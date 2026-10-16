import Foundation

@main struct ImagePhotoSaveTests {
    @MainActor static func main() async throws {
        let suite = "MeloPhotoSaveTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ImagePhotoSaveStore(defaults: defaults)
        var writes = 0
        var release: CheckedContinuation<Void, Never>?
        let first = Task { @MainActor in
            try await store.save(id: "result") {
                writes += 1
                await withCheckedContinuation { release = $0 }
            }
        }
        while release == nil { await Task.yield() }
        assert(store.savingIDs == ["result"] && store.savedIDs.isEmpty)
        // Simulate four rapid taps across different views; the writer must run once.
        for _ in 0..<4 {
            let outcome = try await store.save(id: "result", confirmedRepeat: true) { writes += 1 }
            assert(outcome == .alreadySaving && writes == 1)
        }
        release?.resume()
        let firstOutcome = try await first.value
        assert(firstOutcome == .saved && writes == 1 && store.savingIDs.isEmpty)
        assert(store.savedIDs.contains("result"))
        for _ in 0..<3 {
            let outcome = try await store.save(id: "result") { writes += 1 }
            assert(outcome == .needsConfirmation && writes == 1)
        }
        // Cancel simply never calls the confirmed path. Reopening/restarting keeps the receipt.
        let reopened = ImagePhotoSaveStore(defaults: defaults)
        let reopenedOutcome = try await reopened.save(id: "result") { writes += 1 }
        assert(reopenedOutcome == .needsConfirmation && writes == 1)
        let repeated = try await reopened.save(id: "result", confirmedRepeat: true) { writes += 1 }
        assert(repeated == .saved && writes == 2)
        // A failed first save is retryable; a failed repeat must retain the previous success.
        for id in ["denied", "result"] {
            do {
                _ = try await reopened.save(id: id, confirmedRepeat: true) { throw URLError(.noPermissionsToReadFile) }
                fatalError("Expected failure")
            } catch { assert(reopened.savingIDs.isEmpty) }
        }
        assert(!reopened.savedIDs.contains("denied") && reopened.savedIDs.contains("result"))
        let retry = try await reopened.save(id: "denied") { writes += 1 }
        assert(retry == .saved && writes == 3)
        let edited = try await reopened.save(id: "edited-result") { writes += 1 }
        assert(edited == .saved && writes == 4)
        // Cancellation before Photos starts must not write anything or mark success.
        let cancelled = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await reopened.save(id: "cancelled") { writes += 1 }
        }
        do { _ = try await cancelled.value; fatalError("Expected cancellation") }
        catch is CancellationError {}
        assert(writes == 4 && !reopened.savedIDs.contains("cancelled") && reopened.savingIDs.isEmpty)
        assert(ImagePhotoSaveStore(defaults: defaults).savedIDs == ["result", "denied", "edited-result"])
        print("Photo save passed: concurrent taps write once, repeat requires confirmation, receipts survive reopen, failure/cancellation retry, edited images independent")
    }
}
